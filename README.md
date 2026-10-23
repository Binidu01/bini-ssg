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
- **Head hoisting.** `<title>`, `<meta>`, `<link>`, and JSON-LD `<script>` tags found in the HTML your `render()` returns are moved into `<head>`, replacing matching tags, so per-URL titles and tags work.
- **`document` attributes.** `document.html` and `document.body` attributes are applied to the `<html>` and `<body>` elements.
- **Route-scoped CSS.** CSS imported by a route's page and layouts is resolved to its hashed build output and linked on that route's page.
- **Real asset tags preserved.** Pages are built from Vite's own `dist/index.html`, so hashed CSS and JS tags stay intact.
- **`prerender = false`.** Routes that export `prerender = false` are skipped.
- **Hydration-safe minification.** Pages are minified with `html-minifier-terser` using a conservative configuration (comments are kept so React's markers survive).
- **Fail-fast rendering.** If `render()` throws for a route, the failure is reported, no page is written for that route, and the build fails once all routes have been processed. (The standard Bini.js entry only throws when `import.meta.env.DEV` is true; see [Error handling in this entry](#implementing-render).)
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

**SSR build.** The plugin redirects the SSR output to `dist/.bini/server` (without emptying `dist`, copying `public/`, or emitting assets) and names output files `[name].js`. The pre-render step loads `dist/.bini/server/main.js`, so **your SSR entry file must be named `main`** (for example `src/main.tsx`). When the SSR build closes without errors, the plugin runs the pre-render step:

1. Reads `dist/index.html` as the template. It must contain an element with `id="root"`.
2. Loads `bini-router` and calls `generateRouteManifest('src/app')`.
3. Imports the SSR bundle (`dist/.bini/server/main.js`) and checks that it exports `render()`.
4. **Seeds** the queue with every static route (except those with `prerender = false`), plus `/`.
5. **Renders and crawls.** For each queued route (one at a time, first in first out) it calls `render(route)`, merges the HTML into the template, applies that route's metadata and CSS, hoists head tags from the rendered HTML, minifies, and writes `<route>/index.html`. Internal links found in the rendered HTML are queued. If `render()` fails, the route is recorded as failed and no page is written.
6. **Shell fallback.** Writes shell pages for dynamic patterns that no rendered URL matched.
7. **404.** Writes `dist/404.html`.
8. **Report.** Prints the list of written pages. If any route failed, it prints the failures and throws.

`dist/.bini` (the SSR bundle and `css-map.json`) is **not** deleted afterwards; see [Output layout](#output-layout).

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
| SSR entry | A file named `main` (for example `src/main.tsx`) that exports `render()` |
| `react`, `react-dom` | 18 or later. The standard entry uses `renderToPipeableStream` |
| `react-router-dom` | Not used by `bini-ssg` itself. The standard entry imports `StaticRouter` from `react-router-dom`, which matches v7 |

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
- It must return (or resolve to) a non-empty HTML string, which becomes the contents of `<div id="root">`. A throw, a non-string result, or an empty string counts as a failure for that route.

The standard Bini.js entry gets its app, routes, and helpers from the `virtual:bini-app` module. This is the complete `src/main.tsx` used in Bini.js projects:

```tsx
// src/main.tsx
import React from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import App, {
  preloadRoute,
  routerReady,
  resetNavState,
  rootOptions,
  reportBiniError,
} from 'virtual:bini-app'

class LastResortBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      if (import.meta.env.DEV) return null
      return React.createElement(
        'div',
        {
          style: {
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2rem',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            textAlign: 'center',
          },
        },
        React.createElement(
          'h1',
          { style: { fontSize: '1.5rem', marginBottom: '1rem' } },
          'Something went wrong'
        ),
        React.createElement(
          'pre',
          {
            style: {
              fontSize: '0.75rem',
              maxWidth: '40rem',
              overflow: 'auto',
              padding: '0.75rem',
              border: '1px solid #ddd',
              borderRadius: '0.5rem',
              background: '#f9f9f9',
              textAlign: 'left',
            },
          },
          String(this.state.error.message || this.state.error)
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => this.setState({ error: null }),
            style: {
              marginTop: '1rem',
              padding: '0.75rem 2rem',
              borderRadius: '0.5rem',
              border: 'none',
              background: '#06b6d4',
              color: 'white',
              cursor: 'pointer',
            },
          },
          'Try again'
        )
      )
    }
    return this.props.children
  }
}

function Root({ children }) {
  return <LastResortBoundary>{children}</LastResortBoundary>
}

// ─── Client ──────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  const ssrFallbackRoot = document.querySelector('[data-bini-ssr-fallback]')
  const rootElement = ssrFallbackRoot ? null : document.getElementById('root')

  if (rootElement) {
    const isShell = window.__BINI_SHELL__ === true
    const bootShell = rootElement.querySelector('[data-bini-boot]') !== null
    const tree = (
      <Root>
        <App />
      </Root>
    )

    if (typeof resetNavState === 'function') resetNavState()

    const ready = Promise.race([
      preloadRoute(location.pathname).then(() => routerReady()),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]).catch((err) => {
      reportBiniError(err, '', 'uncaught')
    })

    void ready.then(() => {
      try {
        if (isShell || bootShell || !rootElement.hasChildNodes()) {
          createRoot(rootElement, rootOptions).render(tree)
        } else {
          hydrateRoot(rootElement, tree, rootOptions)
        }
      } catch (err) {
        reportBiniError(err, '', 'uncaught')
      }
    })
  }
}

export { App }

// ─── SSR (called by bini-ssg) ────────────────────────────────────────────

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export async function render(url) {
  const ReactDOMServer = await import('react-dom/server')
  const { createElement } = await import('react')
  const { StaticRouter } = await import('react-router-dom')
  const {
    AppRoutes,
    basename: rawBasename,
    preloadRoute: preload,
    resetNavState: reset,
  } = await import('virtual:bini-app')
  const { Writable } = await import('stream')

  if (typeof reset === 'function') reset()

  const basename = rawBasename

  const normalizedBase = basename === '/' ? '' : basename.replace(/\/$/, '')

  const routePath = url.startsWith('/') ? url : `/${url}`

  const fullUrl =
    normalizedBase && !routePath.startsWith(normalizedBase)
      ? `${normalizedBase}${routePath}`
      : routePath

  try {
    await preload(routePath)
  } catch {
    /* render anyway */
  }

  const fallbackPage = (error) => {
    const message = error instanceof Error ? error.message : String(error)
    return (
      `<!doctype html><html><head><meta charset="utf-8"><title>Server render error</title></head>` +
      `<body>` +
      `<div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem;font-family:system-ui,sans-serif;text-align:center">` +
      `<h1 style="font-size:1.5rem;margin:0 0 1rem">Server render error</h1>` +
      `<pre style="max-width:48rem;font-size:0.75rem;padding:0.75rem;border:1px solid #ddd;border-radius:0.5rem;background:#f9f9f9;overflow:auto;text-align:left">${escapeHtml(message)}</pre>` +
      `</div>` +
      `</body></html>`
    )
  }

  return new Promise((resolve, reject) => {
    let html = ''
    const writable = new Writable({
      write(chunk, _enc, callback) {
        html += chunk.toString()
        callback()
      },
    })

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const { pipe } = ReactDOMServer.renderToPipeableStream(
      createElement(StaticRouter, { location: fullUrl, basename }, createElement(AppRoutes)),
      {
        onAllReady() {
          writable.on('finish', () => finish(html))
          writable.on('error', (err) => {
            if (import.meta.env.DEV) {
              if (settled) return
              settled = true
              reject(err)
              return
            }
            finish(fallbackPage(err))
          })
          pipe(writable)
        },
        onShellError(err) {
          if (import.meta.env.DEV) {
            if (settled) return
            settled = true
            reject(err)
            return
          }
          finish(fallbackPage(err))
        },
        onError(_err) {},
      }
    )
  })
}

export async function renderLoading() {
  const app = await import('virtual:bini-app')
  if (typeof app.loadRootLoading !== 'function') return null
  const { renderToStaticMarkup } = await import('react-dom/server')
  const mod = await app.loadRootLoading()
  return renderToStaticMarkup(React.createElement(mod.default))
}
```

How the server side works:

- `render()` resets the navigation state, preloads the route's lazy modules (a failed preload is ignored), then renders `AppRoutes` inside a `StaticRouter` at the requested location, with the `basename` prefixed when needed.
- `onAllReady` waits for every Suspense boundary, so lazy pages are fully rendered into the HTML before the stream is collected.
- `bini-ssg` only calls `render()`. Other exports such as `renderLoading()` (which renders the root loading component to static markup, or returns `null` when there is none) are ignored by the plugin.

**Error handling in this entry.** When `import.meta.env.DEV` is true, a shell error or a stream error rejects, so `bini-ssg` sees a thrown error. In a normal production SSR build (`vite build --ssr`), those errors are caught and `render()` instead resolves with a full "Server render error" HTML document, and `onError` is a no-op, so errors inside Suspense boundaries are swallowed. `bini-ssg` cannot tell this from a successful render: no failure is reported, the fallback markup is placed in `#root`, and its `<title>Server render error</title>` is [hoisted](#head-tags-from-rendered-html-hoisting) into `<head>`. If you want a broken route to fail the build, make the two production branches reject instead of calling `finish(fallbackPage(err))`.

Other notes:

- The entry runs in the browser (the mount code) and in Node (`render()`), so guard anything that touches `window` or `document` at module scope.
- `render()` runs for every route in the **same loaded module**. Module-scope state (stores, caches) is shared between routes, which is why the entry calls `resetNavState()` first. Keep the output a pure function of `url`.
- Any entry works as long as it is named `main` and exports `render(url)`. For example, an entry built on React Router's `createStaticHandler` is also valid; loader redirects and 5xx loader errors should throw so the route is reported as failed.

---

## Client entry and hydration

`bini-ssg` writes two kinds of pages, and the client entry must treat them differently:

| Page type | `#root` contents | Client should |
| --- | --- | --- |
| Pre-rendered (static routes, crawled URLs, and `404.html` when its page rendered) | Server-rendered HTML | `hydrateRoot(...)` |
| Shell (dynamic-pattern fallbacks, and `404.html` when the not-found probe render fails) | Empty | `createRoot(...).render(...)` |

Shell pages get this marker appended to `<head>`:

```html
<script>window.__BINI_SHELL__=true;</script>
```

It is a plain inline script, not part of your `type="module"` entry, so it runs before the entry and the flag is set when the entry checks it. An entry that only looked at server HTML would otherwise try to hydrate an empty `#root` and throw a hydration mismatch (error #418).

`bini-ssg` only sets the flag. Your entry decides what to do with it. The standard Bini.js entry:

- mounts with `createRoot` when `window.__BINI_SHELL__ === true`, when `#root` contains a `[data-bini-boot]` element, or when `#root` has no child nodes, and with `hydrateRoot` otherwise;
- does not mount at all when a `[data-bini-ssr-fallback]` element is present (the `bini-overlay` SSR error page);
- preloads the current route's lazy modules and waits for `routerReady()` before mounting, giving up waiting after 10 seconds.

The shell marker is only added when the template has a `<head>`.

A route whose `render()` fails does not produce a shell page; it fails the build instead (see [Failure behavior](#failure-behavior)).

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

Every successfully rendered page has its rendered HTML scanned for `<a href>` links. New internal links are queued and rendered with `render(link)`. There is no depth limit; each URL is rendered at most once, and pages are processed one at a time.

Given a static `/blog` page whose HTML links to `/blog/hello-world` and `/blog/second-post`, both URLs are pre-rendered as full pages.

Relative links are resolved against a `<base href>` in the rendered HTML, or against `/` when there is none (not against the current page). Query strings and hashes are stripped, `.`/`..` segments and repeated slashes are collapsed, and any trailing slash is removed.

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

A shell is the built `index.html` with an empty `#root` and the `__BINI_SHELL__` marker; `render()` is not called for it. It gets the metadata and CSS of the parent route.

A shell is skipped when:

- some crawled URL matched the pattern (for example `/blog/hello-world` for `/blog/:slug`)
- the parent path was already rendered (for example `/blog` is a real page, so it is left as is). A catch-all such as `/docs/*` also counts as matched by `/docs` itself
- the parent path itself contains a dynamic segment
- the pattern exports `prerender = false`

### What crawling can and can't see

- Crawling only sees links in the server-rendered HTML returned by `render()`. Links added after client-side data fetching are not found.
- Any internal link is rendered, whether or not it maps to a known route. A link to an unknown URL is written as whatever your app renders for it, typically the not-found view.
- A crawled link whose `render()` throws is a failed route and **fails the build** (with the standard entry this only happens in dev builds, see [Implementing `render()`](#implementing-render)). Fix or remove such links, or mark the target `prerender = false`.
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
| `icons.icon`, `icons.shortcut`, `icons.apple` | `<link rel="icon">`, `<link rel="shortcut icon">`, `<link rel="apple-touch-icon">`. `icon` and `apple` entries also carry `type` and `sizes` when the tag is newly created |
| `openGraph` | Only when `openGraph.title` is set: `og:title`, `og:type` (default `website`), `og:description`, `og:url`, `og:site_name` (from `siteName`), and one `og:image` per entry of `images` (strings or `{ url, width, height, alt }`) or from `image` |
| `twitter` | Only when `twitter.title` is set: `twitter:card` (default `summary_large_image`), `twitter:title`, `twitter:description`, `twitter:creator`, and `twitter:image` from the first of `images` or `image` |

Rules:

- Existing `<meta name|property>` and `<link rel>` tags that match are updated in place. Keys with no value leave the template untouched.
- Link tags are matched by `rel` alone, so each `rel` produces a single tag. If several `icons` entries share a `rel`, the last one wins, and an existing tag only has its `href` updated.
- `og:image` (and its width, height, and alt) tags are always appended, not deduplicated against existing ones.
- Other metadata keys are ignored.
- Metadata is keyed by route **pattern**. Every crawled URL under `/blog/:slug` gets the same tags. For per-URL tags, render them from your page (see below).

### Head tags from rendered HTML (hoisting)

After the metadata is applied, `bini-ssg` re-parses the HTML your `render()` returned and moves these elements into `<head>`:

- every `<title>`, `<meta>`, and `<link>`
- every `<script type="application/ld+json">`

Within the rendered HTML, a later tag replaces an earlier one with the same key. Each hoisted tag also replaces a tag in `<head>` with the same key, so a page-rendered `<title>` or `<meta name="description">` overrides the one injected from metadata. Keys are:

| Element | Key |
| --- | --- |
| `<title>` | One title |
| `<meta>` | `name`, `property`, `http-equiv`, `charset`, or `id` (first one present). A `<meta>` with none of these is never deduplicated |
| `<link>` | `rel` plus `href`, so a rendered canonical with a different URL is added next to the injected one rather than replacing it |
| JSON-LD `<script>` | The first 64 characters of its content |

This is how per-URL titles and tags work for crawled dynamic routes. Note that the rendered HTML is re-serialized by `node-html-parser` during this step.

### `document` export

If the route (or its nearest layout) has an `export const document`, `bini-ssg` also applies:

- `document.html` and `document.body`: string attributes set on `<html>` and `<body>`. Existing attributes with the same name are **overwritten**, including `class`.
- `document.head`: the node tree is serialized to HTML and inserted just before `</head>`, after any hoisted tags. Elements get escaped attributes and text; void elements (`meta`, `link`, `img`, …) have no closing tag; attributes with an empty value are written bare (`async`). A `{ t: 'raw', value }` node is inserted verbatim.

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

For each page, the root element's contents are replaced with the rendered HTML (its own attributes are kept), metadata and CSS are applied, head tags are hoisted, and the document is serialized back to a string.

Every page is then minified with `html-minifier-terser` using this fixed configuration:

- `collapseWhitespace` with `conservativeCollapse`, so whitespace collapses to a single space and never disappears entirely, which keeps text nodes intact for hydration
- `removeComments: false`, which preserves React's `<!--$-->` markers
- `sortAttributes: false` and `sortClassName: false`
- `removeRedundantAttributes`, `removeEmptyAttributes`, `useShortDoctype`
- `minifyCSS` and `minifyJS` for inline `<style>` and `<script>`, with `processScripts` set to `text/javascript`, `application/javascript`, and `module`

If minification throws for a page, that page counts as a failed write and the build fails. Minification cannot be turned off.

---

## 404 page

`dist/404.html` is always written:

- If a route `/404` was rendered, its HTML is used (and `/404` is also written to `dist/404/index.html` like any other route).
- Otherwise `render('/__bini_not_found__')` is called and the result is used. If that throws or returns a non-string, a shell page is written instead, and this is **not** counted as a failure.

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
| Cleanup of `dist/.bini` | Never; the folder is kept |
| Logging | Always on |

The pre-render step reads and writes `dist/` under the current working directory, so keep Vite's `build.outDir` at its default and run the build from the project root.

### Failure behavior

- **Immediate errors:** `dist/index.html` missing, no `#root` in it, the SSR bundle missing or failing to import, no `render` export, or the bini-router manifest failing to load or scan. These throw straight away.
- **Collected failures:** a seeded or crawled route whose `render()` throws, returns a non-string, or returns an empty string; a route with an unsafe path segment; and any page that can't be written or minified (including shell pages and `404.html`). The other routes are still processed and written. Failures are listed under `FAILED`, then the build throws. No page is written for a route whose `render()` failed. Whether `render()` throws is up to your entry: the standard Bini.js entry resolves with a "Server render error" page instead of throwing in production builds.
- **Not failures:** a failed not-found probe render (it produces a shell `404.html`), and metadata or CSS lookups that throw (the page is written without them).

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
  .bini/
    css-map.json                ← source-to-hashed CSS map from the client build
    server/                     ← SSR bundle (main.js and chunks)
```

`dist/.bini` is not removed after the build. Delete it before deploying if you don't want the SSR bundle and CSS map published (for example `rm -rf dist/.bini`).

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
- Remove `dist/.bini` before uploading, unless you want it published.

---

## Troubleshooting

**`SSR bundle not found at …`**
The SSR build hasn't run, or the entry isn't named `main`. Run `vite build --ssr src/main.tsx` after `vite build`. The loader looks for `dist/.bini/server/main.js`.

**`dist/index.html not found`**
The client build hasn't run, or it ran after the SSR build and replaced the output. Run `vite build` first.

**`has no element with id="root"`**
The template needs `<div id="root"></div>`.

**`SSR bundle does not export render()`**
Your entry has no `render` export. See [Implementing `render()`](#implementing-render).

**`failed to load the SSR bundle`**
An import in your entry failed in Node. Check module-scope code that touches `window`, `document`, or browser-only libraries.

**`route(s) failed to prerender`**
Each failed route is listed with its error. For `render() failed: …`, call `render('/that-route')` from a script to reproduce it. Common causes are a custom entry that throws on a loader redirect or a 5xx loader error, or a crawled link to a URL your app can't render. A failed route writes no page.

**A page shows "Server render error"**
The standard Bini.js entry catches production render errors and returns a fallback page instead of throwing, so the build still succeeds. Look at the page's `<pre>` for the message, or temporarily make `render()` reject to get the full error and stack.

**Hydration error #418 on a page**
The page is a shell (a dynamic-pattern fallback or a fallback `404.html`), but the client called `hydrateRoot`. Check `window.__BINI_SHELL__` before choosing between `createRoot` and `hydrateRoot`.

**A dynamic URL wasn't pre-rendered**
No rendered page links to it, or the link only exists after client-side fetching. Link to it from a statically rendered page.

**Expected metadata or route CSS is missing**
Metadata and CSS lookups are skipped if `bini-router` throws for that route. CSS is also skipped when `css-map.json` is missing or a source path can't be matched to a hashed file. Check `getMetadataForRoute` and `getCssForRoute` for that route directly.

**A page-rendered tag didn't replace an injected one**
Hoisted tags replace by key (see [Head tags from rendered HTML](#head-tags-from-rendered-html-hoisting)). A `<link>` is keyed by `rel` plus `href`, and a `<meta>` with no `name`, `property`, `http-equiv`, `charset`, or `id` is never deduplicated.

**`No .bini/css-map.json found`**
The client build didn't emit the CSS map, or `dist/.bini` was deleted between the two builds.

**Output ended up in the wrong folder**
The pre-render step is fixed to `dist/` under the current working directory. Reset `build.outDir` to the default and run from the project root.

---

## License

MIT © [Binidu Ranasinghe](https://bini.js.org)