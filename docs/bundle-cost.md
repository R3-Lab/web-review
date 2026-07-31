# Bundle cost: the full breakdown

**Part of [`@r3lab/web-review`](https://github.com/R3-Lab/web-review/blob/main/README.md)** — an
in-page review overlay for React and Next.js apps that ships no server and no
database. The [README's Bundle cost section](https://github.com/R3-Lab/web-review/blob/main/README.md#bundle-cost)
has the headline measurements, the execution guarantee, and the Turbopack
caveat — read that first. This page is the forensics behind it: what a
*disabled* build's always-loaded JS actually still contains under webpack,
which piece is fixed and which isn't, the root cause of the one that was
fixed, and the measured floor. It's here for anyone auditing what this
package costs a page that isn't using it, and for contributors working on
that number.

**On this page:** [The three pieces](#caveat-main-entry-importers) ·
[The floor](#floor-for-reference) · [Net effect](#net-effect)

---

## Caveat, main-entry importers

**(webpack, measured — not tested under Turbopack):** what actually ends up
in a *disabled* build's always-loaded JS breaks into three pieces, with three
different deferral stories.

1. **The anchoring engine (`captureAnchor`/`resolveAnchor`/`buildSelector`/
   `scoreCandidate`/…, ~22 KB source).** *Correction: this is NOT
   unconditionally deferred under `next build --webpack` the way it was
   previously described here* — that claim held only in isolation, not for
   this package's own actual [demo app](https://github.com/R3-Lab/web-review/tree/main/examples/next-demo). `anchor.ts` and
   `core/adapter.ts` (`ReviewApiError` and friends, needed eagerly by
   `createHttpAdapter`, which throws it) end up bundled by tsup into the
   *same* shared output chunk, because both are reachable from the identical
   pair of places — the eager main entry and the lazy overlay chunk — and
   esbuild's splitting merges same-reachability modules into one chunk file
   rather than emitting two. A consumer who needs anything from that merged
   chunk downloads the whole file, anchoring engine included: confirmed
   directly against the demo's real webpack output (not just tsup's
   intermediate chunk) — `isStableClass`'s own regex literal
   (`/__[A-Za-z0-9]{4,}$/`) and `buildSelector`'s `:nth-of-type` selector
   string both appear verbatim in the disabled-variant `app/layout-*.js`,
   which nothing in `review-mount.tsx` or `layout.tsx` calls, directly or
   indirectly. This predates and is independent of the fix in piece 2 below
   — moving the four UI surfaces off the main entry doesn't touch it, and
   confirmed unchanged before and after that fix. Not fixed here; the
   downloaded-but-not-executed story under Turbopack (the
   [caveat in the README](https://github.com/R3-Lab/web-review/blob/main/README.md#bundle-cost))
   still holds regardless, since that's about execution, not download.
2. **The default UI surfaces (`Composer`/`Panel`/`ThreadDetail`/
   `UnlockDialog`).** **Fixed** — moved off the main `.` entry onto their own
   `@r3lab/web-review/surfaces` subpath; see [Customizing a
   surface](https://github.com/R3-Lab/web-review/blob/main/docs/customizing.md) for how to import them there. Measured on
   the same demo app, real usage unchanged (`review-mount.tsx` still imports
   `createHttpAdapter` from `.` and `ReviewOverlay` from `.../next/client`):
   the disabled-variant layout chunk drops from **15,990 to 12,841 bytes**
   (about 20%) — real, verified, and it stays that way whether or not a
   consumer ever imports `@r3lab/web-review/surfaces` at all, since only an
   actual import from that subpath pays for it now.

   *Root cause, investigated and confirmed — not tsup/esbuild chunking.* The
   leading hypothesis going in was that tsup's own chunk-splitting put these
   surfaces in the same pre-bundled chunk as `createHttpAdapter`, so a
   consumer's bundler had no chunk boundary left to split on. That's ruled
   out: `createHttpAdapter` is inlined directly into `dist/index.js` itself
   (grep `dist/index.js` for `src/client/http-adapter.ts` — it's not
   imported from any `chunk-*.js` file at all), so it was never sharing a
   chunk with anything. The real mechanism is `dist/index.js`'s own
   `"use client"` directive (required — see the [README's Bundle cost
   section](https://github.com/R3-Lab/web-review/blob/main/README.md#bundle-cost))
   combined with how Next.js's webpack integration handles any `"use client"`
   module:
   Next's `next-flight-client-entry-loader` walks the module graph from every
   Server Component, and for **every** file it finds carrying `"use client"`
   — not just the one a Server Component imports directly, but every such
   file reachable transitively, which included `dist/index.js` itself — it
   generates a client-reference entry that explicitly re-exports **all** of
   that file's named exports (`registerClientReference` wraps each one; see
   `next-flight-loader/index.ts` in the Next.js source). That generated entry
   is what a normal bundler's used-exports analysis sees, and it references
   every name unconditionally — so whether `review-mount.tsx` itself ever
   wrote `Composer` was irrelevant; Next forced the whole export list live
   before webpack's own tree-shaking ever got a say. `sideEffects: ["*.css"]`
   in `package.json` doesn't help here either, because this isn't a
   whole-module side-effect question — it's Next materializing a use for
   every individual export. Confirmed empirically, isolated from any
   chunking change: temporarily trimming `src/index.ts`'s own `export *`
   list, with `tsup.config.ts` completely untouched, reproduced the same
   drop with no chunking change involved at all — that isolated the lever
   precisely (what `dist/index.js` **exports**, not how tsup groups the
   implementation behind those exports) and is what motivated giving the
   four surfaces their own subpath instead.

   The remaining gap down to the floor (see below) is piece 1, above — a
   separate, still-open issue this fix doesn't touch. This was only measured
   under webpack; don't assume the Turbopack story is the same.
3. **`resolveConfig` and `normalizeUrl` (~900 bytes)** — always eager, by
   design: the mount gate itself calls `resolveConfig` before it knows
   whether it's on, so this much has to run regardless. `normalizeUrl` used
   to drag the entire anchoring engine in with it (piece 1) because it lived
   inside `anchor.ts`; it now lives in its own `src/normalize-url.ts`,
   re-exported from `anchor.ts` so the public API is unchanged. Verified
   directly: `dist/next/client.js`'s own static import graph (`next/dynamic`
   excluded) is 3 files, ~4.6 KB total, zero occurrences of `data-r3-review`.

## Floor, for reference

A diagnostic build importing `ReviewOverlay` from
`@r3lab/web-review/next/client` alone, with `createHttpAdapter` swapped for
an inline stub (so nothing else touches the main `.` entry at all — no
`core/adapter.ts`, hence no anchor-engine chunk-share either), produces a
5,864-byte disabled-variant layout chunk with zero occurrences of
`data-r3-review`. That's the true floor, not a target this fix reaches:
importing `createHttpAdapter` from `.` is normal, expected usage, and piece
1's chunk-share means that alone still costs real bytes today.

## Net effect

Measured on the demo app's disabled variant, `next build
--webpack`, real usage unchanged throughout (`review-mount.tsx` importing
`createHttpAdapter` from `.` and `ReviewOverlay` from `.../next/client`):
**15,990 bytes before this package's own fixes → 12,841 bytes after piece
2's fix**, `data-r3-review` present in both (piece 1 keeps it there — see
above). If minimizing the disabled-state cost matters to you today: import
`ReviewOverlay` *only* from `@r3lab/web-review/next/client`, and construct
your adapter (`createHttpAdapter` or your own) from a module that doesn't
also import anything else off the main `.` entry — that's the only
confirmed way to reach the floor above. Piece 1 (the anchor/adapter
chunk-share) is tracked as a follow-up, not fixed here.
