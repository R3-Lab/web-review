/// <reference types="node" />
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression test for the `node:` prefix bug: tsup 8.5.1 defaults
 * `removeNodeProtocol` to `true` (its own type doc says that default "will
 * be flipped to `false` in the next major release" — see the long comment
 * on `removeNodeProtocol` in tsup.config.ts for the full story), which
 * unconditionally stripped the `node:` prefix from `node:crypto` and
 * marked it external, regardless of `platform`/`target`. That produced a
 * bare `crypto` specifier in `dist/server/index.{js,cjs}` and
 * `dist/next/index.{js,cjs}` — resolvable to the long-deprecated npm
 * package literally named `crypto` if one is ever present in a consumer's
 * dependency tree, instead of guaranteed to hit the Node builtin, and
 * unresolvable at all on Deno / Cloudflare Workers (`nodejs_compat`),
 * which require the prefix.
 *
 * This can only be checked against real build output — nothing in the
 * source files (which already correctly say `"node:crypto"`) would catch
 * a tsup/esbuild config regression that strips the prefix at bundle time.
 * So this test reads `dist/` directly, and skips (loudly, not silently)
 * when it doesn't exist, rather than passing with zero assertions.
 */

const distDir = join(process.cwd(), "dist");
const distExists = existsSync(distDir);

/** Recursively list every file under `dir`, as paths relative to `dir`. */
function listFilesRecursive(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else {
      out.push(full.slice(base.length + 1));
    }
  }
  return out;
}

/** Runtime JS output only — not source maps, not .d.ts/.d.cts declarations. */
function isRuntimeJsFile(relPath: string): boolean {
  return relPath.endsWith(".js") || relPath.endsWith(".cjs");
}

/**
 * Node builtin module names (no `node:` prefix, e.g. `"crypto"`, `"fs"`),
 * pulled from `node:module` itself rather than hand-maintained, so this
 * stays correct across Node versions. Excludes internal modules (leading
 * `_`, e.g. `_http_agent`) and slash-qualified subpaths (e.g.
 * `fs/promises`) — a bare, unprefixed `fs/promises` specifier isn't
 * ambiguous with a real npm package the way `crypto`/`fs`/`path` etc. are,
 * since npm package names can't contain a literal `/promises` suffix on a
 * builtin's name in a way that collides.
 */
const bareBuiltinNames = builtinModules.filter(
  (name) => !name.startsWith("_") && !name.includes("/"),
);

/**
 * True if `content` imports/requires the bare (unprefixed) builtin `name`
 * — via a static `from "name"`, a `require("name")`, or a dynamic
 * `import("name")`. Deliberately matches on the exact quoted string so
 * `require("node:crypto")` never matches the bare check for `"crypto"`.
 */
function importsBareBuiltin(content: string, name: string): boolean {
  const quoted = `["']${name}["']`;
  const re = new RegExp(`(?:\\bfrom\\s+|\\brequire\\(\\s*|\\bimport\\(\\s*)${quoted}`);
  return re.test(content);
}

/**
 * The ECMAScript "directive prologue" is the leading run of statements in a
 * program that are bare string-literal expressions (e.g. `"use strict";`).
 * It ends at the first statement that is NOT a bare string literal — every
 * statement after that point is ordinary code, and a string literal
 * appearing there, even one that reads `"use client"`, has no directive
 * meaning at all; it's a dead expression statement. Next's client-boundary
 * scanner reads the prologue specifically, so "the substring is present
 * somewhere in the file" is a materially different (and weaker) check than
 * "it's an actual directive" — see the `'"use client" placement'` describe
 * block below for the regression this distinction exists to catch.
 *
 * Returns the leading prologue as a substring of `content` (empty string if
 * the very first statement already isn't a bare string literal).
 */
function directivePrologue(content: string): string {
  const re = /^(?:\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*;?)*/;
  return content.match(re)?.[0] ?? "";
}

/**
 * True if `directive` (e.g. `use client`, no quotes) is an actual directive
 * at the start of `content` — i.e. inside the directive prologue, not
 * merely present as a string somewhere later in the file.
 */
function hasDirective(content: string, directive: string): boolean {
  return new RegExp(`["']${directive}["']`).test(directivePrologue(content));
}

/**
 * Matches an ESM static import — `import { a, b } from "./x.js"`, `import
 * ns from "./x.js"`, `import * as ns from "./x.js"`, or a bare
 * side-effect-only `import "./x.js"` — but NOT a dynamic `import("./x.js")`
 * call, because `import(` (no whitespace) never matches `import\s+`.
 */
const STATIC_IMPORT_RE = /import\s+(?:[^"'()]*?from\s+)?["'](\.[^"']+)["']/g;

/** Matches only a dynamic `import("./x.js")` call expression. */
const DYNAMIC_IMPORT_RE = /import\(\s*["'](\.[^"']+)["']\s*\)/g;

/** True for defined values — narrows `(string | undefined)[]` to `string[]` without an assertion. */
function isDefined(value: string | undefined): value is string {
  return value !== undefined;
}

/** The relative-to-`distDir` import specifiers a file statically imports vs. dynamically `import()`s. */
function parseImportTargets(content: string): { static: string[]; dynamic: string[] } {
  return {
    static: [...content.matchAll(STATIC_IMPORT_RE)].map((m) => m[1]).filter(isDefined),
    dynamic: [...content.matchAll(DYNAMIC_IMPORT_RE)].map((m) => m[1]).filter(isDefined),
  };
}

/** Resolve an import specifier found in `fromRelPath` to a path relative to `distDir`. */
function resolveImportTarget(fromRelPath: string, target: string): string {
  return relative(distDir, join(distDir, dirname(fromRelPath), target));
}

/**
 * BFS the import graph starting at `entryRelPath` (exclusive) and return
 * every file reachable from it. When `includeDynamic` is false, only
 * `import ... from "..."` / bare `import "..."` edges are followed — the
 * set a bundle would statically inline or reference by specifier. When
 * true, `import()` edges are followed too, so this can answer "is X
 * reachable at all" vs. "is X reachable WITHOUT a real code-split
 * boundary".
 */
function collectReachable(entryRelPath: string, includeDynamic: boolean): Set<string> {
  const seen = new Set<string>();
  const queue = [entryRelPath];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const content = readFileSync(join(distDir, current), "utf8");
    const { static: staticTargets, dynamic: dynamicTargets } = parseImportTargets(content);
    const targets = includeDynamic ? [...staticTargets, ...dynamicTargets] : staticTargets;
    for (const target of targets) {
      const resolved = resolveImportTarget(current, target);
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  seen.delete(entryRelPath);
  return seen;
}

describe.skipIf(!distExists)("dist/ build output", () => {
  const allFiles = distExists ? listFilesRecursive(distDir) : [];
  const runtimeFiles = allFiles.filter(isRuntimeJsFile);

  it("dist/ actually contains runtime JS output to check", () => {
    // Guards against a typo in isRuntimeJsFile/listFilesRecursive silently
    // reducing this whole suite to zero real assertions.
    expect(runtimeFiles.length).toBeGreaterThan(0);
  });

  it("no runtime output anywhere in dist/ imports a bare (unprefixed) Node builtin", () => {
    const offenders: string[] = [];
    for (const relPath of runtimeFiles) {
      const content = readFileSync(join(distDir, relPath), "utf8");
      for (const name of bareBuiltinNames) {
        if (importsBareBuiltin(content, name)) {
          offenders.push(`${relPath}: bare "${name}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("dist/server/index.{js,cjs} and dist/next/index.{js,cjs} use the node: prefix for crypto", () => {
    for (const relPath of ["server/index.js", "server/index.cjs", "next/index.js", "next/index.cjs"]) {
      const content = readFileSync(join(distDir, relPath), "utf8");
      expect(content, `${relPath} should reference node:crypto`).toMatch(/node:crypto/);
    }
  });

  describe('"use client" placement', () => {
    /**
     * Regression test (WP15, second pass): a first attempt at restoring
     * code-splitting for the overlay set `splitting: true` uniformly for
     * BOTH `esm` and `cjs` output. esbuild's own splitting only works for
     * `esm` — for the `cjs` build, tsup's own per-format loop reacts to
     * `format === "cjs" && splitting` by asking esbuild for `esm` output
     * and then converting it to CJS through a different code path
     * (recognizable by its `_interopRequireWildcard`/`_nullishCoalesce`
     * helpers, not esbuild's own `__defProp`-style ones). That conversion
     * emits `"use strict"; Object.defineProperty(exports, "__esModule",
     * ...)` and helper function declarations FIRST, unconditionally, and
     * only THEN whatever followed the original directive — so
     * `dist/index.cjs` and `dist/next/client.cjs` still literally
     * contained the string `"use client"`, but several non-string
     * statements into the file, well outside the directive prologue. A
     * plain substring check (`content.toMatch(/["']use client["']/)`)
     * cannot see that difference — it passed on the broken build, 322
     * tests green, while Next's client-boundary scanner (which reads the
     * prologue, not the whole file) would have silently treated both
     * files as ordinary modules. Fixed by leaving `splitting` unset for
     * the `cjs` format (see tsup.config.ts) so it takes esbuild's normal,
     * unsplit `cjs` path — the one that has always correctly preserved
     * the prologue. This test checks the directive's POSITION, not just
     * its presence, for all four client-entry output files (ESM and CJS
     * both), so this class of regression fails loudly instead of passing
     * quietly.
     */
    it('is inside the directive prologue (not merely present in the file) for dist/index.{js,cjs} and dist/next/client.{js,cjs}', () => {
      for (const relPath of ["index.js", "index.cjs", "next/client.js", "next/client.cjs"]) {
        const content = readFileSync(join(distDir, relPath), "utf8");
        expect(
          hasDirective(content, "use client"),
          `${relPath}: "use client" must be part of the directive prologue (a leading run of bare string-literal statements), not just present somewhere in the file. Actual prologue found: ${JSON.stringify(directivePrologue(content))}`,
        ).toBe(true);
      }
    });

    it("is ABSENT from dist/server/index.*, dist/next/index.*, dist/drizzle/index.*", () => {
      const relPaths = [
        "server/index.js",
        "server/index.cjs",
        "next/index.js",
        "next/index.cjs",
        "drizzle/index.js",
        "drizzle/index.cjs",
      ];
      for (const relPath of relPaths) {
        const content = readFileSync(join(distDir, relPath), "utf8");
        expect(content, relPath).not.toMatch(/["']use client["']/);
      }
    });
  });

  /**
   * Regression test for WP15: `tsup.config.ts` used to build every entry
   * with `splitting: false`, which made esbuild inline any dynamically
   * `import()`-ed module directly into the entry that imported it — per
   * esbuild's own docs, "an `import('path')` expression behaves similar to
   * `Promise.resolve(require('path'))` and still bundles the imported file
   * into the entry point bundle" when splitting is off. That silently
   * defeated the `React.lazy` boundary in `src/overlay/review-overlay.tsx`
   * and the `next/dynamic` boundary in `src/next/client.tsx`: the overlay
   * (~50 KB) shipped inside dist/index.js and dist/next/client.js
   * regardless of whether the tool was ever switched on, even though
   * neither entry's own source changed shape at all — nothing in `src/`
   * would catch that regression, only real build output would.
   *
   * `tsup.config.ts` now enables real chunk-splitting for the `esm` build
   * of just these two entries (see that file for the full rationale and
   * the entry-grouping this required), so the overlay is split into its
   * own chunk file and reached via a real `import()` at runtime instead of
   * being inlined. The `cjs` build of the SAME two entries deliberately
   * stays unsplit — esbuild's splitting only works for `esm`, and an
   * earlier attempt at forcing it for `cjs` too corrupted the directive
   * prologue (see the `'"use client" placement'` describe block above),
   * so `dist/index.cjs`/`dist/next/client.cjs` intentionally keep their
   * pre-WP15 shape: same ~55-60 KB / ~49-52 KB size, same inlined,
   * self-referencing `Promise.resolve().then()` around the overlay. These
   * tests assert the `esm` split stays real, and that the `cjs` files
   * correctly stayed OUT of it.
   */
  describe("overlay code-splitting stays real (WP15)", () => {
    const splitEsmEntries = ["index.js", "next/client.js"];
    const unsplitCjsEntries = ["index.cjs", "next/client.cjs"];

    it("dist/index.js and dist/next/client.js (ESM) stay small — the overlay is not inlined", () => {
      // Baseline (splitting: false) sizes were ~55-60 KB. Post WP15,
      // each is under 10 KB. 15 KB leaves generous headroom for normal
      // growth while still catching a regression back to inlining the
      // ~35 KB overlay chunk.
      for (const relPath of splitEsmEntries) {
        const content = readFileSync(join(distDir, relPath), "utf8");
        expect(content.length, `${relPath} should be small if the overlay isn't inlined into it`).toBeLessThan(
          15_000,
        );
      }
    });

    /**
     * Regression test (WP17): the test above ("stay small") only proves the
     * overlay isn't INLINED — it doesn't prove there's still a real
     * `import()` boundary at all. This test used to assert that a literal
     * `import(...)` appears IN the entry file itself. That was true when
     * WP15 wrote it (the entry called `import()` directly), but WP16 later
     * introduced a shared loader (`default-surfaces.tsx`, bundled as its
     * own chunk) that BOTH entries import statically and which itself owns
     * the real `import()` calls — so the dynamic-import edge legitimately
     * moved one level down the graph, from the entry into that loader
     * chunk. The entry files never contained a literal `import(` again,
     * failing the old, over-specific assertion even though the split was
     * still completely real.
     *
     * What actually matters — and what this rewrite checks — isn't WHERE
     * in the file tree the `import()` call sits, it's whether the overlay
     * implementation is reachable from the entry WITHOUT one:
     *
     *   1. Identify the overlay chunk by CONTENT (it contains OverlayRoot's
     *      actual function declaration), not by its hash-suffixed filename
     *      — that hash changes every build, so hardcoding it would make
     *      this test rot immediately.
     *   2. Walk the entry's STATIC-only import graph (`from "..."`, bare
     *      `import "...";`) and confirm the overlay chunk is NOT in it —
     *      i.e. no static edge, however indirect, reaches it.
     *   3. Walk the entry's import graph again, this time also following
     *      `import()` edges, and confirm the overlay chunk IS in that
     *      larger set — i.e. it's still genuinely reachable, just only
     *      through a real dynamic-import boundary somewhere in the chain.
     *
     * This is strictly stronger than the old check: it survives the loader
     * moving further down the tree, but still fails if the overlay were
     * ever statically re-inlined (found in step 2) OR silently dropped
     * from the bundle entirely (missing from step 3).
     */
    it("dist/index.js and dist/next/client.js (ESM) reach the overlay ONLY through a chain that includes a real import(), never statically", () => {
      const overlayChunkCandidates = runtimeFiles.filter(
        (relPath) =>
          (relPath.endsWith(".js") || relPath.endsWith(".cjs")) &&
          relPath !== "index.js" &&
          relPath !== "next/client.js" &&
          /function OverlayRoot\(/.test(readFileSync(join(distDir, relPath), "utf8")),
      );
      // Sanity on the detector itself: exactly one ESM chunk should hold
      // the real implementation. Zero means the detector (or the build)
      // silently lost `OverlayRoot`; more than one means chunking merged
      // it somewhere unexpected — either way, the rest of this test can't
      // trust its own chunk identification, so fail loudly here first.
      const esmOverlayChunks = overlayChunkCandidates.filter((relPath) => relPath.endsWith(".js"));
      expect(
        esmOverlayChunks,
        `expected exactly one ESM chunk containing OverlayRoot's function declaration, found: ${JSON.stringify(overlayChunkCandidates)}`,
      ).toHaveLength(1);
      const [overlayChunk] = esmOverlayChunks;
      if (overlayChunk === undefined) {
        // Unreachable: the toHaveLength(1) assertion above already failed
        // (and threw) if this array weren't exactly one element long. This
        // only exists to narrow the type without an `as`/`!` assertion.
        throw new Error("unreachable: esmOverlayChunks.length === 1 was just asserted");
      }

      // The chunk we found should actually be substantial — the real
      // overlay implementation is ~20-30 KB. A near-empty match here would
      // mean the detector latched onto a decoy (e.g. a re-export shim)
      // rather than the real implementation.
      const overlayChunkSize = statSync(join(distDir, overlayChunk)).size;
      expect(
        overlayChunkSize,
        `${overlayChunk} (detected as the overlay chunk) is only ${overlayChunkSize} bytes — too small to be the real OverlayRoot implementation`,
      ).toBeGreaterThan(15_000);

      for (const relPath of splitEsmEntries) {
        const staticOnly = collectReachable(relPath, false);
        expect(
          staticOnly.has(overlayChunk),
          `${relPath} statically reaches ${overlayChunk} (the overlay chunk) without going through a dynamic import() — this re-inlines the overlay into the entry's eager load path. Statically reachable set: ${JSON.stringify([...staticOnly])}`,
        ).toBe(false);

        const withDynamic = collectReachable(relPath, true);
        expect(
          withDynamic.has(overlayChunk),
          `${relPath} never reaches ${overlayChunk} (the overlay chunk) even when following import() edges — the overlay appears to have been dropped from the bundle graph entirely. Reachable set: ${JSON.stringify([...withDynamic])}`,
        ).toBe(true);
      }
    });

    it("dist/index.cjs and dist/next/client.cjs deliberately stay unsplit — same shape as before WP15", () => {
      // The counterpart to the two tests above: CJS never gets a real
      // `import()`-to-a-separate-chunk boundary (see this describe
      // block's own header for why), so its `Promise.resolve().then()`
      // around the overlay stays a same-file self-reference — the
      // opposite of what the ESM tests just asserted. Pinning that here
      // means a future change that accidentally starts splitting CJS
      // again (reintroducing the directive-prologue corruption) shows up
      // as a behavior change in THIS test, not just a silent size drop.
      for (const relPath of unsplitCjsEntries) {
        const content = readFileSync(join(distDir, relPath), "utf8");
        expect(content.length, `${relPath} should stay at its pre-WP15 inlined size`).toBeGreaterThan(30_000);
        const match = content.match(/require\(["'](\.[^"']+)["']\)/);
        expect(match, `${relPath} should NOT require() a separate overlay chunk file`).toBeNull();
      }
    });

    it("@zumer/snapdom is only ever reached through a dynamic import — never a static import or a bare require, anywhere in dist/", () => {
      const offenders: string[] = [];
      // Matches the specifier only where it's actually a module
      // reference: `import("@zumer/snapdom")` (ESM dynamic),
      // `require("@zumer/snapdom")` (CJS — legitimate only when wrapped in
      // the `Promise.resolve().then()` esbuild emits for a source-level
      // dynamic import; see the file header above), or `from
      // "@zumer/snapdom"` (a static ESM import declaration, which should
      // never appear at all). Anchored to `import(` / `require(` / `from `
      // immediately before the quote so the unrelated English sentence
      // "@zumer/snapdom is not installed..." (the fallback warning,
      // elsewhere in the same bundle) can't false-positive this check.
      const specifierRe = /(import\(|require\(|from\s+)["']@zumer\/snapdom["']/;
      for (const relPath of runtimeFiles) {
        const content = readFileSync(join(distDir, relPath), "utf8");
        for (const line of content.split("\n")) {
          const match = line.match(specifierRe);
          const kind = match?.[1];
          if (kind === undefined) continue;
          const isDynamic =
            kind.startsWith("import(") || (kind.startsWith("require(") && line.includes("Promise.resolve().then("));
          if (!isDynamic) offenders.push(`${relPath}: ${line.trim()}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});

// Vitest's summary would otherwise show nothing for this file at all when
// dist/ is missing (a skipped `describe` block is simply absent from the
// tree), which reads the same as "nothing to check here" as it does as
// "these checks didn't run" — the two are very different. This standalone,
// self-documenting placeholder guarantees an explicit, named "skipped"
// entry shows up in that case instead.
it.skipIf(distExists)(
  "SKIPPED — dist/ not found; run `pnpm build` before this test can check its output",
  () => {
    // Intentionally empty.
  },
);
