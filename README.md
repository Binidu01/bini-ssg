# bini-ssg

<div align="center">

[![npm version](https://img.shields.io/npm/v/bini-ssg?color=00CFFF&labelColor=0a0a0a&style=flat-square)](https://www.npmjs.com/package/bini-ssg)
[![license](https://img.shields.io/badge/license-MIT-00CFFF?labelColor=0a0a0a&style=flat-square)](./LICENSE)
[![vite](https://img.shields.io/badge/vite-8-646cff?labelColor=0a0a0a&style=flat-square)](https://vitejs.dev)
[![react](https://img.shields.io/badge/react-18%2B-61dafb?labelColor=0a0a0a&style=flat-square)](https://react.dev)
[![typescript](https://img.shields.io/badge/typescript-ready-3178c6?labelColor=0a0a0a&style=flat-square)](https://www.typescriptlang.org)

**Static site generation for Bini.js — pre-renders your routes to HTML during `vite build`.**

Route discovery, link crawling, metadata/CSS injection, and shell fallbacks in a single Vite build plugin.
No dev-server changes and no separate CLI.

</div>

---

## Table of contents

- [Features](#features)
- [What's new in 2.0](#whats-new-in-20)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Implementing `render()`](#implementing-render)
- [Client entry and hydration](#client-entry-and-hydration)
- [Route discovery and crawling](#route-discovery-and-crawling)
- [Metadata and CSS injection](#metadata-and-css-injection)
- [HTML minification](#html-minification)
- [Options](#options)
- [Output layout](#output-layout)
- [HTML template merging](#html-template-merging)
- [Node runtime details](#node-runtime-details)
- [Hosting notes](#hosting-notes)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

- **Build-only plugin** — runs at `apply: 'build'`; it never touches `vite dev`.
- **Automatic route discovery** — static routes come straight from `bini-router`'s `generateRouteManifest()`.
- **Link crawling** — internal `<a href>` links found in rendered HTML are followed (up to `crawlDepth`), so dynamic URLs such as `/blog/hello-world` are fully pre-rendered whenever your pages link to them. Extraction is parser-based (via `node-html-parser`), so it decodes HTML entities and resolves against `<base href>` correctly rather than pattern-matching raw markup.
- **Shell fallback for dynamic patterns** — any dynamic pattern (`/blog/:slug`, `/docs/*`) that no crawled link matched still gets a client-rendered shell page, so it resolves to a real file on static hosts.
- **Real asset tags preserved** — output is built from Vite's own `dist/index.html`, so hashed CSS/JS tags stay intact.
- **Per-route SEO metadata injection** — title, description, robots, canonical/manifest links, icons, Open Graph, and Twitter card tags are pulled from `bini-router`'s route metadata (`getMetadataForRoute`) and merged into each page's `<head>`, overwriting only the tags it knows about.
- **Structured `document.head` support** — arbitrary head content authored through `bini-router` (as a typed node tree, not raw strings) is serialized to HTML in exactly one place, with all text/attribute escaping centralized there. A `{ t: 'raw' }` node is the explicit, greppable opt-in for authors who need to inject unescaped markup (e.g. JSON-LD).
- **Route-scoped CSS injection** — CSS modules imported by a specific route (via `bini-router`'s `getCssForRoute`) are resolved to their hashed build output (captured from Vite's `generateBundle`) and injected as `<link rel="stylesheet">` tags on that route's page, deduplicated across shared imports.
- **Parser-based HTML merging** — the template is handled by [`node-html-parser`](https://www.npmjs.com/package/node-html-parser), so `<script>`/`<style>` content, comments, and nested markup can't throw off `#root` replacement or metadata injection.
- **Hydration-safe minification** — pre-rendered HTML is minified with [`html-minifier-terser`](https://www.npmjs.com/package/html-minifier-terser) by default, using a conservative whitespace-collapse configuration tuned to avoid React hydration mismatches. Toggle with `minify: false`.
- **Resilient rendering** — if `render()` throws for a route, that route falls back to a shell page and the build continues.
- **CI-friendly** — `failOnError` (default `true`) fails the build on discovery, module-load, and write errors.
- **Configurable concurrency** — sequential by default; opt in to parallel rendering via [`p-limit`](https://www.npmjs.com/package/p-limit).
- **Zero-config CSS/asset handling** — style and asset imports are stubbed out during the Node render pass, so `render()` can import your app's real component tree without a bundler.

> `bini-ssg` does **not** supply a `render()` implementation. You export one from `src/main.*` — see [Implementing `render()`](#implementing-render).

---

## What's new in 2.0

Compared with the 1.x releases:

- **Link crawling.** Internal links in rendered pages are followed up to the new `crawlDepth` option (default `3`). Dynamic URLs that your pages link to are now pre-rendered as full pages instead of shells.
- **Smarter shell fallback.** Shell pages are now written only for dynamic patterns that no rendered URL matched. `render()` is still never called for shells.
- **Per-route metadata and CSS injection.** `bini-router`'s route metadata (title, description, Open Graph/Twitter tags, icons, structured `document.head` content) and route-scoped CSS imports are now merged into every pre-rendered and shell page automatically.
- **Built-in HTML minification.** Output is minified by default with a hydration-safe configuration; disable via `minify: false`.
- **Real HTML parsing throughout.** `#root` replacement, metadata merging, and link extraction for crawling all moved to `node-html-parser` instead of hand-rolled regexes. The known `</div>`-inside-`<script>` edge case, and the older link extractor's blind spots around entity-encoded/unquoted `href` values and `<base href>`, no longer apply.
- **Lighter dependencies.** Runtime dependencies are now `node-html-parser`, `p-limit`, and `html-minifier-terser`; `jsdom` is gone.
- **Clean process exit.** After a successful run the plugin calls `process.exit(0)` so the build can't hang on leftover loader-hook threads (see [Node runtime details](#node-runtime-details)).

---

## How it works

After Vite finishes its normal client bundle, `bini-ssg` runs in `closeBundle` (with some bookkeeping in earlier hooks):

1. **Capture CSS** (`generateBundle`) — records, per source module, which hashed CSS files Vite emitted for it. This is what later lets route-scoped CSS imports be resolved to real output URLs.
2. **Discover** (`buildStart`) — reads `manifest.static` and `manifest.dynamic` from `bini-router`'s `generateRouteManifest()`.
3. **Seed** — starts from every static route, plus `/` when `includeRoot` is enabled.
4. **Load** — imports `src/main.{tsx,jsx,ts,js}` in Node via `tsx` and reads `<outDir>/index.html` as the HTML template.
5. **Render + crawl** — calls `render(route)` for each queued route, merges the result into the template, applies that route's metadata (`getMetadataForRoute`) and CSS (`getCssForRoute`) from `bini-router`, writes `<route>/index.html`, then extracts internal links from the rendered HTML and queues any it hasn't seen (until `crawlDepth` is reached).
6. **Shell fallback** — for each dynamic pattern that no rendered URL matched, writes a shell page at the pattern's `[param]` path, with the same metadata/CSS injection applied.
7. **Optional `404.html`** — rendered when `fallback: true`.
8. **Minify + write** — each page is optionally minified, then written to disk.
9. **Exit** — once finished, the plugin calls `process.exit(0)` (see [Node runtime details](#node-runtime-details)).

The result is static, crawlable, metadata-complete HTML for every reachable route (good for SEO and first paint), while your app still ships as a normal client-side React bundle.

---

## Requirements

| Dependency | Version | Notes |
| --- | --- | --- |
| Node.js | `>=18` (18.19+ / 20.6+ recommended) | Uses `module.register()` for loader hooks |
| Vite | `^8.0.0` | Peer dependency |
| `bini-router` | `>=2.0.0` | **Required** — there is no fallback route scanner, and route metadata/CSS resolution both come from it |
| `react`, `react-dom` | `>=18` | Peer dependencies |
| `react-router-dom` | `>=6` | Peer dependency |
| `tsx` | `^4.0.0` | **Required** — loads your TS/JSX entry in Node, even in JS-only projects |

`node-html-parser`, `p-limit`, and `html-minifier-terser` are regular dependencies and are installed automatically.

---

## Installation

```bash
npm install --save-dev bini-ssg tsx
```

`bini-router` must already be installed and configured; `bini-ssg` imports it at build time to discover routes and read per-route metadata/CSS. `react`, `react-dom`, and `react-router-dom` are expected to be present as part of your bini-router app.

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
    ...biniroute(),
    biniSSG(),
  ],
})
```

**2. Export `render()` from your entry** — see the next section.

**3. Build**

```bash
vite build
```

Pre-rendered HTML is written into your normal `build.outDir` (`dist` by default), next to the rest of your build output. Use `vite preview` to inspect it locally.

Example output:

```text
STEP Pre-rendering routes
  ok    /             → dist/index.html
  ok    /about        → dist/about/index.html
  ok    /blog         → dist/blog/index.html
  ok    /blog/hello   → dist/blog/hello/index.html

SUCCESS Pre-rendered 4 routes
  Completed in 1.84s
```

---

## Implementing `render()`

`bini-ssg` loads `src/main.{tsx,jsx,ts,js}` in Node and calls its `render` export once per route:

```ts
export function render(url: string): Promise<string> | string
```

- `url` is the route being pre-rendered (e.g. `/`, `/about`, `/blog/hello-world`).
- The return value (or resolved value) must be an HTML string. It is inserted into `<div id="root">…</div>`.

A typical implementation with React Router's `StaticRouter`:

```tsx
// src/main.tsx
import { createRoot, hydrateRoot } from 'react-dom/client'
import App from './App'

declare global {
  interface Window { __BINI_SHELL__?: boolean }
}

// ─── Client mount (browser only) ─────────────────────────────────────
if (typeof document !== 'undefined') {
  const container = document.getElementById('root')!

  if (window.__BINI_SHELL__ || !container.hasChildNodes()) {
    createRoot(container).render(<App />)   // shell or empty page → plain client render
  } else {
    hydrateRoot(container, <App />)         // pre-rendered page → hydrate
  }
}

// ─── SSG render (Node only, called by bini-ssg) ──────────────────────
export async function render(url: string): Promise<string> {
  const { renderToString } = await import('react-dom/server')
  const { StaticRouter } = await import('react-router-dom/server')
  const { AppRoutes } = await import('./App')

  return renderToString(
    <StaticRouter location={url}>
      <AppRoutes />
    </StaticRouter>
  )
}
```

This module executes in two environments: the browser (mount code) and Node via `tsx` (the `render()` export). Because your entry is imported in Node, anything that touches `window`/`document` at module scope must be guarded, as shown above.

### Keep `render()` pure

By default (`concurrency: 1`) routes render sequentially in the **same Node process and the same loaded module**. Module-scope state — stores created outside components, in-memory caches, counters — persists between routes and can leak from one page into another. Keep the output of `render()` a pure function of `url`.

---

## Client entry and hydration

`bini-ssg` writes two kinds of pages, and your client entry must treat them differently:

| Page type | `#root` contents | Client should |
| --- | --- | --- |
| Pre-rendered (static routes and crawled URLs) | Full server-rendered HTML | `hydrateRoot(...)` |
| Shell (undiscovered dynamic patterns, or a route whose `render()` threw) | Empty | `createRoot(...).render(...)` |

Shell pages get this marker injected into `<head>` (or right after `<body>` if there is no `<head>`):

```html
<script>window.__BINI_SHELL__=true;</script>
```

The marker is a plain inline script, not part of your `type="module"` entry, so it runs synchronously during parsing and is guaranteed to be set before your entry checks it. Without it, React would try to hydrate an empty `#root` and throw a hydration mismatch (error #418).

`bini-ssg` only sets the flag. Your `src/main.*` is responsible for branching on it, as in the example above.

---

## Route discovery and crawling

### Seeds

Routes come entirely from `bini-router`:

```ts
const manifest = generateRouteManifest(appDir)
```

- **`manifest.static`** — routes with no `:param` or `*` segments — seed the render queue automatically.
- **`includeRoot`** adds `/` to the seeds when it isn't already present.
- **`manifest.dynamic`** — routes containing `:param` or `*` — can't be enumerated by `bini-ssg` on its own. They are handled by crawling and shell fallback, below.

### Link crawling

Every page that is written has its rendered HTML scanned for `<a href>` links. New internal links are queued and rendered with `render(link)`, up to `crawlDepth` levels away from a seed.

Given a static `/blog` page whose rendered HTML links to `/blog/hello-world` and `/blog/second-post`, both URLs are pre-rendered as full pages — no shell involved.

Extraction runs through [`node-html-parser`](https://www.npmjs.com/package/node-html-parser) — the same parser used everywhere else in the plugin — rather than a regex, so it correctly handles:

- HTML entities in `href` values (`&amp;` decodes to `&`)
- single-quoted, double-quoted, and unquoted attribute values
- attribute values that themselves contain `>` or `<`
- an `<a>` sitting inside a `<script>` block or an HTML comment (ignored, since the parser understands raw-text and comment regions)
- a `<base href>` in the document, which relative links are resolved against before being queued

Links are **ignored** when they are:

- external (`https://…`), protocol-relative (`//…`), `mailto:`, `tel:`, or `javascript:`
- hash-only (`#section`)
- under `/assets/`, `/_next/`, or `/static/`
- file references by extension (images, fonts, media, `.css`, `.js`, `.mjs`, `.map`, `.json`, `.xml`, `.txt`, `.pdf`, …)

Discovered links are normalized before queuing: relative paths are resolved against `<base href>` (or `/` if there is none), `..`/`.` segments and repeated slashes are collapsed, query strings and hashes are stripped, and trailing slashes are removed. Each resolved URL is rendered at most once.

Set `crawlDepth: 0` to render only the seed routes and disable crawling.

### Shell fallback

After crawling, each pattern in `manifest.dynamic` is checked against the URLs that were actually rendered. If **no** rendered URL matches a pattern, `bini-ssg` writes a shell page for it:

```text
/blog/:slug  →  /blog/[slug]/index.html
/docs/*      →  /docs/[...slug]/index.html
```

A shell is your built `index.html` template with the `__BINI_SHELL__` marker added; `render()` is not called for it. The client app takes over on load and fetches or renders the real content. Shells still receive the same metadata and CSS injection as crawled routes under the same pattern (see below), since the pattern's layout chain is stable regardless of whether a specific URL under it was discovered.

If at least one crawled URL matched the pattern (e.g. `/blog/hello-world` for `/blog/:slug`), no shell is written for that pattern.

### What crawling can and can't see

- Crawling only sees links present in the **server-rendered HTML** returned by `render()`. Links that appear only after client-side data fetching are not discovered.
- Any internal link is rendered, whether or not it maps to a known route. A link to a URL your app doesn't recognize will be written as whatever your app renders for it (typically your not-found view).
- To pre-render a dynamic URL, make sure some rendered page links to it — for example, an index page listing every post.

---

## Metadata and CSS injection

Once a page's HTML is rendered and merged into the template, `bini-ssg` asks `bini-router` for that route's metadata and CSS, and applies both before the file is written. This runs for crawled/pre-rendered pages and for shell pages alike, and is best-effort — a failure here never fails the build.

`bini-ssg` only ever *consumes* metadata — it never invents it. The metadata itself is authored against `bini-router`'s route metadata API (in your route/layout files) and resolved by `generateRouteManifest()`; `bini-ssg` calls `getMetadataForRoute(manifest, route)` at write time and merges whatever comes back. See `bini-router`'s docs for the authoring API itself; this section only documents the shape `bini-ssg` knows how to apply.

### Defining metadata for a route

A route (or layout) exports a `metadata` object matching `RouteManifestEntry`. Anything you don't set is simply left out of the merge — existing tags in your `index.html` template are untouched.

```ts
// src/app/blog/[slug]/route.tsx
export const metadata = {
  title: 'How bini-ssg pre-renders routes',
  meta: {
    description: 'A look at link crawling, shells, and metadata injection.',
    robots: 'index, follow',
    author: 'Binidu Ranasinghe',
    keywords: ['ssg', 'vite', 'react'],
    canonical: 'https://example.com/blog/how-bini-ssg-works',
    themeColor: '#0a0a0a',
    icons: {
      icon: [{ url: '/favicon.ico', sizes: '32x32' }],
      apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
    },
    openGraph: {
      title: 'How bini-ssg pre-renders routes',
      description: 'A look at link crawling, shells, and metadata injection.',
      type: 'article',
      url: 'https://example.com/blog/how-bini-ssg-works',
      image: 'https://example.com/og/how-bini-ssg-works.png',
    },
    twitter: {
      card: 'summary_large_image',
      title: 'How bini-ssg pre-renders routes',
      description: 'A look at link crawling, shells, and metadata injection.',
      image: 'https://example.com/og/how-bini-ssg-works.png',
      creator: '@bini_js',
    },
  },
}
```

For **dynamic routes** (`/blog/:slug`), the metadata function/object is keyed by the route's pattern, not by each resolved URL — every crawled URL under that pattern, and the pattern's shell fallback if it's never discovered, receive the same metadata. If you need per-URL metadata (a different title for each blog post, for example), resolve it inside your `render()` implementation instead and write it directly into the HTML you return — `bini-ssg` will not overwrite tags that are already present and match a `name`/`property`/`rel` it manages, but it also won't remove or dedupe tags your own render pass adds beyond that set.

Layout-level metadata (set in a parent layout) is merged by `bini-router` before `bini-ssg` ever sees it — `getMetadataForRoute` returns the already-merged entry for a given route, so `bini-ssg` has no separate notion of layout inheritance.

### SEO metadata

`getMetadataForRoute(manifest, route)` returns an entry describing the route. `bini-ssg` uses it to set, without disturbing anything else already in `<head>`:

- `<title>` (top-level `title`, falling back to `meta.title`)
- `<meta name="description">`, `theme-color`, `robots`, `author`, `keywords` (accepts a string or an array, joined with `, `)
- `<link rel="canonical">` and `<link rel="manifest">`
- Icons: `<link rel="icon">`, `<link rel="shortcut icon">`, and `<link rel="apple-touch-icon">`, each with `type`/`sizes` when provided
- Open Graph tags (`og:title`, `og:type`, `og:description`, `og:url`, `og:image`) once a title is present
- Twitter card tags (`twitter:card`, `twitter:title`, `twitter:description`, `twitter:creator`, `twitter:image`) once a title is present

Existing tags matching the same `name`/`property`/`rel` are updated in place rather than duplicated; tags with no corresponding metadata are left untouched.

### Structured `document.head` content

Metadata entries can also carry a `document.head` node tree (produced by `bini-router`, not raw HTML strings). `bini-ssg` is the only place this tree is turned into markup — the router itself never generates HTML. Three node types are supported:

- `{ t: 'element', tag, attrs, children }` — serialized with attribute/text escaping applied
- `{ t: 'text', value }` — escaped text content
- `{ t: 'raw', value }` — inserted verbatim; the explicit opt-in for content you've already prepared as HTML (e.g. JSON-LD `<script>` blocks)

`document.html` and `document.body` maps, if present on the metadata entry, are applied as attributes on the `<html>` and `<body>` elements.

### Route-scoped CSS

`getCssForRoute(manifest, route)` returns the source CSS file paths a route depends on (for example, CSS imported by a layout that only some routes use). `bini-ssg` resolves each source path to the hashed output URL(s) Vite emitted for it — using the map captured in `generateBundle` — and injects `<link rel="stylesheet">` tags for them, deduplicated across pages that share the same CSS.

Resolution tries an exact normalized path match first, then falls back to a basename match; both sides of the comparison are normalized to forward slashes and lowercase so this works the same on Windows and POSIX filesystems. If a source path can't be resolved to a build output at all, it's silently skipped rather than failing the page.

---

## HTML minification

By default, every page `bini-ssg` writes — pre-rendered, shell, or `404.html` — is minified with `html-minifier-terser` before it hits disk. The configuration is deliberately conservative:

- `collapseWhitespace` + `conservativeCollapse` — whitespace is always collapsed to a single space, never removed entirely, which is what keeps text nodes intact for React hydration.
- `removeComments: false` — preserves React's `<!--$-->` streaming/boundary markers.
- `sortAttributes: false` / `sortClassName: false` — attribute and class order is left alone, since React compares props/classes during hydration.
- `minifyCSS` / `minifyJS` — inline `<style>`/`<script>` content is minified too.

If minification throws for a given page (malformed author HTML, for instance), `bini-ssg` ships the original unminified HTML for that page rather than failing the build. A warning is printed to the console the first time this happens in a given build (`[bini-ssg] HTML minification failed; falling back to unminified output. …`), so a systematically broken minifier configuration is still visible — it isn't logged again for every subsequent page.

Set `minify: false` to disable this entirely and write the merged HTML as-is.

---

## Options

```ts
biniSSG({
  appDir      : 'src/app',
  outputDir   : undefined,
  includeRoot : true,
  fallback    : false,
  crawlDepth  : 3,
  concurrency : 1,
  failOnError : true,
  quiet       : false,
  verbose     : true,
  minify      : true,
})
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `appDir` | `string` | `'src/app'` | Directory passed to `bini-router`'s `generateRouteManifest()`, resolved from `process.cwd()`. |
| `outputDir` | `string` | Vite `build.outDir` (`dist`) | Where pre-rendered HTML is written. |
| `includeRoot` | `boolean` | `true` | Seed `/` even if `bini-router` didn't report it. Set `false` if `/` is handled another way (e.g. it is itself a dynamic route). |
| `fallback` | `boolean` | `false` | Also render `/404` and write it to `<outDir>/404.html`, for hosts that serve a static 404 page (Netlify, GitHub Pages). Skipped when a static `/404` or `/not-found` route already exists. |
| `crawlDepth` | `number` | `3` | Maximum link-following depth from the seed routes. `0` disables crawling. |
| `concurrency` | `number` | `1` | Number of routes processed in parallel (through `p-limit`). Raise it only once you've confirmed `render()` has no shared module-scope state. |
| `failOnError` | `boolean` | `true` | Fail `vite build` on route discovery, app-module load, or file-write errors. See below. |
| `quiet` | `boolean` | `false` | Suppress all output. |
| `verbose` | `boolean` | `true` | Accepted for compatibility. Per-route progress is currently controlled by `quiet`. |
| `minify` | `boolean` | `true` | Minify each written page with `html-minifier-terser`, using a hydration-safe configuration. See [HTML minification](#html-minification). |

### `failOnError`

When `true` (the default), the build exits non-zero for:

- **Route discovery failures** — `bini-router` can't be loaded, or its manifest throws (for example a `RouteConflictError` or `CircularLayoutError`). Raised in `buildStart`.
- **App module failures** — `src/main.*` can't be found, fails to import, or doesn't export `render`. Raised in `closeBundle`, even for projects made up only of dynamic routes.
- **Write failures** — any route's file can't be written, or `404.html` fails. Reported at the end as `N route(s) failed to pre-render`.

A `render()` call that **throws** is deliberately *not* one of these: that route falls back to a shell page and the build continues.

Set `failOnError: false` only if you want the plain client-side bundle to ship even when pre-rendering fails outright.

### `concurrency`

Routes are processed one at a time by default. This is the safe choice because every `render()` call runs against a single loaded copy of your app module. Increase it for faster builds only if your app has no module-scope mutable state that could bleed between concurrent renders.

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
      index.html                ← crawled dynamic URL (fully pre-rendered)
  docs/
    [...slug]/
      index.html                ← shell — only when no crawled URL matched /docs/*
  404.html                      ← only when `fallback: true`
  assets/                       ← your normal Vite JS/CSS output, unchanged
```

Routes are deduplicated before rendering, so a route reachable through several paths (seed, `includeRoot`, multiple links) is rendered and written once.

---

## HTML template merging

`bini-ssg` reads `<outDir>/index.html` — the file Vite just produced, already containing your hashed CSS/JS tags — and uses it as the template for every page. The template is parsed with [`node-html-parser`](https://www.npmjs.com/package/node-html-parser), the rendered HTML is inserted, metadata and route CSS are applied, and the document is serialized back to a string before optional minification.

- If an element with `id="root"` exists, its inner content is replaced with the rendered HTML. The element's own attributes (`class`, `data-*`, …) are kept, and a self-closing `<div id="root" />` is handled too.
- If there is no `#root`, `<div id="root">…</div>` is inserted at the start of `<body>`.
- If there is no `<body>` either, the `#root` div is prepended to the document. This only happens with a malformed `index.html`.
- Raw-text regions such as `<script>` and `<style>`, comments, and the doctype are handled by the parser rather than by pattern matching, so a literal `</div>` inside a `<script>` block in your rendered output no longer breaks the merge.
- Shell pages get the `__BINI_SHELL__` marker injected first (just before `</head>`, or after `<body>` if there is no head), then the same `#root` handling: an existing `#root` is left as-is, otherwise an empty one is added.
- If `<outDir>/index.html` doesn't exist when the plugin runs, a minimal built-in HTML document is used instead — you'd lose your real CSS/JS tags for that build. In a normal setup Vite writes `index.html` before `closeBundle`, so this doesn't occur.

Because the document is re-serialized, markup in the template and in your rendered HTML may be lightly normalized (for example an empty nested `<div/>` is written as `<div></div>`). It stays equivalent HTML.

---

## Node runtime details

Because `render()` runs in Node and your entry is imported directly (not through Vite's browser bundler), `bini-ssg` registers two loader hooks before importing it:

- **`tsx`** compiles TS/JSX on the fly so Node can import your source. This is why `tsx` is required even in JavaScript projects.
- **A temporary asset-stub loader** resolves stylesheet imports (`.css`, `.scss`, `.sass`, `.less`, `.styl`) and static asset imports (images, fonts, audio/video) to empty stub modules, so `import './styles.css'` doesn't fail in Node. It only affects the Node-side render pass; your real built CSS/JS — including the hashed files resolved for route-scoped CSS injection — is untouched.

You don't need to configure either. Notes:

- Node loader hooks can't be unregistered once added, so registration happens once per process. The temporary file backing the stub loader is deleted at the end of every build.
- **Process exit.** After pre-rendering completes successfully, `bini-ssg` calls `process.exit(0)`. `module.register()` starts a loader-hook worker thread that isn't torn down on its own, which can leave the build process hanging on some runtimes (observed on Deno Deploy's Node compatibility layer). If you drive `vite build` from a longer script, or rely on other plugins' `closeBundle` hooks running *after* `bini-ssg`, be aware the process ends here.
- **`import.meta.env` is not populated during the Node render pass**, because the app module is loaded by `tsx` rather than Vite's pipeline. Code that reads `import.meta.env.*` at module scope (for example initializing a Firebase client on import) can crash pre-rendering. Initialize such clients lazily, or guard them so they only run in the browser.

---

## Hosting notes

- Static hosts serve `about/index.html` for `/about` out of the box, so pre-rendered routes and crawled dynamic URLs work without extra configuration.
- Shell pages live in literal `[param]` directories (for example `/blog/[slug]/index.html`). Hosts won't map `/blog/some-post` onto that path by themselves — add a rewrite or SPA-fallback rule for those patterns on your platform.
- Use `fallback: true` for hosts that look for a top-level `404.html`.

---

## Troubleshooting

**`Failed to load bini-router manifest`** — `bini-router` isn't installed or resolvable, or it threw while scanning `appDir`. Check that `appDir` points at your routes directory.

**`File … must export a render(url) function`** — `src/main.*` loaded but has no `render` export. Add it as described in [Implementing `render()`](#implementing-render).

**`Failed to load …/src/main.tsx`** — an import in your entry failed under Node. Confirm `tsx` is installed and check that module-scope code doesn't rely on browser globals or `import.meta.env`.

**Hydration error #418 on a page** — the page is a shell (or a fallback from a failed `render()`), but the client called `hydrateRoot`. Make sure your entry checks `window.__BINI_SHELL__` before choosing between `createRoot` and `hydrateRoot`.

**A route unexpectedly rendered as a shell** — `render()` threw for that URL, and the plugin silently fell back. Call `render('/that-route')` directly in a script to see the error.

**A dynamic URL wasn't pre-rendered** — no rendered page links to it, or the link exists only after client-side fetching. Link to it from a statically rendered page, or accept the shell fallback.

**Expected metadata or a route-scoped stylesheet is missing from a page** — metadata/CSS injection is best-effort and silently skipped if `bini-router` throws while resolving it for that route, or if a source CSS path can't be matched to a hashed build output. Verify `getMetadataForRoute`/`getCssForRoute` return what you expect for that route directly.

**Build succeeds but the process seems to stop early** — see the note on `process.exit(0)` under [Node runtime details](#node-runtime-details).

---

## License

MIT © [Binidu Ranasinghe](https://bini.js.org)