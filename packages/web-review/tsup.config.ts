import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Two entry GROUPS, each its own config object, rather than one flat
// `entry` map — see the `splitting` comment on the first group for why the
// overlay's dynamic `import()` boundary needs real chunk-splitting scoped
// to ONLY the three "use client" entries (index, next/client, surfaces) and
// ONLY the `esm` output (never `cjs` — see that same comment for why), and
// why the three server-only entries stay on the original `splitting: false`
// (single self-contained bundle per entry, both formats) with nothing else
// about them changed.
//
// Splitting is a whole-config setting (tsup reads `options.splitting`
// once per format, uniformly across every ENTRY in that config, though not
// uniformly across formats — see the first group's own comment — see
// `node_modules/tsup/dist/index.js`, the `splitting` local right before
// the per-format `Promise.all`), so getting two different values for it
// across ENTRY groups requires two config objects. esbuild's own docs say
// as much directly: "If you want to only let certain entry points share
// code, you can run esbuild multiple times for different groups of entry
// points" — which is exactly what an array `tsup.config.ts` does, one
// `build()` call (and one underlying esbuild run per format) per array
// item.
//
// CLEANING: tsup runs every item in an array config CONCURRENTLY
// (`await Promise.all([...configData].map(async (item) => {...}))` in
// `build()`, node_modules/tsup/dist/index.js) — verified against the
// installed tsup 8.5.1 source, not assumed. Each item's own `buildAll()`
// independently checks `options.clean` and, if true, wipes `outDir`
// (`removeFiles(["**/*", ...], options.outDir)`) before writing its own
// output. Two config objects sharing one `outDir` ("dist") and both
// setting `clean: true` would race — whichever finishes cleaning last
// wipes out files the other had already written. Rather than picking one
// item to own `clean: true` (still racy: `Promise.all` starts both items
// immediately, so the non-cleaning item can start writing before the
// cleaning item's clean step runs, and lose those files to it), neither
// item below sets `clean` at all. Instead, `dist/` is removed exactly
// once, synchronously, right here at module scope. `loadTsupConfig`
// (node_modules/tsup/dist/chunk-VGC3FXLU.js) bundles and `require()`s this
// file via `bundleRequire` and `await`s the result in full — running every
// top-level statement in this module, including this `rmSync` — before
// `build()` ever reads `config.data` to build the array `Promise.all`
// runs over. So this line is guaranteed to finish before either config
// object's `buildAll()` starts, with no concurrency to race.
rmSync("dist", { recursive: true, force: true });

const shared = {
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  external: ["react", "react-dom", "next", "drizzle-orm", "@zumer/snapdom"],
  outDir: "dist",
  // Keep the `node:` prefix on builtin specifiers (e.g. `node:crypto` in
  // src/server/access.ts) in both ESM and CJS output, for the server-only
  // entries (server/index, next/index) that import them.
  //
  // tsup ships its OWN esbuild plugin for this (`nodeProtocolPlugin`,
  // src/esbuild/node-protocol.ts in the tsup package), separate from and
  // running BEFORE esbuild's own target-based `node:`-prefix compatibility
  // handling. When `removeNodeProtocol` is true (tsup 8.5.1's default —
  // its own type doc says that default "will be flipped to `false` in the
  // next major release"), that plugin unconditionally strips the prefix
  // and marks the import external, regardless of `platform` or `target`.
  // That's what was happening here: `target` resolves to this package's
  // tsconfig `"target": "ES2022"`, a bare `es*` target with no Node
  // version component, so even esbuild's own (secondary, and moot once
  // tsup's plugin has already run first) node:-prefix compatibility table
  // would have stripped it too. The result was a bare `crypto` specifier
  // in both `dist/server/index.{js,cjs}` and `dist/next/index.{js,cjs}` —
  // resolvable to the long-deprecated npm package literally named `crypto`
  // if one is ever present in a consumer's dependency tree, instead of
  // guaranteed to hit the Node builtin, and unresolvable at all on Deno /
  // Cloudflare Workers (`nodejs_compat`), which require the prefix.
  //
  // Verified against the tsup 8.5.1 package installed in this repo's
  // node_modules (dist/index.js, dist/index.d.ts) — not guessed from
  // memory or docs alone.
  //
  // Set on the shared base (applies to both entry groups below) rather
  // than only the server one: this repo has exactly one `node:`-prefixed
  // import in its entire source (`node:crypto` in src/server/access.ts),
  // reached only through server/index and next/index — see
  // build-output.test.ts, which asserts no OTHER bare-builtin import
  // exists anywhere in `dist` either. The browser entries (index,
  // next/client) are structurally unable to reach it (see the
  // client/server split rationale in src/next/index.ts), so this option
  // is a no-op for them either way, and keeping one shared value avoids
  // two copies of this option drifting apart.
  removeNodeProtocol: false,
} as const;

export default defineConfig([
  {
    ...shared,
    entry: {
      index: "src/index.ts",
      "next/client": "src/next/client.tsx",
      // The four default UI surfaces (`Composer`/`Panel`/`ThreadDetail`/
      // `UnlockDialog`), on their own subpath rather than re-exported from
      // `index` — see src/surfaces.ts's own header for why (the short
      // version: any `"use client"` file's FULL export list rides along
      // with a consumer's import of anything else from that same file,
      // under Next's webpack integration, regardless of tsup's own
      // chunking). Grouped here with `index`/`next/client` — not off in the
      // second, `splitting: false` group below — because
      // `src/overlay/default-surfaces.tsx`'s `loadWiredOverlayRoot` (which
      // both of those entries' lazy boundaries call) ALSO reaches
      // `Composer`/`Panel`/`UnlockDialog` via its own `import()`, so in this
      // group's single esbuild run those implementations are reachable from
      // two places (this entry, eagerly, and the existing lazy boundary)
      // and esbuild's splitting shares one chunk between them instead of
      // duplicating the code — putting `surfaces` in a separate,
      // `splitting: false` esbuild run would inline a second, independent
      // copy of the same implementation instead.
      surfaces: "src/surfaces.ts",
    },
    // esbuild preserves each entry's own directive prologue (e.g. "use
    // client") as the first statement of THAT entry's own output chunk
    // even with splitting on — confirmed against tsup's own esbuild
    // integration (src/esbuild/index.ts in the installed tsup 8.5.1
    // package: "When splitting is enabled, esbuild generates multiple
    // chunks, and each entry chunk retains its original directive
    // prologues") and against the actual ESM build output here, which
    // src/build-output.test.ts asserts directly. What splitting changes is
    // that a module reached via a dynamic `import()` — `../overlay/overlay-root`
    // behind `React.lazy` (src/overlay/review-overlay.tsx) and
    // `next/dynamic` (src/next/client.tsx) — is emitted as its own chunk
    // file instead of being inlined into the entry, and the `import()`
    // call is rewritten to point at that file. Without splitting, esbuild
    // does the opposite ("an `import('path')` expression behaves similar
    // to `Promise.resolve(require('path'))` and still bundles the imported
    // file into the entry point bundle" — esbuild's own docs), which is
    // why dist/index.js and dist/next/client.js used to ship the entire
    // overlay (~50 KB each) inline regardless of whether the tool was
    // switched on.
    //
    // Scoped to ONLY these three entries (see the file header) rather than
    // every entry, so this can't create a chunk shared between a
    // client entry and a server-only one — the three server entries below
    // keep their original single-bundle-per-entry shape untouched.
    //
    // NOTE for src/index.ts: as of WP17 it re-exports from
    // "./overlay/overlay-root" with `export type { ... }` only — the same
    // type-only shape dist/next/client.js already used — so dist/index.js
    // carries no top-level, EAGER `import` of that chunk at all; a type-only
    // export erases entirely at compile time and leaves nothing for a
    // bundler to eagerly pull in. `OverlayRoot` itself reaches the module
    // only through the `import()` this splitting config targets (via
    // `React.lazy` in src/overlay/review-overlay.tsx), so the chunk is
    // genuinely deferred for every consumer of the plain `index` entry,
    // regardless of their own bundler's tree-shaking. See the WP15 report
    // for the pre-WP17 analysis this superseded.
    //
    // `splitting` is deliberately NOT set here as a boolean — leaving it
    // `undefined` is load-bearing, not an oversight. esbuild's own code
    // splitting only works for the `esm` output format (its docs say so
    // directly, and this repo's own `node_modules/tsup/dist/index.js`
    // encodes the same fact: the `splitting` local used for the real
    // esbuild call is `typeof options.splitting === "boolean" ?
    // options.splitting : format === "esm"` — true only for `esm` when
    // left unset). Setting `splitting: true` explicitly, as an earlier
    // version of this file did, forces that same boolean onto the `cjs`
    // build too — and tsup's own per-format build loop reacts to
    // `format === "cjs" && splitting` by asking esbuild for `"esm"` output
    // instead of `"cjs"` (same file, the `format:` line inside the
    // `esbuild.build()` call), then converts that split ESM into CJS with
    // a SEPARATE transform (recognizable in the output by its
    // `_interopRequireWildcard`/`_nullishCoalesce` helpers, which are not
    // esbuild's own CJS helper names). That conversion does not preserve
    // directive-prologue position: it emits `"use strict";
    // Object.defineProperty(exports, "__esModule", ...)` and helper
    // function declarations FIRST, unconditionally, and only then whatever
    // came after the original source's directive — so `"use client"` ends
    // up several statements into the file instead of as the prologue's
    // first (and only) string-literal statement. Per the ECMAScript
    // directive-prologue rule (the leading run of string-literal
    // expression statements, ending at the first non-string statement), a
    // directive stranded after `Object.defineProperty(...)` has no
    // directive meaning at all — it is a dead expression statement, and
    // Next's client-boundary scanner (which reads the prologue) does not
    // see it. Reproduced by rebuilding with `splitting: true` restored
    // here and inspecting `dist/index.cjs`/`dist/next/client.cjs` — the
    // corrupted prologue is real, not theoretical — then fixed by removing
    // the explicit `true` and confirming the CJS output goes back to
    // esbuild's normal, unsplit `cjs` path (its usual `__defProp`-style
    // helpers, `"use client"` as the literal second statement right after
    // `"use strict"`, matching this package's pre-WP15 CJS shape exactly).
    // src/build-output.test.ts's directive-prologue tests assert the
    // position, not just the presence, of the directive in all four of
    // dist/index.{js,cjs} and dist/next/client.{js,cjs} specifically so
    // this class of regression fails loudly again if reintroduced.
    //
    // The `esm` build's real chunk split is unaffected by any of this:
    // that half of the pre-existing bug (`format === "cjs" && splitting`)
    // never applies when building the `esm` format, so it already took the
    // normal esbuild-native splitting path with a correct prologue, both
    // before and after this fix.
    // Forces `@types/node`'s ambient globals (`process`, used by
    // `process.env.NEXT_PUBLIC_REVIEW_ENABLED` in src/next/client.tsx) into
    // this group's `.d.ts` rollup. Needed ONLY here, and only because of
    // this group's entry set: tsup's dts bundler (rollup-plugin-dts,
    // node_modules/tsup/dist/rollup.js) builds one `ts.createProgram` per
    // group of entries that share a tsconfig directory — grouping ALL of
    // an ungrouped, single flat `entry` map (as this file had pre-WP15)
    // into ONE shared Program. In that shared Program, `server/index.ts`'s
    // `import "node:crypto"` (via src/server/access.ts) forces TypeScript
    // to resolve `@types/node` for that module specifier, which — because
    // ambient/global declarations are Program-wide, not file-scoped —
    // incidentally made `@types/node`'s ambient `process` global visible
    // to every OTHER file in that same Program too, including
    // next/client.tsx, even though next/client.tsx never imports anything
    // node-specific itself. Splitting server/index.ts into its own config
    // group (below) removes it from this group's Program, so that
    // incidental pull-in no longer happens and `process` in
    // next/client.tsx's own dts rollup fails to resolve
    // ("TS2591: Cannot find name 'process'") without this override —
    // verified by reproducing the failure with this group built in
    // isolation, then fixing it with exactly this option, both against
    // the tsup 8.5.1 / rollup-plugin-dts source installed in
    // node_modules. `pnpm typecheck` (`tsc --noEmit`) was never affected
    // by any of this: it always type-checks the whole `src` directory as
    // one program per this package's own tsconfig.json, independent of
    // how tsup groups entries for bundling.
    dts: { compilerOptions: { types: ["node"] } },
    async onSuccess() {
      // `src/styles.css` is the public entry but stays empty on disk; the
      // overlay's actual rules live in `src/overlay/overlay.css` (see that
      // file's own header). Concatenated here — rather than left as a CSS
      // `@import` — so `dist/styles.css` is one self-contained file: an
      // `@import` would require `dist/overlay.css` to also exist and be
      // resolvable relative to wherever a consumer's bundler (or CSP)
      // ultimately serves the stylesheet from, which this plain file-copy
      // build step has no way to guarantee.
      const base = readFileSync("src/styles.css", "utf8");
      const overlay = readFileSync("src/overlay/overlay.css", "utf8");
      writeFileSync("dist/styles.css", `${base}\n${overlay}\n`);
    },
  },
  {
    ...shared,
    entry: {
      "next/index": "src/next/index.ts",
      "server/index": "src/server/index.ts",
      "drizzle/index": "src/drizzle/index.ts",
    },
    // Unchanged from WP0: none of these three entries ever carries a
    // "use client" directive (next/index re-exports the server-only route
    // factory, `./routes.ts`, and must never carry it — see the split
    // rationale documented in `src/next/index.ts`), so there is no
    // directive-hoisting risk here and nothing to gain from splitting —
    // each stays a single, self-contained bundle per entry.
    splitting: false,
  },
]);
