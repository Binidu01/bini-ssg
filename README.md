# bini-ssg

<div align="center">

[![npm version](https://img.shields.io/npm/v/bini-ssg?color=00CFFF&labelColor=0a0a0a&style=flat-square)](https://www.npmjs.com/package/bini-ssg)
[![license](https://img.shields.io/badge/license-MIT-00CFFF?labelColor=0a0a0a&style=flat-square)](./LICENSE)
[![vite](https://img.shields.io/badge/vite-8-646cff?labelColor=0a0a0a&style=flat-square)](https://vitejs.dev)
[![react](https://img.shields.io/badge/react-18%2B-61dafb?labelColor=0a0a0a&style=flat-square)](https://react.dev)
[![typescript](https://img.shields.io/badge/typescript-ready-3178c6?labelColor=0a0a0a&style=flat-square)](https://www.typescriptlang.org)

**Static site generation for Bini.js — pre-renders your routes to HTML during `vite build`.**

Route discovery, link crawling, and shell fallbacks in a single Vite build plugin.
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
- [Options](#options)
- [Output layout](#output-layout)
- [HTML template merging](#html-template-merging)
- [Node runtime details](#node-runtime-details)
- [Hosting notes](#hosting-notes)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [License](#license)

---

## Features

- **Build-only plugin** — runs at `apply: 'build'`; it never touches `vite dev`.
- **Automatic route discovery** — static routes come straight from `bini-router`'s `generateRouteManifest()`.
- **Link crawling** — internal `<a href>` links found in rendered HTML are followed (up to `crawlDepth`), so dynamic URLs such as `/blog/hello-world` are fully pre-rendered whenever your pages link to them.
- **Shell fallback for dynamic patterns** — any dynamic pattern (`/blog/:slug`, `/docs/*`) that no crawled link matched still gets a client-rendered shell page, so it resolves to a real file on static hosts.
- **Real asset tags preserved** — output is built from Vite's own `dist/index.html`, so hashed CSS/JS tags stay intact.
- **Parser-based HTML merging** — the template is handled by [`node-html-parser`](https://www.npmjs.com/package/node-html-parser), so `<script>`/`<style>` content, comments, and nested markup can't throw off `#root` replacement.
- **Resilient rendering** — if `render()` throws for a route, that route falls back to a shell page and the build continues.
- **CI-friendly** — `failOnError` (default `true`) fails the build on discovery, module-load, and write errors.
- **Configurable concurrency** — sequential by default; opt in to parallel rendering via [`p-limit`](https://www.npmjs.com/package/p-limit).
- **Zero-config CSS/asset handling** — style and asset imports are stubbed out during the Node render pass.

> `bini-ssg` does **not** supply a `render()` implementation. You export one from `src/main.*` — see [Implementing `render()`](#implementing-render).

---

## What's new in 2.0

Compared with the 1.x releases:

- **Link crawling.** Internal links in rendered pages are followed up to the new `crawlDepth` option (default `3`). Dynamic URLs that your pages link to are now pre-rendered as full pages instead of shells.
- **Smarter shell fallback.** Shell pages are now written only for dynamic patterns that no rendered URL matched. `render()` is still never called for shells.
- **Real HTML parsing for `#root` replacement.** The hand-rolled depth counter and regexes were replaced with `node-html-parser`. The known `</div>`-inside-`<script>` edge case no longer applies.
- **Lighter dependencies.** Runtime dependencies are now `node-html-parser` and `p-limit`; `jsdom` is gone.
- **Clean process exit.** After a successful run the plugin calls `process.exit(0)` so the build can't hang on leftover loader-hook threads (see [Node runtime details](#node-runtime-details)).

---

## How it works

After Vite finishes its normal client bundle, `bini-ssg` runs in `closeBundle`:

1. **Discover** — reads `manifest.static` and `manifest.dynamic` from `bini-router` (collected in `buildStart`).
2. **Seed** — starts from every static route, plus `/` when `includeRoot` is enabled.
3. **Load** — imports `src/main.{tsx,jsx,ts,js}` in Node via `tsx` and reads `<outDir>/index.html` as the HTML template.
4. **Render + crawl** — calls `render(route)` for each queued route, merges the result into the template, writes `<route>/index.html`, then extracts internal links from that HTML and queues any it hasn't seen (until `crawlDepth` is reached).
5. **Shell fallback** — for each dynamic pattern that no rendered URL matched, writes a shell page at the pattern's `[param]` path.
6. **Optional `404.html`** — rendered when `fallback: true`.
7. **Exit** — once finished, the plugin calls `process.exit(0)` (see [Node runtime details](#node-runtime-details)).

The result is static, crawlable HTML for every reachable route (good for SEO and first paint), while your app still ships as a normal client-side React bundle.

---

## Requirements

| Dependency | Version | Notes |
| --- | --- | --- |
| Node.js | `>=18` (18.19+ / 20.6+ recommended) | Uses `module.register()` for loader hooks |
| Vite | `^8.0.0` | Peer dependency |
| `bini-router` | `>=2.0.0` | **Required** — there is no fallback route scanner |
| `react`, `react-dom` | `>=18` | Peer dependencies |
| `react-router-dom` | `>=6` | Peer dependency |
| `tsx` | `^4.0.0` | **Required** — loads your TS/JSX entry in Node, even in JS-only projects |

`node-html-parser` and `p-limit` are regular dependencies and are installed automatically.

---

## Installation

```bash
npm install --save-dev bini-ssg tsx
```

`bini-router` must already be installed and configured; `bini-ssg` imports it at build time to discover routes. `react`, `react-dom`, and `react-router-dom` are expected to be present as part of your bini-router app.

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

Links are **ignored** when they are:

- external (`https://…`), protocol-relative (`//…`), `mailto:`, `tel:`, or `javascript:`
- hash-only (`#section`)
- under `/assets/`, `/_next/`, or `/static/`
- file references by extension (images, fonts, media, `.css`, `.js`, `.map`, `.json`, `.xml`, `.txt`, `.pdf`, …)

Discovered links are normalized before queuing: query strings and hashes are stripped, a leading `/` is ensured, and trailing slashes are removed. Each URL is rendered at most once.

Set `crawlDepth: 0` to render only the seed routes and disable crawling.

### Shell fallback

After crawling, each pattern in `manifest.dynamic` is checked against the URLs that were actually rendered. If **no** rendered URL matches a pattern, `bini-ssg` writes a shell page for it:

```text
/blog/:slug  →  /blog/[slug]/index.html
/docs/*      →  /docs/[...slug]/index.html
```

A shell is your built `index.html` template with the `__BINI_SHELL__` marker added; `render()` is not called for it. The client app takes over on load and fetches or renders the real content.

If at least one crawled URL matched the pattern (e.g. `/blog/hello-world` for `/blog/:slug`), no shell is written for that pattern.

### What crawling can and can't see

- Crawling only sees links present in the **server-rendered HTML** returned by `render()`. Links that appear only after client-side data fetching are not discovered.
- Any internal link is rendered, whether or not it maps to a known route. A link to a URL your app doesn't recognize will be written as whatever your app renders for it (typically your not-found view).
- To pre-render a dynamic URL, make sure some rendered page links to it — for example, an index page listing every post.

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

`bini-ssg` reads `<outDir>/index.html` — the file Vite just produced, already containing your hashed CSS/JS tags — and uses it as the template for every page. The template is parsed with [`node-html-parser`](https://www.npmjs.com/package/node-html-parser), the rendered HTML is inserted, and the document is serialized back to a string.

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
- **A temporary asset-stub loader** resolves stylesheet imports (`.css`, `.scss`, `.sass`, `.less`, `.styl`) and static asset imports (images, fonts, audio/video) to empty stub modules, so `import './styles.css'` doesn't fail in Node. It only affects the Node-side render pass; your real built CSS/JS is untouched.

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

**Build succeeds but the process seems to stop early** — see the note on `process.exit(0)` under [Node runtime details](#node-runtime-details).

---

## Limitations

- **No dev-server preview.** The plugin does nothing under `vite dev`; run `vite build` (and optionally `vite preview`) to see pre-rendered output.
- **Dynamic URLs are discovered only by links.** There is no built-in way to enumerate param values from a CMS or database, and no option to explicitly list URLs to pre-render. Patterns with no linked URL get a shell.
- **`bini-router` is required.** There is no fallback file-system scanner.
- **`render()` is your responsibility**, as is choosing `createRoot` vs. `hydrateRoot` in the client entry.
- **The link extractor is regex-based.** It reads `<a href="…">` attributes from the rendered HTML string; it doesn't execute JavaScript or decode HTML entities in `href` values.

---

## License

MIT © [Binidu Ranasinghe](https://bini.js.org)