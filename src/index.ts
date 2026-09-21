import type { Plugin, ResolvedConfig } from 'vite'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { pathToFileURL } from 'url'
import { parse, HTMLElement } from 'node-html-parser'

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
}

interface RouteTree {
  static: string[]
  dynamic: string[]
  metadata?: Record<string, any>
}

interface MainModule {
  render: (url: string) => Promise<string> | string
}

// ─── Module-level state ─────────────────────────────────────────────────────

let tsxRegistered = false
let assetStubLoaderPath: string | null = null
let assetStubLoaderRegistered = false
let loaderHooksRegistered = false

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

// ─── HTML manipulation via node-html-parser ─────────────────────────────────

/**
 * Replaces the content inside the #root element of the template with the
 * rendered app HTML. Uses node-html-parser so we get correct HTML
 * tokenization — script/style raw-text regions, comments, and self-closing
 * tags are all handled by the parser, not by hand-rolled depth counting.
 *
 * If #root is missing, it's inserted into <body> (or the document root as a
 * last resort). If <body> is also missing, the parsed structure is preserved
 * as-is and the rendered HTML is appended.
 */
function safeRootDivReplacement(template: string, content: string): string {
  const root = parse(template, {
    comment: true,
    voidTag: { closingSlash: true },
  })

  const rootEl = root.querySelector('#root')

  if (rootEl) {
    // Preserve attributes on #root, replace only its inner content.
    // node-html-parser's innerHTML setter accepts a raw HTML string.
    rootEl.innerHTML = content
    return root.toString()
  }

  const body = root.querySelector('body')
  if (body) {
    body.insertAdjacentHTML('afterbegin', `<div id="root">${content}</div>`)
    return root.toString()
  }

  // No <body> either — extremely rare; fall back to prepending.
  return `<div id="root">${content}</div>${root.toString()}`
}

// ─── Link extraction (pure Node, no browser) ────────────────────────────────

/**
 * Extracts all internal href values from a rendered HTML string.
 * Filters out external URLs, hash links, mailto/tel, and static asset paths.
 */
function extractInternalLinks(html: string): string[] {
  const links: string[] = []
  const seen = new Set<string>()
  const hrefRegex = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi

  let match: RegExpExecArray | null
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1].trim()

    if (!href) continue
    if (href.startsWith('#')) continue
    if (href.startsWith('mailto:') || href.startsWith('tel:')) continue
    if (href.startsWith('javascript:')) continue
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) continue
    if (href.startsWith('//')) continue
    if (
      href.startsWith('/assets/') ||
      href.startsWith('/_next/') ||
      href.startsWith('/static/') ||
      /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|woff2?|ttf|eot|mp4|webm|mp3|wav|pdf|xml|txt|json)(\?|#|$)/i.test(href)
    ) {
      continue
    }

    let normalized = href.split('#')[0].split('?')[0]
    if (!normalized.startsWith('/')) normalized = '/' + normalized
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1)
    }

    if (!seen.has(normalized)) {
      seen.add(normalized)
      links.push(normalized)
    }
  }

  return links
}

/**
 * Checks whether a concrete route matches a dynamic pattern.
 * e.g. routeMatchesPattern('/blog/hello', '/blog/:slug') === true
 */
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
    // #root already exists — nothing else to do.
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
  const startTime = Date.now()

  let mainModule: MainModule | null = null
  let htmlTemplate: string | null = null
  let hasFatalError = false
  let outDir: string = 'dist'

  return {
    name: 'bini-ssg',
    apply: 'build',

    configResolved(resolvedConfig: ResolvedConfig) {
      config = resolvedConfig
      outDir = options.outputDir || config.build.outDir || 'dist'
    },

    async buildStart() {
      try {
        const { generateRouteManifest } = await getBiniRouterAPI()

        const manifest = generateRouteManifest(path.join(process.cwd(), appDir))
        routeTree = {
          static: manifest.static || [],
          dynamic: manifest.dynamic || [],
          metadata: manifest.metadata || {},
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
      // ── Seed routes ────────────────────────────────────────────────────
      const seedRoutes: string[] = [...routeTree.static]

      if (includeRoot && !seedRoutes.includes('/')) {
        seedRoutes.unshift('/')
      }

      if (seedRoutes.length === 0 && routeTree.dynamic.length === 0) {
        return
      }

      // ── Load app module + template ─────────────────────────────────────
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

      // ── Crawl + render loop ────────────────────────────────────────────
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
                // Any render error → silent shell fallback.
                html = renderShellHtml(htmlTemplate!)
              }

              const outputPath =
                route === '/'
                  ? path.join(outDir, 'index.html')
                  : path.join(outDir, route, 'index.html')

              try {
                await fs.mkdir(path.dirname(outputPath), { recursive: true })
                await fs.writeFile(outputPath, html)
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

              // Crawl links from this page (regardless of shell or full).
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
      for (const pattern of routeTree.dynamic) {
        const discovered = [...visited].some((route) =>
          routeMatchesPattern(route, pattern)
        )
        if (!discovered) {
          const shellRoute = patternToShellRoute(pattern)
          if (visited.has(shellRoute)) continue
          visited.add(shellRoute)

          const shellHtml = renderShellHtml(htmlTemplate!)
          const outputPath = path.join(outDir, shellRoute, 'index.html')
          try {
            await fs.mkdir(path.dirname(outputPath), { recursive: true })
            await fs.writeFile(outputPath, shellHtml)
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
          await fs.writeFile(fallbackPath, fallbackHtml)
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