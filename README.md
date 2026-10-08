<div align="center">

# bini-ssg



[![npm version](https://img.shields.io/npm/v/bini-ssg?color=00CFFF&labelColor=0a0a0a&style=flat-square)](https://www.npmjs.com/package/bini-ssg)
[![license](https://img.shields.io/badge/license-MIT-00CFFF?labelColor=0a0a0a&style=flat-square)](./LICENSE)
[![vite](https://img.shields.io/badge/vite-8-646cff?labelColor=0a0a0a&style=flat-square)](https://vitejs.dev)
[![react](https://img.shields.io/badge/react-18%2B-61dafb?labelColor=0a0a0a&style=flat-square)](https://react.dev)
[![typescript](https://img.shields.io/badge/typescript-ready-3178c6?labelColor=0a0a0a&style=flat-square)](https://www.typescriptlang.org)

**Static site generation for Bini.js: pre-renders your routes to HTML after a client build and an SSR build.**

Route discovery, link crawling, head and CSS injection, shell fallbacks, a `404.html`, and minification in a single Vite plugin.

</div>

---

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Implementing `render()`](#implementing-render)
- [Client entry and hydration](#client-entry-and-hydration)
- [Route discovery and crawling](#route-discovery-and-crawling)
- [Metadata and head injection](#metadata-and-head-injection)
- [Route-scoped CSS](#route-scoped-css)
- [HTML template and minification](#html-template-and-minification)
- [404 page](#404-page)
- [Configuration](#configuration)
- [Output layout](#output-layout)
- [Programmatic API](#programmatic-api)
- [Hosting notes](#hosting-notes)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

- **Build-only plugin.** Registered with `apply: 'build'`; it never touches `vite dev`.
- **Automatic route discovery.** Static routes come from `bini-router`'s `generateRouteManifest()`.
- **Link crawling.** Internal `<a href>` links in rendered HTML are followed, so dynamic URLs such as `/blog/hello-world` are fully pre-rendered whenever a rendered page links to them. Links are extracted with `node-html-parser`.
- **Shell fallback for dynamic patterns.** A dynamic pattern (`/blog/:slug`, `/docs/*`) that no rendered URL matched gets a client-rendered shell page at its parent path, when that parent was not already rendered.
- **Vite-built SSR bundle.** `render()` runs from a real Vite SSR build of your entry, so CSS, asset, and `import.meta.env` handling is the same as in your client build. No `tsx` and no loader hooks.
- **Per-route head injection.** Title, description, robots, author, keywords, theme color, canonical and manifest links, icons, Open Graph, Twitter tags, and `document.head` content come from `bini-router`'s route manifest.
- **`document` attributes.** `document.html` and `document.body` attributes are applied to the `<html>` and `<body>` elements.
- **Route-scoped CSS.** CSS imported by a route's page and layouts is resolved to its hashed build output and linked on that route's page.
- **Real asset tags preserved.** Pages are built from Vite's own `dist/index.html`, so hashed CSS and JS tags stay intact.
- **`prerender = false`.** Routes that export `prerender = false` are skipped.
- **Hydration-safe minification.** Pages are minified with `html-minifier-terser` using a conservative configuration (comments are kept so React's markers survive).
- **Resilient rendering.** If `render()` throws for a route, that route falls back to a shell page and the build continues.
- **CI-friendly.** File write failures fail the build; a missing template, SSR bundle, or `render` export throws.
- **Zero configuration.** `biniSSG()` takes no options.

> `bini-ssg` does **not** supply a `render()` implementation. You export one from `src/main.*`; see [Implementing `render()`](#implementing-render).

---

## How it works

Pre-rendering needs two Vite builds, run in this order:

```bash
vite build                      # 1. client build
vite build --ssr src/main.tsx   # 2. SSR build, then pre-rendering runs
```

**Client build.** Vite writes `dist/index.html` and your assets. In `generateBundle` the plugin also records which hashed CSS files each source module ended up importing and emits that map as `dist/.bini/css-map.json`.

**SSR build.** The plugin redirects the SSR output to `dist/.bini/server` (without emptying `dist`, copying `public/`, or emitting assets) and names the entry `main.js`. When that build closes successfully, the plugin runs the pre-render step:

1. Reads `dist/index.html` as the template. It must contain an element with `id="root"`.
2. Loads `bini-router` and calls `generateRouteManifest('src/app')`.
3. Imports the SSR bundle (`dist/.bini/server/main.js`) and checks that it exports `render()`.
4. **Seeds** the queue with every static route (except those with `prerender = false`), plus `/`.
5. **Renders and crawls.** For each queued route it calls `render(route)`, merges the HTML into the template, applies that route's metadata and CSS, minifies, and writes `<route>/index.html`. Internal links found in the rendered HTML are queued.
6. **Shell fallback.** Writes shell pages for dynamic patterns that no rendered URL matched.
7. **404.** Writes `dist/404.html`.
8. **Cleanup.** Deletes `dist/.bini` (the SSR bundle and CSS map) when every page was written successfully.

The result is static, crawlable, metadata-complete HTML for every reachable route, while the app still ships as a normal client-side React bundle.

Wire both builds into one script:

```json
{
  "scripts": {
    "build": "vite build && vite build --ssr src/main.tsx"
  }
}
```

---

## Requirements

| Dependency | Notes |
| --- | --- |
| Node.js | Whatever your Vite 8 release requires |
| Vite | `^8.0.0` (peer dependency) |
| `bini-router` | **Required.** It must export `generateRouteManifest`, `getMetadataForRoute`, and `getCssForRoute`, and record the `prerender` export in manifest entries. There is no fallback route scanner |
| `react`, `react-dom` | 18 or later. The example entry uses `renderToPipeableStream` |
| `react-router-dom` | A version with the data-router static APIs (`createStaticHandler`, `createStaticRouter`, `StaticRouterProvider`). The example entry imports all three from `react-router-dom`, which matches v7 |

`node-html-parser` and `html-minifier-terser` are regular dependencies and install automatically.

---

## Installation

```bash
npm install --save-dev bini-ssg
```

`bini-router` must already be installed and configured; `bini-ssg` imports it at build time to discover routes and read per-route metadata and CSS.

---

## Quick start

**1. Register the plugin**

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { biniroute } from 'bini-router'
import { biniEnv } from 'bini-env'
import { biniSSG } from 'bini-ssg'

export default defineConfig({
  plugins: [
    react(),
    biniEnv(),
    biniroute(),
    biniSSG(),
  ],
})
```

**2. Export `render()` from your entry.** See the next section.

**3. Build**

```bash
vite build && vite build --ssr src/main.tsx
```

Pre-rendered HTML is written into `dist/`, next to the rest of your build output. Use `vite preview` to inspect it.

Example output:

```text
STEP Pre-rendering routes
  ok    /             → dist/index.html
  ok    /about        → dist/about/index.html
  ok    /blog         → dist/blog/index.html
  ok    /blog/hello   → dist/blog/hello/index.html
  ok    404.html      → dist/404.html

SUCCESS Pre-rendered 5 routes
  Completed in 1.84s

INFO Output directory: /path/to/project/dist
```

---

## Implementing `render()`

The SSR bundle must export:

```ts
export function render(url: string): Promise<string> | string
```

- `url` is the route being pre-rendered (`/`, `/about`, `/blog/hello-world`).
- It must return (or resolve to) an HTML string, which becomes the contents of `<div id="root">`. A non-string result is treated as a failure and the route falls back to a shell page.

The generated `src/App` from `bini-router` exports `routes` and `basename`, so the natural implementation uses React Router's static handler. This is a complete entry:

```tsx
// src/main.tsx
import React from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import {
  matchRoutes,
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from 'react-router-dom'
import App, { routes, basename as rawBasename } from './App'

const basename: string = rawBasename

// ─── Client ──────────────────────────────────────────────────────────────

// Routes that use `lazy` must be loaded before hydration, otherwise the router
// renders its hydrate fallback on first paint and mismatches the server HTML.
async function preloadLazyRoutes(): Promise<void> {
  const matches = matchRoutes(routes, window.location, basename) ?? []
  await Promise.all(
    matches.map(async (m) => {
      const lazy = m.route.lazy
      if (!lazy) return
      const loaded = await (lazy as () => Promise<Record<string, unknown>>)()
      Object.assign(m.route, { ...loaded, lazy: undefined })
    }),
  )
}

async function mount() {
  const rootElement = document.getElementById('root')
  if (!rootElement) return

  const isShell =
    (window as typeof window & { __BINI_SHELL__?: boolean }).__BINI_SHELL__ === true

  // shell or dev: there is no server-rendered HTML to hydrate
  if (isShell || import.meta.env.DEV) {
    createRoot(rootElement).render(<App />)
    return
  }

  await preloadLazyRoutes()
  hydrateRoot(rootElement, <App />)
}

if (typeof window !== 'undefined') {
  void mount()
}

// ─── SSR (called by bini-ssg) ────────────────────────────────────────────

function normalizeUrl(url: string): string {
  const normalizedBase = basename === '/' ? '' : basename.replace(/\/$/, '')
  const routePath = url.startsWith('/') ? url : `/${url}`

  if (
    normalizedBase &&
    !routePath.startsWith(`${normalizedBase}/`) &&
    routePath !== normalizedBase
  ) {
    return `${normalizedBase}${routePath}`
  }
  return routePath
}

let handler: ReturnType<typeof createStaticHandler> | undefined

export async function render(url: string): Promise<string> {
  const { renderToPipeableStream } = await import('react-dom/server')
  const { Writable } = await import('node:stream')

  handler ??= createStaticHandler(routes, { basename })

  const request = new Request(new URL(normalizeUrl(url), 'http://localhost'))
  const context = await handler.query(request)

  // a loader redirected (or returned a raw Response): there is no page to render
  if (context instanceof Response) {
    throw new Error(`${url} responded with ${context.status}`)
  }

  // 404 is fine (the 404.html probe relies on it); loader failures are not
  if (context.statusCode >= 500) {
    throw new Error(`${url} failed with status ${context.statusCode}`)
  }

  const router = createStaticRouter(handler.dataRoutes, context)

  return new Promise((resolve, reject) => {
    let html = ''
    let didError = false

    const writable = new Writable({
      write(chunk, _encoding, callback) {
        html += chunk.toString()
        callback()
      },
    })

    const { pipe } = renderToPipeableStream(
      // hydrate defaults to true: this writes window.__staticRouterHydrationData,
      // which createBrowserRouter in App.getRouter() reads, so loaders don't re-run
      <StaticRouterProvider router={router} context={context} />,
      {
        onAllReady() {
          pipe(writable)
          writable.once('finish', () => {
            if (didError) {
              reject(new Error('Bini.js SSR rendering failed.'))
              return
            }
            resolve(html)
          })
        },
        onShellError(error) {
          reject(error)
        },
        onError(error) {
          didError = true
          console.error('[Bini.js SSR]', error)
        },
      },
    )
  })
}

export { App }
```

Notes:

- On React Router v6, import `createStaticRouter` and `StaticRouterProvider` from `react-router-dom/server` instead.
- `onAllReady` waits for every Suspense boundary, so lazy pages are fully rendered into the HTML.
- The entry runs in the browser (the mount code) and in Node (`render()`), so guard anything that touches `window` or `document` at module scope.
- `render()` runs for every route in the **same loaded module**. Module-scope state (stores, caches, the cached `handler` above) is shared between routes, so keep the output a pure function of `url`.

---

## Client entry and hydration

`bini-ssg` writes two kinds of pages, and the client entry must treat them differently:

| Page type | `#root` contents | Client should |
| --- | --- | --- |
| Pre-rendered (static routes, crawled URLs, `404.html`) | Server-rendered HTML | `hydrateRoot(...)` |
| Shell (undiscovered dynamic patterns, or a route whose `render()` failed) | Empty | `createRoot(...).render(...)` |

Shell pages get this marker appended to `<head>`:

```html
<script>window.__BINI_SHELL__=true;</script>
```

It is a plain inline script, not part of your `type="module"` entry, so it runs before the entry and the flag is set when the entry checks it. Without it React would try to hydrate an empty `#root` and throw a hydration mismatch (error #418).

`bini-ssg` only sets the flag. Your entry decides what to do with it, as in the example above. The marker is only added when the template has a `<head>`.

---

## Route discovery and crawling

### Seeds

Routes come from `bini-router`:

```ts
const manifest = generateRouteManifest('src/app')
```

- **`manifest.static`** routes (no `:param` or `*` segments) seed the queue, except those exporting `prerender = false`.
- **`/`** is always added when it is not already a seed, even if its page exports `prerender = false`.
- **`manifest.dynamic`** routes can't be enumerated by `bini-ssg` and are handled by crawling and shell fallback.

### `prerender` export

A page can opt out:

```ts
// src/app/admin/page.tsx
export const prerender = false
```

- `false`: the route is not seeded, links to it are not followed, and a dynamic pattern with `false` gets no shell page.
- `'strict'` and `'fallback'`: accepted, and currently behave the same as leaving the export out.
- Any other value is reported with a warning and treated as unset.

### Link crawling

Every written page has its rendered HTML scanned for `<a href>` links. New internal links are queued and rendered with `render(link)`. There is no depth limit; each URL is rendered at most once, and pages are processed one at a time.

Given a static `/blog` page whose HTML links to `/blog/hello-world` and `/blog/second-post`, both URLs are pre-rendered as full pages.

Links are resolved against `<base href>` (or `/`), have query strings and hashes stripped, have `.`/`..` segments and repeated slashes collapsed, and lose any trailing slash.

Links are **ignored** when they are:

- external (`https://…`), protocol-relative (`//…`), `mailto:`, `tel:`, or `javascript:`
- hash-only (`#section`)
- under `/assets/`, `/_next/`, or `/static/`
- file references with one of these extensions: `png`, `jpg`, `jpeg`, `gif`, `svg`, `webp`, `avif`, `ico`, `css`, `js`, `mjs`, `map`, `woff`, `woff2`, `ttf`, `eot`, `mp4`, `webm`, `mp3`, `wav`, `pdf`, `xml`, `txt`, `json`
- routes whose metadata says `prerender = false`

### Shell fallback

After crawling, each dynamic pattern is checked against the URLs that were rendered. If none matches, `bini-ssg` writes a shell page at the pattern's **parent path**:

```text
/blog/:slug  →  /blog/index.html
/docs/*      →  /docs/index.html
```

A shell is the built `index.html` with the `__BINI_SHELL__` marker; `render()` is not called for it. It gets the metadata and CSS of the parent route.

A shell is skipped when:

- some crawled URL matched the pattern (for example `/blog/hello-world` for `/blog/:slug`)
- the parent path was already rendered (for example `/blog` is a real page, so it is left as is)
- the parent path itself contains a dynamic segment
- the pattern exports `prerender = false`

### What crawling can and can't see

- Crawling only sees links in the server-rendered HTML returned by `render()`. Links added after client-side data fetching are not found.
- Any internal link is rendered, whether or not it maps to a known route. A link to an unknown URL is written as whatever your app renders for it, typically the not-found view.
- To pre-render a dynamic URL, make sure some rendered page links to it, for example an index page listing every post.

---

## Metadata and head injection

For every page (pre-rendered, shell, and `404.html`), `bini-ssg` calls `getMetadataForRoute(manifest, route)` and merges the result into the page's `<head>`. Looking up metadata is best-effort: if `bini-router` throws, the page is written without it.

`bini-ssg` only consumes metadata. You author it with `export const metadata` in your pages and layouts, and `bini-router` merges it along the layout chain.

```tsx
// src/app/blog/page.tsx
export const metadata = {
  title: 'Blog',
  description: 'Notes on routing, SSG, and Vite.',
  robots: 'index, follow',
  author: 'Binidu Ranasinghe',
  keywords: ['ssg', 'vite', 'react'],
  canonical: 'https://example.com/blog',
  themeColor: '#0a0a0a',
  icons: {
    icon: [{ url: '/favicon.ico', sizes: '32x32' }],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  openGraph: {
    title: 'Blog',
    description: 'Notes on routing, SSG, and Vite.',
    type: 'website',
    url: 'https://example.com/blog',
    images: [{ url: 'https://example.com/og/blog.png', width: 1200, height: 630, alt: 'Blog' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Blog',
    creator: '@bini_js',
    images: ['https://example.com/og/blog.png'],
  },
}
```

### Keys applied

| Key | Output |
| --- | --- |
| `title` | `<title>` (updated in place, or inserted at the start of `<head>`) |
| `description`, `robots`, `author` (string), `keywords` (string, or array joined with `, `) | `<meta name="…">` |
| `themeColor` | `<meta name="theme-color">` |
| `canonical`, `manifest` | `<link rel="canonical">`, `<link rel="manifest">` |
| `icons.icon`, `icons.shortcut`, `icons.apple` | `<link rel="icon">`, `<link rel="shortcut icon">`, `<link rel="apple-touch-icon">`. `icon` and `apple` entries also carry `type` and `sizes` |
| `openGraph` | Only when `openGraph.title` is set: `og:title`, `og:type` (default `website`), `og:description`, `og:url`, `og:site_name` (from `siteName`), and one `og:image` per entry of `images` (strings or `{ url, width, height, alt }`) or from `image` |
| `twitter` | Only when `twitter.title` is set: `twitter:card` (default `summary_large_image`), `twitter:title`, `twitter:description`, `twitter:creator`, and `twitter:image` from the first of `images` or `image` |

Rules:

- Existing `<meta name|property>` and `<link rel>` tags that match are updated in place. Keys with no value leave the template untouched.
- `og:image` (and its width, height, and alt) tags are always appended, not deduplicated against existing ones.
- Other metadata keys are ignored.
- Metadata is keyed by route **pattern**. Every crawled URL under `/blog/:slug` gets the same tags. For per-URL tags (a different title per post), put them in the HTML your `render()` returns; `bini-ssg` won't remove tags you add beyond the ones it manages.

### `document` export

If the route (or its nearest layout) has an `export const document`, `bini-ssg` also applies:

- `document.html` and `document.body`: string attributes set on `<html>` and `<body>`. Existing attributes with the same name are **overwritten**, including `class`.
- `document.head`: the node tree is serialized to HTML and appended to the end of `<head>`. Elements get escaped attributes and text; void elements (`meta`, `link`, `img`, …) have no closing tag; attributes with an empty value are written bare (`async`). A `{ t: 'raw', value }` node is inserted verbatim. `bini-router` does not currently emit raw nodes from JSX; the type exists for trees built another way.

The serializer is exported as `headTreeToHtml(nodes)`.

---

## Route-scoped CSS

`getCssForRoute(manifest, route)` returns the CSS source paths a route imports through its page and layouts. `bini-ssg` maps each source path to the hashed file Vite emitted, using `dist/.bini/css-map.json` from the client build, and adds `<link rel="stylesheet">` tags for them.

- Matching tries the exact normalized path first, then a basename match (extension ignored) that must be unique. Paths are normalized to forward slashes and lowercase, so this behaves the same on Windows and POSIX.
- Unresolvable paths are skipped silently.
- Stylesheets already linked in `<head>` are not added twice.
- Injected `href`s are root-absolute (`/assets/…`) and do not include Vite's `base`.
- If `css-map.json` is missing, a warning is printed and no route-scoped CSS is injected.

---

## HTML template and minification

`bini-ssg` reads `dist/index.html`, the file the client build just produced with its hashed CSS and JS tags, and parses it with `node-html-parser`. The template must contain an element with `id="root"`; if it does not, pre-rendering throws.

For each page, the root element's contents are replaced with the rendered HTML (its own attributes are kept), metadata and CSS are applied, and the document is serialized back to a string.

Every page is then minified with `html-minifier-terser` using this fixed configuration:

- `collapseWhitespace` with `conservativeCollapse`, so whitespace collapses to a single space and never disappears entirely, which keeps text nodes intact for hydration
- `removeComments: false`, which preserves React's `<!--$-->` markers
- `sortAttributes: false` and `sortClassName: false`
- `removeRedundantAttributes`, `removeEmptyAttributes`, `useShortDoctype`
- `minifyCSS` and `minifyJS` for inline `<style>` and `<script>`

If minification throws for a page, that page counts as a failed write and the build fails. Minification cannot be turned off.

---

## 404 page

`dist/404.html` is always written:

- If a route `/404` was rendered, its HTML is used.
- Otherwise `render('/__bini_not_found__')` is called and the result is used. If that throws, a shell page is written instead.

`404.html` is the page for hosts that serve a static not-found file (Netlify, GitHub Pages).

---

## Configuration

`biniSSG()` takes **no options**. Behavior is fixed:

| Setting | Value |
| --- | --- |
| Routes directory | `src/app` (relative to `process.cwd()`) |
| Output directory | `dist` (relative to `process.cwd()`) |
| SSR entry | `main.js`, built into `dist/.bini/server` |
| Concurrency | Sequential, one route at a time |
| Crawl depth | Unlimited |
| Root route | Always rendered |
| `404.html` | Always written |
| Minification | Always on |
| Fail on error | Always on |
| Cleanup of `dist/.bini` | On success only |
| Logging | Always on |

The pre-render step reads and writes `dist/` under the current working directory, so keep Vite's `build.outDir` at its default.

### Failure behavior

- **Build-stopping errors:** `dist/index.html` missing, no `#root` in it, the SSR bundle missing or failing to import, no `render` export, or the bini-router manifest failing to load or scan. These throw.
- **Write failures:** any page that can't be written (including unsafe route segments and minifier errors) is collected and listed under `FAILED`, and the build then throws. `dist/.bini` is kept in that case.
- **`render()` failures:** a route whose `render()` throws or returns a non-string is **not** a build failure. It silently becomes a shell page.

---

## Output layout

```text
dist/
  index.html                    ← pre-rendered '/' (replaces Vite's client-only index.html)
  about/
    index.html                  ← pre-rendered static route
  blog/
    index.html                  ← pre-rendered static route
    hello-world/
      index.html                ← crawled dynamic URL
  docs/
    index.html                  ← shell, only when /docs/* matched no rendered URL and /docs wasn't rendered
  404.html
  assets/                       ← your normal Vite JS/CSS output, unchanged
  .bini/                        ← SSR bundle and css-map.json; removed after a successful run
```

Route output paths are built from decoded URL segments. Segments that are `.`, `..`, or contain `\ / : * ? " < > |` or a null byte are rejected, and a route can never write outside `dist`.

---

## Programmatic API

```ts
import { biniSSG, prerender, headTreeToHtml } from 'bini-ssg'
import type { PrerenderResult, HeadNode } from 'bini-ssg'
```

| Export | Description |
| --- | --- |
| `biniSSG()` (also the default export) | The Vite plugin. Takes no arguments |
| `prerender(): Promise<PrerenderResult>` | Runs the pre-render step directly against `./dist`. Requires a finished client build and SSR build. The plugin calls this for you |
| `headTreeToHtml(nodes: HeadNode[]): string` | Serializes a `document.head` node tree to HTML |
| `PrerenderResult` | `{ rendered: string[]; failed: Array<{ route: string; error: string }>; elapsedMs: number }`. `rendered` includes `404.html` and entries labelled `(shell)` |
| `HeadNode` | Re-exported from `bini-router` |

---

## Hosting notes

- Static hosts serve `about/index.html` for `/about`, so pre-rendered and crawled routes work without extra configuration.
- URLs that were never rendered (a blog slug no page links to, for example) have no file. Add a rewrite or SPA fallback for those patterns on your host, or link to them from a rendered page.
- Use the generated `404.html` on hosts that look for a top-level 404 file.
- Injected route CSS links are root-absolute, so deployments under a sub-path need the CSS tags checked.

---

## Troubleshooting

**`SSR bundle not found at …`**
The SSR build hasn't run. Run `vite build --ssr src/main.tsx` after `vite build`.

**`dist/index.html not found`**
The client build hasn't run, or it ran after the SSR build and replaced the output. Run `vite build` first.

**`has no element with id="root"`**
The template needs `<div id="root"></div>`.

**`SSR bundle does not export render()`**
Your entry has no `render` export. See [Implementing `render()`](#implementing-render).

**`failed to load the SSR bundle`**
An import in your entry failed in Node. Check module-scope code that touches `window`, `document`, or browser-only libraries.

**Hydration error #418 on a page**
The page is a shell (or a fallback from a failed `render()`), but the client called `hydrateRoot`. Check `window.__BINI_SHELL__` before choosing between `createRoot` and `hydrateRoot`.

**A route unexpectedly rendered as a shell**
`render()` threw, returned a non-string, hit a loader redirect, or got a status of 500 or more from a loader, and the plugin fell back silently. Call `render('/that-route')` from a script to see the error.

**A dynamic URL wasn't pre-rendered**
No rendered page links to it, or the link only exists after client-side fetching. Link to it from a statically rendered page.

**Expected metadata or route CSS is missing**
Metadata and CSS lookups are skipped if `bini-router` throws for that route. CSS is also skipped when `css-map.json` is missing or a source path can't be matched to a hashed file. Check `getMetadataForRoute` and `getCssForRoute` for that route directly.

**`No .bini/css-map.json found`**
The client build didn't emit the CSS map, or `dist/.bini` was deleted between the two builds.

**Output ended up in the wrong folder**
The pre-render step is fixed to `dist/`. Reset `build.outDir` to the default.

---

## License

MIT © [Binidu Ranasinghe](https://bini.js.org)