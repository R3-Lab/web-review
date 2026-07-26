import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "next/index": "src/next/index.ts",
    "next/client": "src/next/client.tsx",
    "server/index": "src/server/index.ts",
    "drizzle/index": "src/drizzle/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Each entry is bundled independently (no shared chunks). esbuild
  // preserves the "use client" directive prologue as the first statement
  // of a bundled entry, but splitting can hoist shared code above an
  // entry's own directive when multiple entries are code-split together.
  // Disabling splitting keeps every entry self-contained so the directive
  // is guaranteed to stay the first line of the client entries (index,
  // next/client), while it never appears in the next/index, server, or
  // drizzle entries — next/index re-exports the server-only route factory
  // (`./routes.ts`) and must never carry the directive; see the split
  // rationale documented in `src/next/index.ts`.
  splitting: false,
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
  // Set at the top level (all five entries) rather than only for the
  // node-targeted ones: this repo has exactly one `node:`-prefixed import
  // in its entire source (`node:crypto` in src/server/access.ts), reached
  // only through server/index and next/index — see build-output.test.ts,
  // which asserts no OTHER bare-builtin import exists anywhere in `dist`
  // either. The browser entries (index, next/client) are structurally
  // unable to reach it (see the client/server split rationale in
  // src/next/index.ts, and this file's own `splitting: false` comment
  // above), so this option is a no-op for them either way — and per-entry
  // `removeNodeProtocol` isn't an option tsup exposes without splitting
  // into an array of configs, which would otherwise be the way to give
  // entries different options. That path was deliberately avoided here:
  // each array item runs as its own `build()` call, and tsup runs every
  // item in the array CONCURRENTLY (`Promise.all` over the config array,
  // in tsup's own `build()`), so two config objects both setting
  // `clean: true` (needed once, to clear `dist/` at the start of a build)
  // race to wipe out `dist/` on top of whichever entries the other
  // config's build had already written — verified in the same tsup
  // source. A single config sidesteps that hazard entirely.
  removeNodeProtocol: false,
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
});
