import type { Plugin, ResolvedConfig } from 'vite'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'

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

/**
 * Safely replace the content inside <div id="root"> using depth counting.
 */
function safeRootDivReplacement(template: string, content: string): string {
  const rootDivRegex = /<div[^>]*id=["']root["'][^>]*>/
  const match = template.match(rootDivRegex)

  if (!match) {
    const bodyRegex = /<body[^>]*>/
    if (bodyRegex.test(template)) {
      return template.replace(bodyRegex, (match) => {
        return `${match}\n  <div id="root">${content}</div>`
      })
    }
    return `<div id="root">${content}</div>`
  }

  if (match.index === undefined) {
    return template.replace(rootDivRegex, `<div id="root">${content}</div>`)
  }

  const tagMatch = match[0]
  if (tagMatch.endsWith('/>')) {
    const before = template.slice(0, match.index)
    const after = template.slice(match.index + tagMatch.length)
    return `${before}<div id="root">${content}</div>${after}`
  }

  const startIndex = match.index + match[0].length
  let depth = 1
  let endIndex = startIndex

  for (let i = startIndex; i < template.length; i++) {
    if (template[i] === '<') {
      if (template.slice(i, i + 4) === '<div') {
        const nextChar = template[i + 4] || ''
        if (/[\s/>]/.test(nextChar)) {
          let j = i + 4
          let isSelfClosing = false
          while (j < template.length && template[j] !== '>') {
            if (template[j] === '/' && template[j + 1] === '>') {
              isSelfClosing = true
              break
            }
            j++
          }
          if (!isSelfClosing) {
            depth++
          }
        }
      } else if (template.slice(i, i + 6) === '</div>') {
        depth--
        if (depth === 0) {
          endIndex = i + 6
          break
        }
      }
    }
  }

  if (endIndex === startIndex) {
    return template.replace(rootDivRegex, `<div id="root">${content}</div>`)
  }

  return template.slice(0, startIndex) + content + template.slice(endIndex)
}

// ─── Shell HTML ─────────────────────────────────────────────────────────────

/**
 * Builds shell HTML for a route without invoking module.render(). Used both
 * for dynamic-route shells and for static routes that failed to pre-render
 * and are falling back to a shell so the build doesn't break.
 *
 * IMPORTANT: the template is reused as-is. It already carries whatever
 * metadata your build produced for that route (title, meta tags, hashed
 * asset links, custom <meta name="..."> entries, etc). We never rewrite or
 * add metadata here — doing so would make the server-emitted <head> diverge
 * from what the client bundle expects on hydrate, causing hydration errors.
 * The only thing we ever touch is making sure a #root mount point exists.
 */
const SHELL_MARKER_SCRIPT = '<script>window.__BINI_SHELL__=true;</script>'

/**
 * Marks the document as a shell so the client entry knows to do a plain
 * client-side render instead of hydrateRoot(). Without this, React tries to
 * hydrate the shell's empty #root against the real component tree, the DOM
 * it finds doesn't match anything it expected, and it throws React error
 * #418 ("Hydration failed because the initial UI does not match what was
 * rendered on the server").
 *
 * Placed as a plain (non-module) inline script, which — unlike the app's
 * `type="module"` entry script — runs synchronously during parsing, so it's
 * guaranteed to execute before the module script that mounts the app.
 */
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
  let html = injectShellMarker(template)

  const rootDivRegex = /<div[^>]*id=["']root["'][^>]*>/
  if (rootDivRegex.test(html)) {
    return html
  }

  const bodyRegex = /<body[^>]*>/
  if (bodyRegex.test(html)) {
    return html.replace(bodyRegex, (match) => {
      return `${match}\n  <div id="root"><!-- Shell content --></div>`
    })
  }

  return `<div id="root"><!-- Shell content --></div>`
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
      let allRoutes: string[] = []

      // Add static routes
      allRoutes.push(...routeTree.static)

      // Generate shells for dynamic routes
      const dynamicShellRoutes: string[] = []
      for (const dynamicPattern of routeTree.dynamic) {
        const shellRoute = patternToShellRoute(dynamicPattern)
        dynamicShellRoutes.push(shellRoute)
        allRoutes.push(shellRoute)
      }

      // Add root route if not included
      if (includeRoot && !allRoutes.includes('/')) {
        allRoutes.unshift('/')
      }

      allRoutes = deduplicateRoutes(allRoutes)

      if (allRoutes.length === 0) {
        if (!quiet) {
          // No routes found - could log warning here if needed
        }
        return
      }

      try {
        const loadResult = await loadMainModule(config.root)
        if (!loadResult) {
          const msg = 'Failed to load application module'
          if (failOnError) {
            throw new Error(msg)
          }
          return
        }
        mainModule = loadResult
        htmlTemplate = await loadHtmlTemplate(config.root, outDir)
      } catch (error) {
        const msg = `Failed to load application: ${(error as Error).message}`
        if (failOnError) {
          throw new Error(msg)
        }
        return
      }

      if (!quiet) {
        log.step('Pre-rendering routes')
      }

      const maxRouteLen = getMaxRouteLength(allRoutes)
      const padLen = Math.min(maxRouteLen + 2, 30)

      let successCount = 0
      let failCount = 0
      const failedRoutes: string[] = []

      const pLimit = await import('p-limit')
      const limit = pLimit.default(concurrency)

      const renderTasks = allRoutes.map((route) =>
        limit(async () => {
          const isShell = dynamicShellRoutes.includes(route)

          try {
            let html: string

            if (isShell) {
              // Dynamic route shells never invoke module.render() — they're
              // shells by design.
              html = renderShellHtml(htmlTemplate!)
            } else {
              try {
                html = await renderRoute(route, mainModule!, htmlTemplate!)
              } catch (renderError) {
                // A static route failed to pre-render. Rather than failing
                // the whole build, fall back to a shell for this route —
                // reusing the exact same template (and therefore the same
                // metadata) a dynamic shell would use.
                html = renderShellHtml(htmlTemplate!)
              }
            }

            const outputPath = route === '/'
              ? path.join(outDir, 'index.html')
              : path.join(outDir, route, 'index.html')

            await fs.mkdir(path.dirname(outputPath), { recursive: true })
            await fs.writeFile(outputPath, html)

            if (!quiet) {
              const paddedRoute = route.padEnd(padLen)
              const relPath = path.relative(process.cwd(), outputPath)
              log.ok(`${paddedRoute} → ${colors.dim}${relPath}${colors.reset}`)
            }
            successCount++
          } catch (error) {
            if (!quiet) {
              // Only log if not quiet
            }
            failCount++
            failedRoutes.push(route)
            hasFatalError = true
          }
        })
      )

      await Promise.all(renderTasks)

      const hasNotFoundRoute = routeTree.static.some(r => r === '/404' || r === '/not-found')
      if (options.fallback && !hasNotFoundRoute && mainModule && htmlTemplate) {
        try {
          const fallbackHtml = await renderRoute('/404', mainModule, htmlTemplate)
          const fallbackPath = path.join(outDir, '404.html')
          await fs.writeFile(fallbackPath, fallbackHtml)
        } catch (error) {
          failCount++
          hasFatalError = true
        }
      }

      await cleanupAssetStubLoader()

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

      if (!quiet) {
        console.log('')
        if (failCount === 0) {
          log.success(`${colors.green}${colors.bold}All ${successCount} routes pre-rendered successfully${colors.reset}`)
          log.detail(`Completed in ${colors.cyan}${elapsed}s${colors.reset}`)
        } else {
          // Error case - could log if needed
        }
        console.log('')
        log.info(`Output directory: ${colors.cyan}${path.resolve(outDir)}${colors.reset}`)
        console.log('')
      }

      if (hasFatalError && failOnError) {
        throw new Error(`${failCount} route(s) failed to pre-render`)
      }
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