"use client";

// Next.js client entry point: the browser-side overlay mount for the App
// Router (a client component wrapping the review overlay using Next.js
// conventions — pathname/searchParams hooks, etc.). Implemented in a later
// work package (WP5).
//
// This file is deliberately separate from `./index.ts` / `./routes.ts`.
// Everything reachable from here must be safe to ship to the browser, so
// the server-only route-handler factory — which imports `node:crypto` via
// `../server/access` and is meant only for `app/api/**/route.ts` files —
// must never be imported from this module, directly or transitively. See
// the split rationale in `./index.ts`.

export const VERSION = "0.1.0";
