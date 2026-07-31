// Next.js App Router entry point: the server-only route-handler factory
// (`createReviewRouteHandlers`) that turns a consumer's `ReviewStore` into
// ready-made `app/api/**/route.ts` handlers — see `./routes.ts` for the
// factory itself, its full `ReviewStore` contract, and a copy-pasteable
// wiring example. Safe to import from any server file: route handlers,
// server components, middleware.
//
// SERVER/CLIENT SPLIT — read before adding an export here. This package's
// browser-side overlay mount lives on its own subpath,
// `@r3lab/web-review/next/client` (`./client.ts`), which carries a
// `"use client"` directive. The two are kept on separate subpaths rather
// than combined in one `./next` entry because:
//
//  - `./routes.ts` imports `node:crypto` (via `../server/access`) and other
//    server-only APIs. If that ever ended up inside a module Next.js treats
//    as a client component, a consumer's App Router build would fail (or,
//    worse on a misconfigured setup, ship server code — secrets included —
//    into browser JavaScript). Keeping the route factory on a plain,
//    non-"use client" entry makes that class of mistake unreachable: there
//    is no code path from `./client.ts` to here.
//  - This module must therefore never `export * from "./client"` (or import
//    it in any form) — doing so would pull a `"use client"`-marked module
//    into the server entry's dependency graph, and, depending on the
//    bundler, risks the reverse mistake of the whole `./next` entry being
//    misidentified as a client boundary.
//
// tsup builds each package entry as an independently bundled file
// (`splitting: false` in `tsup.config.ts`), so this file's absence of a
// `"use client"` directive is guaranteed to hold in `dist/next/index.js`
// regardless of what `./client.ts` does in its own separately-bundled
// `dist/next/client.js`.

export * from "./routes";

// Re-exported from `../version`, the single source for the package version —
// see its header. `../version` has no imports of its own, so this stays a
// server-safe entry: nothing it pulls in can reach a `"use client"` module.
export { VERSION } from "../version";
