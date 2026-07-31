/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { VERSION } from "./version";
import { VERSION as MAIN_ENTRY } from "./index";
import { VERSION as NEXT_ENTRY } from "./next/index";
import { VERSION as NEXT_CLIENT_ENTRY } from "./next/client";
import { VERSION as SERVER_ENTRY } from "./server/index";
import { VERSION as DRIZZLE_ENTRY } from "./drizzle/index";

/**
 * The drift check that lets `./version.ts` stay a hand-written constant.
 *
 * `package.json`'s `version` field is what npm publishes under and what a
 * consumer's lockfile records, so it is the authority; `./version.ts` mirrors
 * it because the value has to be reachable from browser bundles, where there
 * is no manifest to read (see that file's header for the full reasoning, and
 * for why a codegen step was rejected in favour of this test).
 *
 * A mirror that nothing checks is exactly how five entry points ended up
 * exporting `0.1.0` from a `0.2.0` package — harmless right up until somebody
 * uses `VERSION` for a compatibility check, at which point it is actively
 * misleading. So this file pins both halves of the arrangement:
 *
 *  1. The constant equals `package.json`'s `version` — a bump to one without
 *     the other fails here rather than shipping.
 *  2. All five public entry points expose that same value — `.`, `./next`,
 *     `./next/client`, `./server`, and `./drizzle` are five separately
 *     bundled entries (`tsup.config.ts` builds each in isolation), so
 *     "re-exported from one module" is worth asserting per entry rather than
 *     assumed from reading the source.
 *
 * The manifest is read from disk at test time rather than imported, for the
 * same reason `./version.ts` doesn't import it: `package.json` sits outside
 * `tsconfig.json`'s `rootDir: "src"`. `process.cwd()` is the package root
 * under this package's own `vitest run` — the same assumption
 * `./build-output.test.ts` makes when it locates `dist/`.
 */

const packageJsonPath = join(process.cwd(), "package.json");

/**
 * `package.json`'s `version` field, narrowed to a string. Throws rather than
 * returning `undefined` on a shape it doesn't recognise: a silently missing
 * field would turn every assertion below into a comparison against nothing,
 * which is the failure mode this whole file exists to prevent.
 */
function readManifestVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error(`${packageJsonPath} has no "version" field`);
  }
  const { version } = parsed;
  if (typeof version !== "string") {
    throw new Error(`${packageJsonPath}'s "version" is ${typeof version}, expected a string`);
  }
  return version;
}

/** Every public entry point's `VERSION` export, keyed by the subpath a consumer imports it from. */
const entryVersions: Record<string, string> = {
  "@r3lab/web-review": MAIN_ENTRY,
  "@r3lab/web-review/next": NEXT_ENTRY,
  "@r3lab/web-review/next/client": NEXT_CLIENT_ENTRY,
  "@r3lab/web-review/server": SERVER_ENTRY,
  "@r3lab/web-review/drizzle": DRIZZLE_ENTRY,
};

describe("VERSION", () => {
  it("matches package.json's version field", () => {
    expect(VERSION).toBe(readManifestVersion());
  });

  it("is a plain three-part semver string", () => {
    // Guards the check above against a manifest version this package's
    // release process would never produce (an empty string, a range, a
    // stray `v` prefix) quietly satisfying an equality test on both sides.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("is exported by every public entry point, with the same value", () => {
    for (const [subpath, entryVersion] of Object.entries(entryVersions)) {
      expect(entryVersion, `${subpath} exports a stale or divergent VERSION`).toBe(VERSION);
    }
  });

  it("is exported from all five entry points — none silently dropped", () => {
    // The loop above passes vacuously if an entry stops exporting VERSION
    // and its import here resolves to `undefined`... only if VERSION were
    // also undefined, which the semver assertion rules out. This pins the
    // count instead: removing an entry's export is a breaking change for
    // whoever imports it, so it should fail loudly here first.
    expect(Object.keys(entryVersions)).toHaveLength(5);
    for (const [subpath, entryVersion] of Object.entries(entryVersions)) {
      expect(typeof entryVersion, `${subpath} no longer exports a VERSION string`).toBe("string");
    }
  });
});
