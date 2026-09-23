// <reference types="vite/client" />

import type { Plugin, ResolvedConfig } from 'vite'
import type { RouteManifestEntry } from 'bini-router'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { pathToFileURL } from 'url'
import { parse } from 'node-html-parser'
import { minify as minifyHtmlTerser } from 'html-minifier-terser'

// ─── Colors ──────────────────────────────────────────────────────────────────

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
} as const

const log = {
  info: (msg: string) => console.log(`${colors.blue}${colors.bold}INFO${colors.reset} ${msg}`),
  success: (msg: string) => console.log(`${colors.green}${colors.bold}SUCCESS${colors.reset} ${msg}`),
  step: (msg: string) => console.log(`${colors.cyan}${colors.bold}STEP${colors.reset} ${msg}`),
  detail: (msg: string) => console.log(`  ${colors.dim}${msg}${colors.reset}`),
  ok: (msg: string) => console.log(`  ${colors.green}OK${colors.reset} ${msg}`),
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SSGOptions {
  appDir?: string
  outputDir?: string
  fallback?: boolean
  verbose?: boolean
  includeRoot?: boolean
  quiet?: boolean
  failOnError?: boolean
  concurrency?: number
  /** Maximum link-following depth for auto-crawl. Default: 3 */
  crawlDepth?: number
  /** Minify the pre-rendered HTML with html-minifier-terser. Default: true */
  minify?: boolean
}

interface RouteTree {
  static: string[]
  dynamic: string[]
  metadata?: Record<string, any>
}

interface MainModule {
  render: (url: string) => Promise<string> | string
}

/**
 * Structured head content, emitted by bini-router. bini-ssg is the only
 * package that turns this into HTML — the router never produces HTML.
 */
export type HeadNode =
  | { t: 'element'; tag: string; attrs: Record<string, string>; children: HeadNode[] }
  | { t: 'text'; value: string }
  | { t: 'raw'; value: string }

// ─── Module-level state ─────────────────────────────────────────────────────

let tsxRegistered = false
let assetStubLoaderPath: string | null = null
let assetStubLoaderRegistered = false
let loaderHooksRegistered = false

// Captured CSS map from generateBundle: source module path → hashed CSS URLs
let capturedCss: Map<string, string[]> | null = null

// ─── Utilities ──────────────────────────────────────────────────────────────

function getMaxRouteLength(routes: string[]): number {
  let max = 10
  for (const route of routes) {
    if (route.length > max) max = route.length
  }
  return max
}

function deduplicateRoutes(routes: string[]): string[] {
  return [...new Set(routes)]
}

/**
 * Normalize a path for cross-platform comparison: forward slashes, lowercase.
 *
 * This exists because bini-router reads paths from the filesystem (Windows
 * produces backslashes: `C:\...\blog.css`) while Vite keys its module graph
 * and chunk metadata by forward-slash-normalized IDs (`C:/.../blog.css`).
 * Without normalization, `resolveHashedCss` silently fails on Windows and
 * pre-rendered pages ship without their route-scoped CSS.
 */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

// ─── HTML minification via html-minifier-terser ─────────────────────────────

/**
 * Minifies a fully-rendered HTML document using html-minifier-terser.
 *
 * Configuration is tuned for React SSG hydration safety:
 *   - `conservativeCollapse: true` always collapses to a single space,
 *     never removing whitespace entirely. This is what prevents React
 *     hydration mismatches from stripped text nodes.
 *   - `collapseWhitespace: true` enables the collapse pass; it must be
 *     paired with conservativeCollapse to be hydration-safe.
 *   - `removeComments: false` keeps React's `<!--$-->` boundary markers.
 *   - `sortAttributes: false` and `sortClassName: false` prevent React
 *     from seeing reordered props/classes during hydration.
 *
 * On failure, returns the original HTML rather than throwing — a malformed
 * page should never fail the whole build. A warning is logged once per
 * build so a systematically-broken minifier surfaces in the build log.
 */
let minifyWarned = false

async function minifyHtml(html: string): Promise<string> {
  try {
    return await minifyHtmlTerser(html, {
      collapseWhitespace: true,
      conservativeCollapse: true,
      removeComments: false,
      sortAttributes: false,
      sortClassName: false,
      removeRedundantAttributes: true,
      removeEmptyAttributes: true,
      useShortDoctype: true,
      minifyCSS: true,
      minifyJS: true,
    })
  } catch (error) {
    if (!minifyWarned) {
      minifyWarned = true
      console.warn(
        `[bini-ssg] HTML minification failed; falling back to unminified output. ` +
        `This warning is shown once per build. Error: ` +
        (error instanceof Error ? error.message : String(error)),
      )
    }
    return html
  }
}

// ─── HTML manipulation via node-html-parser ─────────────────────────────────

function safeRootDivReplacement(template: string, content: string): string {
  const root = parse(template, {
    comment: true,
    voidTag: { closingSlash: true },
  })

  const rootEl = root.querySelector('#root')

  if (rootEl) {
    rootEl.innerHTML = content
    return root.toString()
  }

  const body = root.querySelector('body')
  if (body) {
    body.insertAdjacentHTML('afterbegin', `<div id="root">${content}</div>`)
    return root.toString()
  }

  return `<div id="root">${content}</div>${root.toString()}`
}

// ─── Head tree → HTML (the single place HTML is generated) ──────────────────

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Serializes a HeadNode[] tree from bini-router into HTML. All escaping
 * for author-written head content happens here, exactly once. The router
 * never escapes, never produces HTML — this is the contract.
 *
 * `{ t: 'raw' }` is the explicit opt-in escape hatch for authors who
 * genuinely need to inject raw markup (e.g. JSON-LD). It is intentionally
 * visible and greppable in the manifest.
 */
export function headTreeToHtml(nodes: HeadNode[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.t === 'text') {
      out += escapeText(n.value)
    } else if (n.t === 'raw') {
      out += n.value
    } else {
      const attrs = Object.entries(n.attrs)
        .map(([k, v]) => (v === '' ? k : `${k}="${escapeAttr(v)}"`))
        .join(' ')
      const open = attrs ? `<${n.tag} ${attrs}>` : `<${n.tag}>`
      if (VOID_ELEMENTS.has(n.tag.toLowerCase())) {
        out += open
      } else {
        out += `${open}${headTreeToHtml(n.children)}</${n.tag}>`
      }
    }
  }
  return out
}

// ─── Metadata + CSS injection ───────────────────────────────────────────────

/**
 * Given rendered HTML and a merged metadata entry (from bini-router),
 * replaces/injects <title> and a curated set of <meta>/<link> tags, and
 * appends any structured `document.head` content. Never touches anything
 * else in <head>.
 */
function applyMetadataToHtml(
  html: string,
  meta: RouteManifestEntry | null,
): string {
  if (!meta) return html

  const root = parse(html, { comment: true })
  const head = root.querySelector('head')
  if (!head) return html

  const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined

  const m = meta.meta as Record<string, unknown>

  // Title — prefer top-level, fall back to nested
  const title = str(meta.title) ?? str(m.title)
  if (title) {
    const existing = head.querySelector('title')
    if (existing) existing.textContent = title
    else head.insertAdjacentHTML('afterbegin', `<title>${escapeText(title)}</title>`)
  }

  const ensureMeta = (name: string, content: string, property = false) => {
    const attr = property ? 'property' : 'name'
    const existing = head.querySelector(`meta[${attr}="${name}"]`)
    if (existing) existing.setAttribute('content', content)
    else head.insertAdjacentHTML('beforeend', `<meta ${attr}="${name}" content="${escapeAttr(content)}" />`)
  }

  const ensureLink = (rel: string, href: string, extra: Record<string, string> = {}) => {
    const existing = head.querySelector(`link[rel="${rel}"]`)
    const attrs = [
      `rel="${escapeAttr(rel)}"`,
      `href="${escapeAttr(href)}"`,
      ...Object.entries(extra).map(([k, v]) => `${k}="${escapeAttr(v)}"`),
    ].join(' ')
    if (existing) existing.setAttribute('href', href)
    else head.insertAdjacentHTML('beforeend', `<link ${attrs} />`)
  }

  if (str(m.description)) ensureMeta('description', str(m.description)!)
  if (str(m.themeColor)) ensureMeta('theme-color', str(m.themeColor)!)
  if (str(m.robots)) ensureMeta('robots', str(m.robots)!)
  if (str(m.author)) ensureMeta('author', str(m.author)!)

  const keywords = m.keywords
  if (typeof keywords === 'string') ensureMeta('keywords', keywords)
  else if (Array.isArray(keywords)) {
    const joined = keywords.filter((k): k is string => typeof k === 'string').join(', ')
    if (joined) ensureMeta('keywords', joined)
  }

  if (str(m.canonical)) ensureLink('canonical', str(m.canonical)!)
  if (str(m.manifest)) ensureLink('manifest', str(m.manifest)!)

  // Icons
  const icons = m.icons as Record<string, Array<{ url: string; type?: string; sizes?: string }>> | undefined
  if (icons) {
    for (const entry of icons.icon ?? []) {
      const extra: Record<string, string> = {}
      if (entry.type) extra.type = entry.type
      if (entry.sizes) extra.sizes = entry.sizes
      ensureLink('icon', entry.url, extra)
    }
    for (const entry of icons.shortcut ?? []) {
      ensureLink('shortcut icon', entry.url)
    }
    for (const entry of icons.apple ?? []) {
      const extra: Record<string, string> = {}
      if (entry.type) extra.type = entry.type
      if (entry.sizes) extra.sizes = entry.sizes
      ensureLink('apple-touch-icon', entry.url, extra)
    }
  }

  // OpenGraph
  const og = m.openGraph as Record<string, unknown> | undefined
  if (og) {
    if (str(og.title)) {
      ensureMeta('og:title', str(og.title)!, true)
      ensureMeta('og:type', str(og.type) ?? 'website', true)
      if (str(og.description)) ensureMeta('og:description', str(og.description)!, true)
      if (str(og.url)) ensureMeta('og:url', str(og.url)!, true)
      if (str(og.image)) ensureMeta('og:image', str(og.image)!, true)
    }
  }

  // Twitter
  const tw = m.twitter as Record<string, unknown> | undefined
  if (tw) {
    if (str(tw.title)) {
      ensureMeta('twitter:card', str(tw.card) ?? 'summary_large_image')
      ensureMeta('twitter:title', str(tw.title)!)
      if (str(tw.description)) ensureMeta('twitter:description', str(tw.description)!)
      if (str(tw.creator)) ensureMeta('twitter:creator', str(tw.creator)!)
      if (str(tw.image)) ensureMeta('twitter:image', str(tw.image)!)
    }
  }

  // ── Structured document.head from bini-router ────────────────────────────
  // This is the ONLY place document.head content becomes HTML.
  const headNodes = meta.document?.head
  if (Array.isArray(headNodes) && headNodes.length > 0) {
    const headHtml = headTreeToHtml(headNodes)
    if (headHtml) {
      head.insertAdjacentHTML('beforeend', headHtml)
    }
  }

  // ── document.html / document.body attribute maps ─────────────────────────
  const doc = meta.document
  if (doc) {
    const htmlEl = root.querySelector('html')
    if (htmlEl && doc.html) {
      for (const [k, v] of Object.entries(doc.html)) {
        if (typeof v === 'string') htmlEl.setAttribute(k, v)
      }
    }
    const bodyEl = root.querySelector('body')
    if (bodyEl && doc.body) {
      for (const [k, v] of Object.entries(doc.body)) {
        if (typeof v === 'string') bodyEl.setAttribute(k, v)
      }
    }
  }

  return root.toString()
}

/**
 * Resolves a source CSS path to its hashed output URLs using the map
 * captured from Vite's generateBundle hook.
 *
 * Both sides of the comparison are normalized (forward slashes, lowercase)
 * so Windows manifests and Vite's POSIX-style module IDs match.
 */
function resolveHashedCss(sourcePath: string): string[] {
  if (!capturedCss) return []

  const results: string[] = []
  const target = normPath(path.resolve(sourcePath))

  // Direct: exact normalized path match
  for (const [key, urls] of capturedCss) {
    if (normPath(key) === target) {
      results.push(...urls)
    }
  }

  if (results.length > 0) return [...new Set(results)]

  // Fallback: basename match (normalized, so Windows/Linux agree)
  const base = normPath(path.basename(sourcePath, path.extname(sourcePath)))
  for (const [key, urls] of capturedCss) {
    const keyBase = normPath(path.basename(key, path.extname(key)))
    if (keyBase === base) {
      results.push(...urls)
    }
  }

  return [...new Set(results)]
}

/**
 * Injects <link rel="stylesheet"> tags for the given source CSS paths,
 * resolved to their hashed output URLs. Deduplicates so shared CSS is
 * only injected once per page.
 */
function injectCssLinks(html: string, sourceCssPaths: string[]): string {
  if (!capturedCss || sourceCssPaths.length === 0) return html

  const hashedUrls = new Set<string>()
  for (const src of sourceCssPaths) {
    for (const url of resolveHashedCss(src)) {
      hashedUrls.add(url)
    }
  }
  if (hashedUrls.size === 0) return html

  const root = parse(html, { comment: true })
  const head = root.querySelector('head')
  if (!head) return html

  // Remove any existing stylesheet links pointing at the same URLs.
  for (const link of head.querySelectorAll('link[rel="stylesheet"]')) {
    const href = link.getAttribute('href') ?? ''
    const normalized = href.replace(/^\/+/, '')
    if ([...hashedUrls].some((u) => u === normalized || href.endsWith(u))) {
      link.remove()
    }
  }

  for (const url of hashedUrls) {
    const href = '/' + url.replace(/^\/+/, '')
    head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${escapeAttr(href)}" />`)
  }

  return root.toString()
}

// ─── Link extraction (parser-based, not regex) ──────────────────────────────

/**
 * Collapse `/a/../b` and `//` runs in a path without pulling in URL
 * utilities. Input is expected to already be absolute (start with `/`).
 */
function resolvePathSegments(p: string): string {
  const parts = p.split('/')
  const out: string[] = []

  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }

  return '/' + out.join('/')
}

/**
 * Extract internal navigation links from rendered HTML.
 *
 * Uses node-html-parser instead of a regex, so it correctly handles:
 *   - HTML entities in href values (`&amp;` → `&`)
 *   - single-quoted, double-quoted, and unquoted attributes
 *   - attribute values containing `>` or `<`
 *   - <a> inside <script> or comments (ignored)
 *   - <base href> resolution
 *
 * External links, mailto:, tel:, javascript:, hash-only, and asset URLs
 * are excluded. Returns normalized absolute paths (no trailing slash,
 * no query, no hash) — one entry per unique destination.
 */
function extractInternalLinks(html: string): string[] {
  let root: ReturnType<typeof parse>
  try {
    root = parse(html, { comment: true })
  } catch {
    return []
  }

  // <base href> affects relative URL resolution. If present, respect it.
  const baseHref = root.querySelector('base')?.getAttribute('href') ?? '/'

  const links: string[] = []
  const seen = new Set<string>()

  for (const a of root.querySelectorAll('a[href]')) {
    // node-html-parser's getAttribute decodes HTML entities.
    const raw = a.getAttribute('href')
    if (!raw) continue

    const href = raw.trim()
    if (!href) continue
    if (href.startsWith('#')) continue
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue

    // Absolute URLs (scheme://host/...) and protocol-relative (//host/...)
    // are treated as external. The crawler has no current-host context.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) continue
    if (href.startsWith('//')) continue

    // Resolve relative to <base href>, then strip query and hash.
    let resolved = href
    if (!resolved.startsWith('/')) {
      const base = baseHref.endsWith('/') ? baseHref : baseHref + '/'
      resolved = base + resolved
    }

    resolved = resolvePathSegments(resolved.split('#')[0].split('?')[0])

    if (!resolved.startsWith('/')) continue

    // Skip asset-like URLs on the decoded, resolved path.
    if (
      resolved.startsWith('/assets/') ||
      resolved.startsWith('/_next/') ||
      resolved.startsWith('/static/') ||
      /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|woff2?|ttf|eot|mp4|webm|mp3|wav|pdf|xml|txt|json)$/i.test(resolved)
    ) {
      continue
    }

    // Normalize trailing slash (except root).
    if (resolved.length > 1 && resolved.endsWith('/')) {
      resolved = resolved.slice(0, -1)
    }

    if (!seen.has(resolved)) {
      seen.add(resolved)
      links.push(resolved)
    }
  }

  return links
}

function routeMatchesPattern(route: string, pattern: string): boolean {
  const routeParts = route.split('/').filter(Boolean)
  const patternParts = pattern.split('/').filter(Boolean)

  const lastPattern = patternParts[patternParts.length - 1]
  if (lastPattern === '*' || lastPattern.startsWith('[...')) {
    if (routeParts.length < patternParts.length - 1) return false
  } else if (patternParts.length !== routeParts.length) {
    return false
  }

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]
    if (p.startsWith(':') || p.startsWith('[') || p === '*') continue
    if (p !== routeParts[i]) return false
  }
  return true
}

// ─── Shell HTML ─────────────────────────────────────────────────────────────

const SHELL_MARKER_SCRIPT = '<script>window.__BINI_SHELL__=true;</script>'

function injectShellMarker(template: string): string {
  if (template.includes('__BINI_SHELL__')) return template
  if (/<\/head>/i.test(template)) {
    return template.replace(/<\/head>/i, `  ${SHELL_MARKER_SCRIPT}\n</head>`)
  }
  const bodyRegex = /<body[^>]*>/
  if (bodyRegex.test(template)) {
    return template.replace(bodyRegex, (match) => `${match}\n  ${SHELL_MARKER_SCRIPT}`)
  }
  return `${SHELL_MARKER_SCRIPT}\n${template}`
}

function renderShellHtml(template: string): string {
  const html = injectShellMarker(template)

  const root = parse(html, { comment: true })
  const rootEl = root.querySelector('#root')
  if (rootEl) {
    return root.toString()
  }

  const body = root.querySelector('body')
  if (body) {
    body.insertAdjacentHTML('afterbegin', `<div id="root"><!-- Shell content --></div>`)
    return root.toString()
  }

  return `<div id="root"><!-- Shell content --></div>${root.toString()}`
}

// ─── Route manifest from bini-router ───────────────────────────────────────

async function getBiniRouterAPI() {
  const biniRouter = await import('bini-router')
  return {
    generateRouteManifest: biniRouter.generateRouteManifest,
    getMetadataForRoute: biniRouter.getMetadataForRoute,
    getCssForRoute: biniRouter.getCssForRoute,
  }
}

function patternToShellRoute(pattern: string): string {
  return pattern
    .replace(/\/:([^/]+)/g, (match, param) => {
      return `/[${param}]`
    })
    .replace(/\/\*/g, '/[...slug]')
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export function biniSSG(options: SSGOptions = {}): Plugin {
  let config: ResolvedConfig
  let routeTree: RouteTree = { static: [], dynamic: [] }
  const appDir = options.appDir || 'src/app'
  const quiet = options.quiet === true
  const verbose = options.verbose !== false
  const failOnError = options.failOnError !== false
  const concurrency = options.concurrency ?? 1
  const includeRoot = options.includeRoot !== false
  const crawlDepth = options.crawlDepth ?? 3
  const minify = options.minify !== false
  const startTime = Date.now()

  let mainModule: MainModule | null = null
  let htmlTemplate: string | null = null
  let hasFatalError = false
  let outDir: string = 'dist'

  let routerApi: {
    generateRouteManifest: (appDir: string, apiDir?: string) => any
    getMetadataForRoute: (manifest: any, pathname: string) => RouteManifestEntry | null
    getCssForRoute: (manifest: any, pathname: string) => string[] | null
  } | null = null

  let routerManifest: any = null

  /**
   * Optionally minifies, then writes. Single place where output HTML
   * hits the filesystem, so the minify toggle applies uniformly.
   */
  async function writeHtml(outputPath: string, html: string): Promise<void> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const finalHtml = minify ? await minifyHtml(html) : html
    await fs.writeFile(outputPath, finalHtml)
  }

  return {
    name: 'bini-ssg',
    apply: 'build',

    configResolved(resolvedConfig: ResolvedConfig) {
      config = resolvedConfig
      outDir = options.outputDir || config.build.outDir || 'dist'
    },

    // Capture Vite's emitted CSS per chunk, in memory.
    // Keys are normalized (forward slashes) so cross-platform lookups match.
    generateBundle(_options, bundle) {
      capturedCss = new Map()
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue
        const cssFiles = (output as any).viteMetadata?.importedCss as Set<string> | undefined
        if (!cssFiles || cssFiles.size === 0) continue
        const modules = Object.keys((output as any).modules ?? {})
        for (const moduleId of modules) {
          const key = moduleId.replace(/\\/g, '/')
          const existing = capturedCss.get(key) ?? []
          capturedCss.set(key, [...existing, ...cssFiles])
        }
      }
    },

    async buildStart() {
      try {
        routerApi = await getBiniRouterAPI()
        routerManifest = routerApi.generateRouteManifest(
          path.join(process.cwd(), appDir),
        )

        routeTree = {
          static: routerManifest.static || [],
          dynamic: routerManifest.dynamic || [],
          metadata: routerManifest.metadata || {},
        }
      } catch (error) {
        const errorMsg = error instanceof Error
          ? `Failed to load bini-router manifest: ${error.message}`
          : 'Failed to load bini-router manifest'
        if (failOnError) {
          throw new Error(errorMsg)
        }
        return
      }
    },

    async closeBundle() {
      const seedRoutes: string[] = [...routeTree.static]

      if (includeRoot && !seedRoutes.includes('/')) {
        seedRoutes.unshift('/')
      }

      if (seedRoutes.length === 0 && routeTree.dynamic.length === 0) {
        return
      }

      try {
        const loadResult = await loadMainModule(config.root)
        if (!loadResult) {
          if (failOnError) throw new Error('Failed to load application module')
          return
        }
        mainModule = loadResult
        htmlTemplate = await loadHtmlTemplate(config.root, outDir)
      } catch (error) {
        const msg = `Failed to load application: ${(error as Error).message}`
        if (failOnError) throw new Error(msg)
        return
      }

      if (!quiet) {
        log.step('Pre-rendering routes')
      }

      const visited = new Set<string>()
      const queue: Array<{ route: string; depth: number }> = seedRoutes.map(
        (r) => ({ route: r, depth: 0 })
      )
      const queued = new Set<string>(seedRoutes)

      const pLimit = await import('p-limit')
      const limit = pLimit.default(concurrency)

      let successCount = 0
      let failCount = 0
      const failedRoutes: string[] = []

      while (queue.length > 0) {
        const batch = queue.splice(0, queue.length)

        await Promise.all(
          batch.map(({ route, depth }) =>
            limit(async () => {
              if (visited.has(route)) return
              visited.add(route)

              let html: string

              try {
                html = await renderRoute(route, mainModule!, htmlTemplate!)
              } catch {
                html = renderShellHtml(htmlTemplate!)
              }

              // Inject resolved metadata + CSS from bini-router.
              const api = routerApi
              const manifest = routerManifest
              if (api && manifest) {
                try {
                  const meta = api.getMetadataForRoute(manifest, route)
                  if (meta) html = applyMetadataToHtml(html, meta)

                  const css = api.getCssForRoute(manifest, route)
                  if (css && css.length > 0) html = injectCssLinks(html, css)
                } catch {
                  // injection is best-effort; never fail the build over it
                }
              }

              const outputPath =
                route === '/'
                  ? path.join(outDir, 'index.html')
                  : path.join(outDir, route, 'index.html')

              try {
                await writeHtml(outputPath, html)
              } catch {
                failCount++
                failedRoutes.push(route)
                hasFatalError = true
                return
              }

              successCount++

              if (!quiet) {
                const paddedRoute = route.padEnd(
                  Math.min(getMaxRouteLength([...visited]) + 2, 40)
                )
                const relPath = path.relative(process.cwd(), outputPath)
                console.log(`  ${colors.green}ok${colors.reset}    ${paddedRoute} → ${colors.dim}${relPath}${colors.reset}`)
              }

              if (depth < crawlDepth) {
                const links = extractInternalLinks(html)
                for (const link of links) {
                  if (!visited.has(link) && !queued.has(link)) {
                    queued.add(link)
                    queue.push({ route: link, depth: depth + 1 })
                  }
                }
              }
            })
          )
        )
      }

      // ── Shell fallback for undiscovered dynamic patterns ───────────────
      // Shells receive the SAME metadata + CSS as crawled routes under the
      // same pattern, because the pattern's layout chain is stable.
      for (const pattern of routeTree.dynamic) {
        const discovered = [...visited].some((route) =>
          routeMatchesPattern(route, pattern)
        )
        if (!discovered) {
          const shellRoute = patternToShellRoute(pattern)
          if (visited.has(shellRoute)) continue
          visited.add(shellRoute)

          let shellHtml = renderShellHtml(htmlTemplate!)

          const api = routerApi
          const manifest = routerManifest
          if (api && manifest) {
            try {
              const meta = api.getMetadataForRoute(manifest, pattern)
              if (meta) shellHtml = applyMetadataToHtml(shellHtml, meta)

              const css = api.getCssForRoute(manifest, pattern)
              if (css && css.length > 0) shellHtml = injectCssLinks(shellHtml, css)
            } catch {
              // best-effort
            }
          }

          const outputPath = path.join(outDir, shellRoute, 'index.html')
          try {
            await writeHtml(outputPath, shellHtml)
            successCount++

            if (!quiet) {
              const paddedRoute = shellRoute.padEnd(
                Math.min(getMaxRouteLength([...visited]) + 2, 40)
              )
              const relPath = path.relative(process.cwd(), outputPath)
              console.log(`  ${colors.green}ok${colors.reset}    ${paddedRoute} → ${colors.dim}${relPath}${colors.reset}`)
            }
          } catch {
            failCount++
            failedRoutes.push(shellRoute)
            hasFatalError = true
          }
        }
      }

      // ── 404 fallback ───────────────────────────────────────────────────
      const hasNotFoundRoute = routeTree.static.some(
        (r) => r === '/404' || r === '/not-found'
      )
      if (options.fallback && !hasNotFoundRoute && mainModule && htmlTemplate) {
        try {
          const fallbackHtml = await renderRoute('/404', mainModule, htmlTemplate)
          const fallbackPath = path.join(outDir, '404.html')
          await writeHtml(fallbackPath, fallbackHtml)
        } catch {
          failCount++
          hasFatalError = true
        }
      }

      await cleanupAssetStubLoader()

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

      if (!quiet) {
        console.log('')
        log.success(
          `${colors.green}${colors.bold}Pre-rendered ${successCount} routes${colors.reset}`
        )
        log.detail(`Completed in ${colors.cyan}${elapsed}s${colors.reset}`)
        console.log('')
        log.info(`Output directory: ${colors.cyan}${path.resolve(outDir)}${colors.reset}`)
        console.log('')
      }

      if (hasFatalError && failOnError) {
        throw new Error(`${failCount} route(s) failed to pre-render`)
      }

      process.exit(0)
    },
  }
}

// ─── Asset-stub loader ──────────────────────────────────────────────────────

const STYLE_EXTS = ['.css', '.scss', '.sass', '.less', '.styl']
const ASSET_EXTS = [
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.webm', '.mp3', '.wav',
]

function buildAssetStubLoaderSource(): string {
  const styleExtsLiteral = JSON.stringify(STYLE_EXTS)
  const assetExtsLiteral = JSON.stringify(ASSET_EXTS)

  return `
const STYLE_EXTS = ${styleExtsLiteral};
const ASSET_EXTS = ${assetExtsLiteral};

function extOf(specifier) {
  const clean = specifier.split('?')[0].split('#')[0];
  const idx = clean.lastIndexOf('.');
  return idx === -1 ? '' : clean.slice(idx).toLowerCase();
}

export async function resolve(specifier, context, nextResolve) {
  const ext = extOf(specifier);
  if (STYLE_EXTS.includes(ext)) {
    return {
      url: 'bini-ssg-style-stub:' + encodeURIComponent(specifier),
      format: 'bini-ssg-style-stub',
      shortCircuit: true,
    };
  }
  if (ASSET_EXTS.includes(ext)) {
    return {
      url: 'bini-ssg-asset-stub:' + encodeURIComponent(specifier),
      format: 'bini-ssg-asset-stub',
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (context.format === 'bini-ssg-style-stub') {
    return {
      format: 'module',
      source: 'export default {};',
      shortCircuit: true,
    };
  }
  if (context.format === 'bini-ssg-asset-stub') {
    return {
      format: 'module',
      source: 'export default "";',
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
`
}

async function registerAssetStubLoader(): Promise<void> {
  if (loaderHooksRegistered) return
  if (assetStubLoaderRegistered) return

  assetStubLoaderRegistered = true
  loaderHooksRegistered = true

  const { register } = await import('module')

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bini-ssg-'))
  assetStubLoaderPath = path.join(tempDir, 'asset-stub-loader.mjs')
  await fs.writeFile(assetStubLoaderPath, buildAssetStubLoaderSource(), 'utf8')

  register(pathToFileURL(assetStubLoaderPath).href, import.meta.url)
}

async function cleanupAssetStubLoader(): Promise<void> {
  if (assetStubLoaderPath) {
    try {
      const tempDir = path.dirname(assetStubLoaderPath)
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
    assetStubLoaderPath = null
    assetStubLoaderRegistered = false
  }
}

async function loadMainModule(root: string): Promise<MainModule | null> {
  const extensions = ['.tsx', '.jsx', '.ts', '.js']
  const basePath = path.join(root, 'src', 'main')

  let foundPath: string | null = null

  for (const ext of extensions) {
    const filePath = basePath + ext
    try {
      await fs.access(filePath)
      foundPath = filePath
      break
    } catch {
      // Continue to next extension
    }
  }

  if (!foundPath) {
    throw new Error(
      `Could not find src/main.tsx or src/main.jsx.\n` +
      `Tried: ${extensions.map(e => 'main' + e).join(', ')}`
    )
  }

  try {
    if (!tsxRegistered) {
      const tsx = await import('tsx')
      if (tsx.register) {
        tsx.register()
      }
      tsxRegistered = true
    }

    await registerAssetStubLoader()

    const url = pathToFileURL(foundPath).href
    const module = await import(url)

    if (typeof module.render === 'function') {
      return module as MainModule
    }

    throw new Error(
      `File ${foundPath} must export a render(url) function.\n` +
      `This is what bini-ssg calls to produce HTML for each route.`
    )
  } catch (error: any) {
    throw new Error(
      `Failed to load ${foundPath}.\n` +
      `Error: ${error.message}\n` +
      `Make sure tsx is installed: npm install --save-dev tsx`
    )
  }
}

async function loadHtmlTemplate(root: string, outDir: string): Promise<string> {
  const indexPath = path.join(root, outDir, 'index.html')
  try {
    const content = await fs.readFile(indexPath, 'utf-8')
    return content
  } catch {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bini App</title>
</head>
<body>
  <div id="root"></div>
</body>
</html>`
  }
}

function renderRoute(
  route: string,
  module: MainModule,
  template: string
): Promise<string> {
  const result = module.render(route)
  const htmlPromise = result instanceof Promise ? result : Promise.resolve(result)

  return htmlPromise.then((html: string) => safeRootDivReplacement(template, html))
}

export default biniSSG