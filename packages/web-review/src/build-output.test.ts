/// <reference types="node" />
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
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
    it('is the first statement of dist/index.js and dist/next/client.js (ESM)', () => {
      for (const relPath of ["index.js", "next/client.js"]) {
        const content = readFileSync(join(distDir, relPath), "utf8");
        const firstLine = content.split("\n").find((line) => line.trim().length > 0);
        expect(firstLine?.trim(), relPath).toMatch(/^["']use client["'];?$/);
      }
    });

    it("is present in dist/index.cjs and dist/next/client.cjs", () => {
      for (const relPath of ["index.cjs", "next/client.cjs"]) {
        const content = readFileSync(join(distDir, relPath), "utf8");
        expect(content, relPath).toMatch(/["']use client["']/);
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
   * `tsup.config.ts` now scopes `splitting: true` to just these two
   * entries (see that file for the full rationale and the entry-grouping
   * this required), so the overlay is split into its own chunk file and
   * reached via a real `import()`/`require()` at runtime instead of being
   * inlined. These tests assert that split stays real.
   */
  describe("overlay code-splitting stays real (WP15)", () => {
    const clientEntries = ["index.js", "index.cjs", "next/client.js", "next/client.cjs"];

    it("dist/index.{js,cjs} and dist/next/client.{js,cjs} stay small — the overlay is not inlined", () => {
      // Baseline (splitting: false) sizes were ~55-60 KB for index and
      // ~49-52 KB for next/client, in every one of these four files. Post
      // WP15, each is under 10 KB. 15 KB leaves generous headroom for
      // normal growth while still catching a regression back to inlining
      // the ~35 KB overlay chunk.
      for (const relPath of clientEntries) {
        const content = readFileSync(join(distDir, relPath), "utf8");
        expect(content.length, `${relPath} should be small if the overlay isn't inlined into it`).toBeLessThan(
          15_000,
        );
      }
    });

    it("dist/index.{js,cjs} and dist/next/client.{js,cjs} each reach the overlay through a real import()/require() to a separate file on disk", () => {
      for (const relPath of clientEntries) {
        const content = readFileSync(join(distDir, relPath), "utf8");
        const match = content.match(/(?:import|require)\(["'](\.[^"']+)["']\)/);
        expect(match, `${relPath} should contain a dynamic import()/require() to the overlay chunk`).not.toBeNull();
        const target = match?.[1];
        expect(target, `${relPath}: matched import()/require() but couldn't extract its target path`).toBeDefined();
        const resolvedTarget = join(distDir, relPath, "..", target ?? "");
        expect(existsSync(resolvedTarget), `${relPath} references "${target}", which should exist in dist/`).toBe(
          true,
        );
        // Not a same-file self-reference (which is what an inlined,
        // `Promise.resolve()`-wrapped dynamic import degenerates to when
        // splitting is off — see the file header above).
        expect(resolvedTarget, `${relPath} should reference a DIFFERENT file, not itself`).not.toBe(
          join(distDir, relPath),
        );
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
