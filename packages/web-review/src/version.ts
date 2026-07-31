/**
 * `@r3lab/web-review`'s own version string, in exactly one place.
 *
 * Every public entry point exports a `VERSION` binding — `.` (`./index.ts`),
 * `./next`, `./next/client`, `./server`, and `./drizzle` — because a consumer
 * gating behaviour on the package version imports it from whichever subpath
 * they already depend on, and none of them can be dropped without breaking
 * somebody. Until this module existed, that meant five hand-maintained copies
 * of one fact, and they did exactly what five hand-maintained copies of one
 * fact always do: all five still read `0.1.0` well after `package.json` had
 * moved on, so anything comparing against them got a confidently wrong answer.
 * The five exports stay; what changes is that four of them are now re-exports
 * of this constant, and there is only one literal left to forget to bump.
 *
 * ## Why a plain constant rather than reading `package.json`
 *
 * The obvious "real" single source is `package.json`'s own `version` field,
 * and it stays the authority — but this module deliberately does not read it
 * at runtime:
 *
 *  - `import pkg from "../package.json"` sits outside `tsconfig.json`'s
 *    `rootDir: "src"`, and bundling it would inline the ENTIRE manifest —
 *    `scripts`, `devDependencies`, repository URLs — into every consumer's
 *    bundle to recover one short string.
 *  - Reading it from disk at runtime is worse still: `./index.ts` and
 *    `./next/client.tsx` are browser modules, where there is no `node:fs` and
 *    no `package.json` to read in the first place.
 *  - A build step or codegen that stamps the value in would work, but it buys
 *    a generated file, a build-order dependency, and a source file whose
 *    contents differ from what the repository shows, all for one string that
 *    changes a handful of times a year.
 *
 * So the constant is written by hand, and `./version.test.ts` asserts it
 * equals `package.json`'s `version` field — and that every one of the five
 * entry points re-exports this exact value. Drift is then a failing test at
 * the moment it is introduced rather than a wrong answer discovered by an
 * integrator months later, which is the same guarantee codegen would give at
 * a fraction of the machinery.
 *
 * BUMPING THE VERSION: change the literal below and `package.json`'s
 * `version` field together. Changing either alone fails the test.
 */

export const VERSION = "0.3.0";
