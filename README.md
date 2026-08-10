# bini-ssg

<div align="center">

[![npm version](https://img.shields.io/npm/v/bini-ssg?color=00CFFF&labelColor=0a0a0a&style=flat-square)](https://www.npmjs.com/package/bini-ssg)
[![license](https://img.shields.io/badge/license-MIT-00CFFF?labelColor=0a0a0a&style=flat-square)](./LICENSE)
[![vite](https://img.shields.io/badge/vite-4--8-646cff?labelColor=0a0a0a&style=flat-square)](https://vitejs.dev)
[![react](https://img.shields.io/badge/react-18%2B-61dafb?labelColor=0a0a0a&style=flat-square)](https://react.dev)
[![typescript](https://img.shields.io/badge/typescript-ready-3178c6?labelColor=0a0a0a&style=flat-square)](https://www.typescriptlang.org)

**Pre-renders your bini-router routes to static HTML during `vite build`.**
No dev-server behavior change, no separate CLI — it's a Vite build plugin that runs after your normal bundle is produced.

</div>

---

## What it does

`bini-ssg` runs at `apply: 'build'`, so it's only active during `vite build` — it does nothing during `vite dev`. After Vite finishes its normal client bundle, `bini-ssg`:

1. Reads your route list from `bini-router`'s `generateRouteManifest()` (a **required** peer dependency — there is no fallback route scanner).
2. Loads `src/main.{tsx,jsx,ts,js}` directly in Node (via `tsx`, also required) and expects it to export a `render(url)` function.
3. Calls `render(route)` for **every** discovered route — static routes and, internally, the shell route generated for each dynamic route pattern too (see [How routes are discovered](#how-routes-are-discovered)) — though for shell routes the returned HTML is discarded rather than written out.
4. For non-shell routes, injects the returned HTML string into the `#root` div of your already-built `<outDir>/index.html` (so the pre-rendered pages keep the real, hashed CSS/JS `<link>`/`<script>` tags Vite generated).
5. Writes one `index.html` per route into your output directory, deduplicating any overlapping route paths first.

This gets you static, crawlable HTML per route (good for SEO and first paint) while still shipping a normal client-side React app that hydrates/takes over after load.

> `bini-ssg` does **not** provide a `render()` implementation for you. You write it — see [Your `render()` function](#your-render-function) below.

---

## Install

```bash
npm install --save-dev bini-ssg tsx
```

`bini-router` must already be installed and configured in your project (`bini-ssg` imports it at build time to discover routes — this is not optional). `react`, `react-dom`, and `react-router-dom` are expected to already be present as part of your bini-router app.

---

## Setup

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

Order matters here in one sense only: `biniSSG()` reads `<outDir>/index.html` and your final bundle in `closeBundle`, so it needs to run as part of the same `vite build` that produces that output — which is the normal case when it's just listed in `plugins` like above.

```bash
vite build
```

Static HTML files land in your normal `build.outDir` (`dist` by default) alongside the rest of your build output.

---

## Your `render()` function

`bini-ssg` loads `src/main.{tsx,jsx,ts,js}` in Node and calls the `render` export for every route:

```ts
export function render(url: string): Promise<string> | string
```

- `url` is the route path being pre-rendered (e.g. `/`, `/about`, `/blog/hello-world`).
- The return value (or resolved value, if a `Promise`) must be an HTML string — this is inserted directly into `<div id="root">...</div>` in the output file for static routes. For dynamic-pattern shell routes, `render()` is still invoked (see below) but its return value is thrown away.

A typical implementation uses `react-dom/server` and React Router's `StaticRouter` around your existing `App`:

```tsx
// src/main.tsx
import { createRoot } from 'react-dom/client'
import App from './App'

// ─── Client mount (used by the browser) ───────────────────────────────
createRoot(document.getElementById('root')!).render(<App />)

// ─── SSG render (used by bini-ssg, Node-only) ─────────────────────────
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

> This file runs in two different environments: the browser (for the `createRoot(...).render(...)` call) and Node, via `tsx`, for the `render()` export (called by `bini-ssg` for every route it processes — static and shell alike — never shipped to the client). Keep anything browser-only (e.g. `window`/`document` access outside of the mount call) out of the code path `render()` actually executes, since it runs before any DOM exists.

### Why this matters for correctness

`render()` is called once per route — including dynamic-pattern shell routes, whose output is simply discarded afterward — and by default (see `concurrency` below) sequentially in the *same* Node process and the *same* loaded module. If your app (or a library it uses) keeps state at module scope — a store created outside a component, an in-memory cache, a module-level counter — that state persists and can leak between routes. Keep `render()`'s output a pure function of the `url` argument wherever possible, and be aware that side effects in `render()` (logging, writes, throwing on unexpected input) will fire for shell routes too, even though their HTML is never used.

---

## How routes are discovered

Routes come entirely from `bini-router`:

```ts
const { generateRouteManifest } = await import('bini-router')
const manifest = generateRouteManifest(appDir)
```

- **`manifest.static`** — routes with no `:param`/`*` segments — are pre-rendered automatically, no configuration needed. `render()` is called with the real route and the full rendered HTML is written out.
- **`manifest.dynamic`** — routes containing `:param` or `*` — can't be enumerated automatically (`bini-ssg` has no way to know which param values are valid), so instead of skipping them, `bini-ssg` auto-generates a **shell page** for each dynamic pattern: the route

  ```
  /blog/:slug
  /docs/*
  ```

  becomes shell routes written to

  ```
  /blog/[slug]/index.html
  /docs/[...slug]/index.html
  ```

  A shell page's output is just your built `<outDir>/index.html` template as-is — the idea being your client app takes over and fetches/renders the real content once it hydrates, so the route at least resolves to a real file for static hosts instead of 404ing. Note that `render(route)` is still **called** internally for each shell route (it runs through the same code path and the same `concurrency` limit as a fully-rendered route); only its returned HTML is discarded rather than written out.

  There is currently no option to fully pre-render a specific dynamic URL (e.g. get real HTML for `/blog/hello-world` instead of a shell) — every route matching a `manifest.dynamic` pattern always gets a shell page.

If `bini-router` can't be loaded or its manifest generation throws (e.g. a real `RouteConflictError`/`CircularLayoutError` from bini-router itself), `bini-ssg` fails the build by default — see `failOnError`.

---

## Options

```ts
biniSSG({
  appDir      : 'src/app',   // Passed to bini-router's generateRouteManifest. Default: 'src/app'
  outputDir   : undefined,   // Where to write pre-rendered HTML. Default: your Vite build.outDir (usually 'dist')
  includeRoot : true,        // Ensure '/' is pre-rendered even if it wasn't discovered or otherwise
                              //   included in the route list. Set false to disable this fallback.
  fallback    : false,       // Also render '/404' and write it to '<outDir>/404.html', for hosts that
                              //   serve a static 404 page (e.g. Netlify, GitHub Pages). Skipped if a
                              //   '/404' or '/not-found' static route already exists.
  concurrency : 1,           // How many routes to render in parallel. Default: 1 (fully sequential).
                              //   Applies to every route bini-ssg processes, including dynamic-pattern
                              //   shells — render() is invoked for those too, just with its output
                              //   discarded. Only raise this if render() and everything it touches has
                              //   no shared mutable module-level state — see "Why this matters for
                              //   correctness" above.
  failOnError : true,        // Throw (failing `vite build`) if route discovery fails, the app module
                              //   can't be loaded, or any route fails to render. Default: true.
  verbose     : true,        // Print per-route progress and discovery details. Default: true.
  quiet       : false,       // Suppress all output. Default: false.
})
```

### `includeRoot`

Defaults to `true`. After static and shell routes are collected, `bini-ssg` checks whether `/` is anywhere in that list — if not, it's added. This runs regardless of how many other routes exist; it's not just a fallback for an otherwise-empty route list. Set to `false` if you genuinely don't want a pre-rendered home page (e.g. `/` is itself a dynamic/shell route you're handling another way).

### `failOnError`

Defaults to `true`. When something goes wrong — `bini-router`'s manifest can't be generated, `src/main.*` can't be found or doesn't export `render`, or any individual route fails during rendering — `bini-ssg` throws at the end of `closeBundle`, which makes `vite build` exit non-zero. This is deliberate: a CI pipeline should fail loudly on a broken or partially-rendered site rather than silently shipping it. Set `failOnError: false` only if you specifically want the plain client-side bundle to still ship when pre-rendering fails (failures are still logged either way).

### `concurrency`

Defaults to `1` — routes render one at a time, in order, in the same Node process. This is the safe default because `render()` runs against a single loaded copy of your app module; anything with shared mutable state at module scope (stores, caches, counters) can behave inconsistently if multiple routes render at once. This applies to shell routes exactly as much as static ones, since `render()` is called for both. Raise `concurrency` for faster builds only once you've confirmed `render()` has no such shared state — rendering is parallelized internally via [`p-limit`](https://www.npmjs.com/package/p-limit).

---

## HTML template merging

`bini-ssg` reads `<outDir>/index.html` (the file Vite itself just built, already containing your real hashed CSS/JS tags) and uses it as the template for every pre-rendered route:

- If it finds a tag matching `<div id="root" ...>` (with any other attributes, including a self-closing `<div id="root" />`), its contents are replaced with your rendered HTML.
- If no such div exists, the rendered HTML is injected as a new `<div id="root">` immediately after the opening `<body>` tag.
- If neither a `#root` div nor a `<body>` tag can be found in the template, the output file falls back to being just the bare `<div id="root">...</div>` fragment — with no surrounding `<html>`/`<head>`/`<body>`. This only happens if your `index.html` is missing or malformed; a normal Vite + React project won't hit this path.
- Shell pages skip this merge step — the template is used as-is (a root div is injected only if one isn't already present). `render()` is still called for these routes beforehand (see [How routes are discovered](#how-routes-are-discovered)); its returned HTML is simply never inserted anywhere.

Matching the end of the `#root` div uses tag-depth counting rather than a naive first-match, so nested `<div>`s inside your rendered content (including nested self-closing ones) don't cause the wrong closing tag to be picked. This isn't a full HTML parser, though — a literal `</div>` appearing inside a `<script>` block in your rendered output is a known edge case that can throw off the match; this doesn't come up in normal React output.

If `<outDir>/index.html` doesn't exist yet when `bini-ssg` runs (e.g. run out of order, or the build was configured not to emit it), a minimal built-in HTML shell is used instead — which means you'd lose your real CSS/JS tags for that build. In normal setups (plugin listed in `vite.config.ts` as shown above) this won't occur, since Vite writes `index.html` before `closeBundle` fires.

---

## Output layout

```
dist/
  index.html                   ← pre-rendered '/' (overwrites the client-only shell — see includeRoot)
  about/
    index.html                  ← pre-rendered /about (static route)
  blog/
    [slug]/
      index.html                 ← shell page for /blog/:slug (template used as-is; render() ran but its output was discarded)
  docs/
    [...slug]/
      index.html                 ← shell page for /docs/* (template used as-is; render() ran but its output was discarded)
  404.html                      ← only written if `fallback: true`
  assets/                        ← your normal Vite JS/CSS output, unchanged
```

Routes are deduplicated before writing, so a route that could otherwise end up in the list twice (e.g. `/` matched by discovery and again by the `includeRoot` fallback) is only rendered and written once.

---

## What runs in Node vs. the browser

Because `render()` executes in Node (not a browser), and your `src/main.*` module is loaded directly rather than through Vite's browser bundler, `bini-ssg` registers two Node ESM loader hooks before importing it:

- **`tsx`** — compiles TS/JSX on the fly so Node can `import()` your `.tsx`/`.jsx`/`.ts` source directly, without a separate build step. This is why `tsx` is a required peer dependency regardless of whether your project is JS or TS.
- **A temporary asset-stub loader** — intercepts imports of stylesheets (`.css`, `.scss`, `.sass`, `.less`, `.styl`) and static assets (images, fonts, media) that your app code imports (e.g. `import './styles.css'`), and resolves them to harmless empty stub modules instead of letting Node try (and fail) to parse them as JavaScript. This only affects the Node-side render pass — it has no effect on your actual built CSS/JS, which Vite already emitted normally.

Node ESM loader hooks can't be unregistered once added, so the loader is only ever registered once per process; the temp file backing it is deleted at the end of each build regardless. In the normal case (`vite build` as its own process) this is a non-issue — it only matters if you're driving multiple builds from one long-lived Node process (e.g. a custom script), in which case the hook itself persists for the life of that process even though its backing file is cleaned up between builds.

You don't need to configure any of this — it's an internal implementation detail, mentioned here so the behavior isn't a surprise if you're debugging an import error during pre-rendering.

---

## Limitations

- **No dev-server preview of pre-rendered output.** `apply: 'build'` means this plugin does nothing under `vite dev`; you'll only see pre-rendered HTML by running `vite build` (and optionally `vite preview` afterward to serve the `dist` output).
- **Dynamic routes always get a shell, never full pre-rendering.** There's no automatic enumeration of `[id]`/`[...slug]` param values (e.g. from a CMS or database), and there's no option to opt a specific dynamic URL into full pre-rendering — every route matching a `manifest.dynamic` pattern gets a shell page, full stop.
- **`render()` still runs for shell routes.** The call happens and is awaited exactly like for a static route; only its returned HTML is discarded. Side effects in `render()` (logging, writes, throwing on unexpected input) will still occur for shell routes, not just fully-rendered ones.
- **`render()` is your responsibility.** `bini-ssg` doesn't wire up server rendering for you — see [Your `render()` function](#your-render-function).
- **`bini-router` is required, not optional.** There's no fallback file-system route scanner; if `bini-router` can't be resolved or its manifest throws, the build fails (when `failOnError: true`, the default).
- **Root-div replacement is regex/depth-based, not a full HTML parser.** Handles nested and self-closing `<div>`s correctly; a literal `</div>` inside a `<script>` block in your rendered output is the one known case that can produce incorrect output.

---

## License

MIT © [Binidu Ranasinghe](https://bini.js.org)