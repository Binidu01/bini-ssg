import type { Plugin, ResolvedConfig, UserConfig } from 'vite'
import type { RouteManifest, RouteManifestEntry, PrerenderMode } from 'bini-router'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'node-html-parser'
import { minify as minifyHtmlTerser } from 'html-minifier-terser'

export type { HeadNode } from 'bini-router'
import type { HeadNode } from 'bini-router'

export interface PrerenderResult {
  rendered: string[]
  failed: Array<{ route: string; error: string }>
  elapsedMs: number
}

interface SSRModule {
  render: (url: string) => Promise<string> | string
}

interface RouterApi {
  generateRouteManifest: (appDir: string, apiDir?: string) => RouteManifest
  getMetadataForRoute: (manifest: RouteManifest, pathname: string) => RouteManifestEntry | null
  getCssForRoute: (manifest: RouteManifest, pathname: string) => string[] | null
}

interface QueueItem {
  route: string
  depth: number
}

const APP_DIR = 'src/app'
const DEFAULT_OUT_DIR = 'dist'
const SSR_ENTRY = 'main.js'

const CONCURRENCY = 1
const CRAWL_DEPTH = Infinity
const FAIL_ON_ERROR = true
const GENERATE_404 = true
const CLEANUP_SSR = true
const MINIFY = true
const INCLUDE_ROOT = true

const PLUGIN_NAME = 'bini-ssg'
const BINI_DIR = '.bini'
const CSS_MAP_FILE = 'css-map.json'
const ROOT_MARKER = '__BINI_SSG_ROOT_CONTENT__'
const NOT_FOUND_PROBE = '/__bini_not_found__'
const SHELL_MARKER_SCRIPT = '<script>window.__BINI_SHELL__=true;</script>'

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
} as const

function makeLog(quiet: boolean) {
  const out = (msg: string) => {
    if (!quiet) console.log(msg)
  }
  return {
    info: (msg: string) => out(`${colors.blue}${colors.bold}INFO${colors.reset} ${msg}`),
    success: (msg: string) => out(`${colors.green}${colors.bold}SUCCESS${colors.reset} ${msg}`),
    step: (msg: string) => out(`${colors.cyan}${colors.bold}STEP${colors.reset} ${msg}`),
    detail: (msg: string) => out(`  ${colors.dim}${msg}${colors.reset}`),
    ok: (route: string, file: string, width: number) =>
      out(`  ${colors.green}ok${colors.reset}    ${route.padEnd(width)} → ${colors.dim}${file}${colors.reset}`),
    warn: (msg: string) => console.warn(`${colors.yellow}${colors.bold}WARN${colors.reset} ${msg}`),
    fail: (route: string, msg: string) =>
      console.error(`  ${colors.red}✗${colors.reset}     ${route} ${colors.dim}${msg}${colors.reset}`),
    blank: () => out(''),
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function normPath(p: string): string {
  return toPosix(p).toLowerCase()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function resolvePathSegments(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return '/' + out.join('/')
}

function readPrerenderMode(
  meta: RouteManifestEntry | null | undefined,
  warn: (m: string) => void,
): PrerenderMode | undefined {
  const raw = (meta as { prerender?: unknown } | null | undefined)?.prerender
  if (raw === undefined || raw === null) return undefined
  if (raw === false) return false
  if (raw === 'strict') return 'strict'
  if (raw === 'fallback') return 'fallback'
  warn(`Unknown prerender value ${JSON.stringify(raw)}; treating as 'fallback'. Use false | 'strict' | 'fallback'.`)
  return undefined
}

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
      out += VOID_ELEMENTS.has(n.tag.toLowerCase()) ? open : `${open}${headTreeToHtml(n.children)}</${n.tag}>`
    }
  }
  return out
}

function routeMatchesPattern(route: string, pattern: string): boolean {
  const routeParts = route.split('/').filter(Boolean)
  const patternParts = pattern.split('/').filter(Boolean)
  if (patternParts.length === 0) return routeParts.length === 0

  const last = patternParts[patternParts.length - 1]
  const catchAll = last === '*' || last === '**' || last.startsWith('[...')
  if (catchAll) {
    if (routeParts.length < patternParts.length - 1) return false
  } else if (patternParts.length !== routeParts.length) {
    return false
  }

  const limit = catchAll ? patternParts.length - 1 : patternParts.length
  for (let i = 0; i < limit; i++) {
    const p = patternParts[i]
    if (p.startsWith(':') || p.startsWith('[')) continue
    if (p !== routeParts[i]) return false
  }
  return true
}

function shellBaseForPattern(pattern: string): string | null {
  const parts = pattern.split('/').filter(Boolean)
  if (parts.length === 0) return null

  const last = parts[parts.length - 1]
  const isCatchAll = last === '*' || last === '**' || last.startsWith('[...')
  const isDynamic = last.startsWith(':') || last.startsWith('[')

  if (!isCatchAll && !isDynamic) return null

  const parent = parts.slice(0, -1)
  return parent.length === 0 ? '/' : '/' + parent.join('/')
}

function routeToOutputPath(outDir: string, route: string): string {
  if (route === '/') return path.join(outDir, 'index.html')

  const segments = route
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      let decoded = segment
      try {
        decoded = decodeURIComponent(segment)
      } catch {
        // keep the raw segment
      }
      if (decoded === '.' || decoded === '..' || /[\\/\0:*?"<>|]/.test(decoded)) {
        throw new Error(`unsafe route segment "${segment}"`)
      }
      return decoded
    })

  const target = path.join(outDir, ...segments, 'index.html')
  const rel = path.relative(outDir, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`route escapes the output directory: ${route}`)
  }
  return target
}

interface CssIndex {
  exact: Map<string, string[]>
  byBase: Map<string, string[][]>
}

function buildCssIndex(raw: Record<string, string[]>): CssIndex {
  const exact = new Map<string, string[]>()
  const byBase = new Map<string, string[][]>()
  for (const [key, urls] of Object.entries(raw)) {
    const n = normPath(key)
    exact.set(n, urls)
    const base = normPath(path.basename(key, path.extname(key)))
    const list = byBase.get(base) ?? []
    list.push(urls)
    byBase.set(base, list)
  }
  return { exact, byBase }
}

function resolveHashedCss(index: CssIndex, sourcePath: string): string[] {
  const direct = index.exact.get(normPath(path.resolve(sourcePath)))
  if (direct) return direct

  const candidates = index.byBase.get(normPath(path.basename(sourcePath, path.extname(sourcePath))))
  return candidates && candidates.length === 1 ? candidates[0] : []
}

async function loadCssIndex(outDir: string): Promise<CssIndex | null> {
  try {
    const raw = await fs.readFile(path.join(outDir, BINI_DIR, CSS_MAP_FILE), 'utf8')
    return buildCssIndex(JSON.parse(raw) as Record<string, string[]>)
  } catch {
    return null
  }
}

function applyHead(
  doc: ReturnType<typeof parse>,
  meta: RouteManifestEntry | null,
  cssUrls: string[],
  shell: boolean,
): void {
  const head = doc.querySelector('head')

  if (head && meta) {
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    const m = (meta.meta ?? {}) as Record<string, unknown>

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
      if (existing) {
        existing.setAttribute('href', href)
        return
      }
      const attrs = [
        `rel="${escapeAttr(rel)}"`,
        `href="${escapeAttr(href)}"`,
        ...Object.entries(extra).map(([k, v]) => `${k}="${escapeAttr(v)}"`),
      ].join(' ')
      head.insertAdjacentHTML('beforeend', `<link ${attrs} />`)
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

    const icons = m.icons as Record<string, Array<{ url: string; type?: string; sizes?: string }>> | undefined
    if (icons) {
      const withExtra = (e: { type?: string; sizes?: string }) => {
        const extra: Record<string, string> = {}
        if (e.type) extra.type = e.type
        if (e.sizes) extra.sizes = e.sizes
        return extra
      }
      for (const e of icons.icon ?? []) ensureLink('icon', e.url, withExtra(e))
      for (const e of icons.shortcut ?? []) ensureLink('shortcut icon', e.url)
      for (const e of icons.apple ?? []) ensureLink('apple-touch-icon', e.url, withExtra(e))
    }

    const og = m.openGraph as Record<string, unknown> | undefined
    if (og && str(og.title)) {
      ensureMeta('og:title', str(og.title)!, true)
      ensureMeta('og:type', str(og.type) ?? 'website', true)
      if (str(og.description)) ensureMeta('og:description', str(og.description)!, true)
      if (str(og.url)) ensureMeta('og:url', str(og.url)!, true)
      if (str(og.siteName)) ensureMeta('og:site_name', str(og.siteName)!, true)

      const images: unknown[] = Array.isArray(og.images) ? og.images : og.image ? [og.image] : []
      for (const image of images) {
        const entry = typeof image === 'string' ? { url: image } : (image as Record<string, unknown>)
        if (!str(entry.url)) continue
        head.insertAdjacentHTML('beforeend', `<meta property="og:image" content="${escapeAttr(str(entry.url)!)}" />`)
        if (entry.width != null) {
          head.insertAdjacentHTML('beforeend', `<meta property="og:image:width" content="${escapeAttr(String(entry.width))}" />`)
        }
        if (entry.height != null) {
          head.insertAdjacentHTML('beforeend', `<meta property="og:image:height" content="${escapeAttr(String(entry.height))}" />`)
        }
        if (str(entry.alt)) {
          head.insertAdjacentHTML('beforeend', `<meta property="og:image:alt" content="${escapeAttr(str(entry.alt)!)}" />`)
        }
      }
    }

    const tw = m.twitter as Record<string, unknown> | undefined
    if (tw && str(tw.title)) {
      ensureMeta('twitter:card', str(tw.card) ?? 'summary_large_image')
      ensureMeta('twitter:title', str(tw.title)!)
      if (str(tw.description)) ensureMeta('twitter:description', str(tw.description)!)
      if (str(tw.creator)) ensureMeta('twitter:creator', str(tw.creator)!)

      const images: unknown[] = Array.isArray(tw.images) ? tw.images : tw.image ? [tw.image] : []
      const first = images[0]
      const firstUrl = typeof first === 'string' ? first : str((first as Record<string, unknown> | undefined)?.url)
      if (firstUrl) ensureMeta('twitter:image', firstUrl)
    }

    const headNodes = meta.document?.head
    if (Array.isArray(headNodes) && headNodes.length > 0) {
      const headHtml = headTreeToHtml(headNodes as HeadNode[])
      if (headHtml) head.insertAdjacentHTML('beforeend', headHtml)
    }
  }

  const documentConfig = meta?.document
  if (documentConfig) {
    const htmlEl = doc.querySelector('html')
    if (htmlEl && documentConfig.html) {
      for (const [k, v] of Object.entries(documentConfig.html)) {
        if (typeof v === 'string') htmlEl.setAttribute(k, v)
      }
    }
    const bodyEl = doc.querySelector('body')
    if (bodyEl && documentConfig.body) {
      for (const [k, v] of Object.entries(documentConfig.body)) {
        if (typeof v === 'string') bodyEl.setAttribute(k, v)
      }
    }
  }

  if (head && cssUrls.length > 0) {
    const present = new Set(
      head.querySelectorAll('link[rel="stylesheet"]').map((l) => (l.getAttribute('href') ?? '').replace(/^\/+/, '')),
    )
    for (const url of cssUrls) {
      const clean = url.replace(/^\/+/, '')
      if (present.has(clean)) continue
      present.add(clean)
      head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${escapeAttr('/' + clean)}" />`)
    }
  }

  if (head && shell) head.insertAdjacentHTML('beforeend', SHELL_MARKER_SCRIPT)
}

function extractInternalLinks(html: string): string[] {
  let root: ReturnType<typeof parse>
  try {
    root = parse(html, { comment: true })
  } catch {
    return []
  }

  const baseHref = root.querySelector('base')?.getAttribute('href') ?? '/'
  const links: string[] = []
  const seen = new Set<string>()

  for (const a of root.querySelectorAll('a[href]')) {
    const href = (a.getAttribute('href') ?? '').trim()
    if (!href || href.startsWith('#')) continue
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href) || href.startsWith('//')) continue

    let resolved = href
    if (!resolved.startsWith('/')) {
      const base = baseHref.endsWith('/') ? baseHref : baseHref + '/'
      resolved = base + resolved
    }
    resolved = resolvePathSegments(resolved.split('#')[0].split('?')[0])
    if (!resolved.startsWith('/')) continue

    if (
      resolved.startsWith('/assets/') ||
      resolved.startsWith('/_next/') ||
      resolved.startsWith('/static/') ||
      /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|woff2?|ttf|eot|mp4|webm|mp3|wav|pdf|xml|txt|json)$/i.test(resolved)
    ) {
      continue
    }

    if (resolved.length > 1 && resolved.endsWith('/')) resolved = resolved.slice(0, -1)

    if (!seen.has(resolved)) {
      seen.add(resolved)
      links.push(resolved)
    }
  }
  return links
}

async function minifyHtml(html: string): Promise<string> {
  return minifyHtmlTerser(html, {
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
}

async function runQueue(
  initial: QueueItem[],
  worker: (item: QueueItem, enqueue: (item: QueueItem) => void) => Promise<void>,
): Promise<void> {
  const queue = [...initial]

  while (queue.length > 0) {
    const item = queue.shift()!
    await worker(item, (next) => queue.push(next))
  }
}

async function getRouterApi(): Promise<RouterApi> {
  const biniRouter = await import('bini-router')
  return {
    generateRouteManifest: biniRouter.generateRouteManifest,
    getMetadataForRoute: biniRouter.getMetadataForRoute,
    getCssForRoute: biniRouter.getCssForRoute,
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function loadSsrModule(ssrDir: string, entry: string): Promise<SSRModule> {
  const file = path.join(ssrDir, entry)
  if (!(await exists(file))) {
    throw new Error(
      `Bini SSG Error: SSR bundle not found at ${file}.\n` +
      `Run the SSR build first: vite build --ssr src/main.tsx`,
    )
  }

  let mod: Record<string, unknown>
  try {
    mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Bini SSG Error: failed to load the SSR bundle ${file}.\n${errorMessage(error)}`)
  }

  if (typeof mod.render !== 'function') {
    throw new Error('Bini SSG Error: SSR bundle does not export render().')
  }
  return mod as unknown as SSRModule
}

export async function prerender(): Promise<PrerenderResult> {
  const started = Date.now()
  const root = process.cwd()
  const outDir = path.resolve(root, DEFAULT_OUT_DIR)
  const ssrDir = path.join(outDir, BINI_DIR, 'server')
  const appDir = path.resolve(root, APP_DIR)
  const log = makeLog(false)

  const templatePath = path.join(outDir, 'index.html')
  let template: string
  try {
    template = await fs.readFile(templatePath, 'utf8')
  } catch {
    throw new Error(
      `Bini SSG Error: ${templatePath} not found.\nRun the client build first: vite build`,
    )
  }

  const shellDoc = parse(template, { comment: true, voidTag: { closingSlash: true } })
  const rootEl = shellDoc.querySelector('#root')
  if (!rootEl) throw new Error(`Bini SSG Error: ${templatePath} has no element with id="root".`)
  rootEl.innerHTML = ROOT_MARKER
  const templateWithMarker = shellDoc.toString()

  const router = await getRouterApi()
  const manifest = router.generateRouteManifest(appDir)
  const staticRoutes: string[] = manifest.static ?? []
  const dynamicPatterns: string[] = manifest.dynamic ?? []
  const cssIndex = await loadCssIndex(outDir)
  if (!cssIndex) {
    log.warn(`No ${BINI_DIR}/${CSS_MAP_FILE} found; route-scoped CSS links will not be injected.`)
  }

  const policies = new Map<string, { mode: PrerenderMode | undefined }>()
  for (const p of dynamicPatterns) {
    policies.set(p, { mode: readPrerenderMode(manifest.metadata[p], log.warn) })
  }

  const ssr = await loadSsrModule(ssrDir, SSR_ENTRY)

  const failed: Array<{ route: string; error: string }> = []
  const seeds: string[] = []

  for (const route of staticRoutes) {
    const mode = readPrerenderMode(manifest.metadata[route], log.warn)
    if (mode === false) continue
    seeds.push(route)
  }
  if (INCLUDE_ROOT && !seeds.includes('/')) seeds.unshift('/')

  const skipped = new Set<string>()
  for (const pattern of dynamicPatterns) {
    const { mode } = policies.get(pattern)!
    if (mode === false) skipped.add(pattern)
  }

  const uniqueSeeds = [...new Set(seeds)]
  if (uniqueSeeds.length === 0) {
    log.warn('No routes to prerender.')
    return { rendered: [], failed, elapsedMs: Date.now() - started }
  }

  log.step('Pre-rendering routes')

  const visited = new Set<string>()
  const queued = new Set<string>(uniqueSeeds)
  const rendered: Array<{ route: string; file: string }> = []

  let html404 = null as string | null

  const buildPage = (route: string, appHtml: string, shell: boolean): string => {
    const doc = parse(templateWithMarker, { comment: true, voidTag: { closingSlash: true } })

    let meta: RouteManifestEntry | null = null
    let cssUrls: string[] = []
    try {
      meta = router.getMetadataForRoute(manifest, route)
      const sources = router.getCssForRoute(manifest, route) ?? []
      if (cssIndex && sources.length > 0) {
        const urls = new Set<string>()
        for (const source of sources) for (const url of resolveHashedCss(cssIndex, source)) urls.add(url)
        cssUrls = [...urls]
      }
    } catch {
      // best-effort enrichments
    }

    applyHead(doc, meta, cssUrls, shell)
    return doc.toString().replace(ROOT_MARKER, () => appHtml)
  }

  const writePage = async (route: string, html: string): Promise<string> => {
    const file = routeToOutputPath(outDir, route)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, MINIFY ? await minifyHtml(html) : html)
    return file
  }

  await runQueue(
    uniqueSeeds.map((route) => ({ route, depth: 0 })),
    async ({ route, depth }, enqueue) => {
      if (visited.has(route)) return
      visited.add(route)

      let appHtml = ''
      let shell = false
      try {
        const result = await ssr.render(route)
        if (typeof result !== 'string') throw new Error(`render() returned ${typeof result}, expected a string`)
        appHtml = result
      } catch {
        shell = true
      }

      try {
        const html = buildPage(route, appHtml, shell)
        if (route === '/404') html404 = html
        const file = await writePage(route, html)
        rendered.push({ route, file })
      } catch (error) {
        failed.push({ route, error: errorMessage(error) })
        log.fail(route, errorMessage(error))
        return
      }

      if (!shell && depth < CRAWL_DEPTH) {
        for (const link of extractInternalLinks(appHtml)) {
          const linkPolicy = readPrerenderMode(
            router.getMetadataForRoute(manifest, link) ?? undefined,
            () => {},
          )
          if (linkPolicy === false) continue

          if (!visited.has(link) && !queued.has(link)) {
            queued.add(link)
            enqueue({ route: link, depth: depth + 1 })
          }
        }
      }
    },
  )

  for (const pattern of dynamicPatterns) {
    if (skipped.has(pattern)) continue

    const wasRendered = [...visited].some((route) => routeMatchesPattern(route, pattern))
    if (wasRendered) continue

    const base = shellBaseForPattern(pattern)
    if (base === null) continue

    if (base.includes(':') || base.includes('[')) continue

    if (visited.has(base)) continue

    if (visited.has(`__shell__:${base}`)) continue
    visited.add(`__shell__:${base}`)

    try {
      const html = buildPage(base, '', true)
      const file = await writePage(base, html)
      rendered.push({ route: `${base} (shell)`, file })
    } catch (error) {
      failed.push({ route: `${pattern} (shell)`, error: errorMessage(error) })
      log.fail(`${pattern} (shell)`, errorMessage(error))
    }
  }

  if (GENERATE_404) {
    let html: string | null = html404
    let shell = false
    if (html === null) {
      let probe = ''
      try {
        const result = await ssr.render(NOT_FOUND_PROBE)
        if (typeof result !== 'string') throw new Error(`render() returned ${typeof result}, expected a string`)
        probe = result
      } catch {
        shell = true
      }
      try {
        html = buildPage(NOT_FOUND_PROBE, probe, shell)
      } catch (error) {
        failed.push({ route: '404.html', error: errorMessage(error) })
        log.fail('404.html', errorMessage(error))
        html = null
      }
    }

    if (html !== null) {
      try {
        await fs.writeFile(path.join(outDir, '404.html'), MINIFY ? await minifyHtml(html) : html)
        rendered.push({ route: '404.html', file: path.join(outDir, '404.html') })
      } catch (error) {
        failed.push({ route: '404.html', error: errorMessage(error) })
        log.fail('404.html', errorMessage(error))
      }
    }
  }

  rendered.sort((a, b) => a.route.localeCompare(b.route))
  const width = Math.min(rendered.reduce((m, r) => Math.max(m, r.route.length), 10) + 2, 40)
  for (const { route, file } of rendered) log.ok(route, path.relative(root, file), width)

  const elapsedMs = Date.now() - started

  if (failed.length > 0) {
    log.blank()
    console.error(`${colors.red}${colors.bold}FAILED${colors.reset} ${failed.length} route(s) could not be written to disk:`)
    for (const f of failed) console.error(`  ${colors.red}✗${colors.reset} ${f.route}\n    ${f.error}`)
    if (FAIL_ON_ERROR) {
      throw new Error(`Bini SSG: ${failed.length} route(s) failed to write (${failed.map((f) => f.route).join(', ')})`)
    }
  }

  if (CLEANUP_SSR && failed.length === 0) {
    await fs.rm(path.join(outDir, BINI_DIR), { recursive: true, force: true }).catch(() => {})
  }

  log.blank()
  log.success(`${colors.green}${colors.bold}Pre-rendered ${rendered.length} routes${colors.reset}`)
  log.detail(`Completed in ${colors.cyan}${(elapsedMs / 1000).toFixed(2)}s${colors.reset}`)
  log.blank()
  log.info(`Output directory: ${colors.cyan}${outDir}${colors.reset}`)
  log.blank()

  return { rendered: rendered.map((r) => r.route), failed, elapsedMs }
}

export function biniSSG(): Plugin {
  let root = process.cwd()
  let outDir = path.resolve(root, DEFAULT_OUT_DIR)
  let ssrDir = path.join(outDir, BINI_DIR, 'server')
  let config: ResolvedConfig
  let isSsrBuild = false
  let buildFailed = false

  const resolvePaths = (userConfig: UserConfig): void => {
    root = userConfig.root ? path.resolve(userConfig.root) : process.cwd()
    const configured = path.resolve(root, userConfig.build?.outDir ?? DEFAULT_OUT_DIR)
    const posix = toPosix(configured)
    const marker = `/${BINI_DIR}/server`
    const at = posix.indexOf(marker)
    outDir = at >= 0 ? configured.slice(0, at) : configured
    ssrDir = path.join(outDir, BINI_DIR, 'server')
  }

  return {
    name: PLUGIN_NAME,
    apply: 'build',

    config(userConfig: UserConfig) {
      resolvePaths(userConfig)
      const ssr = Boolean(userConfig.build?.ssr)
      if (!ssr) return

      return {
        build: {
          outDir: ssrDir,
          emptyOutDir: false,
          copyPublicDir: false,
          ssrEmitAssets: false,
          rollupOptions: {
            output: {
              format: 'es',
              entryFileNames: '[name].js',
              chunkFileNames: 'chunks/[name]-[hash].js',
            },
          },
        },
      }
    },

    configResolved(resolved: ResolvedConfig) {
      config = resolved
      isSsrBuild = Boolean(resolved.build.ssr)
    },

    generateBundle(_outputOptions, bundle) {
      if (isSsrBuild) return

      const map: Record<string, string[]> = {}
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        const imported = (output as any).viteMetadata?.importedCss as Set<string> | undefined
        if (!imported || imported.size === 0) continue
        for (const moduleId of Object.keys((output as any).modules ?? {})) {
          const key = toPosix(moduleId)
          map[key] = [...new Set([...(map[key] ?? []), ...imported])]
        }
      }

      this.emitFile({
        type: 'asset',
        fileName: `${BINI_DIR}/${CSS_MAP_FILE}`,
        source: JSON.stringify(map),
      })
    },

    buildEnd(error) {
      if (error) buildFailed = true
    },

    async closeBundle() {
      if (!isSsrBuild || buildFailed) return
      await prerender()
    },
  }
}

export default biniSSG