/**
 * Finds a built JS chunk by CONTENT rather than by its hash-suffixed
 * filename (which changes every build) — the same technique
 * `packages/web-review/src/build-output.test.ts` uses for the package's own
 * tsup output, adapted here for Next.js/Turbopack's `.next/static/chunks`
 * shape (scenario 8's "the overlay chunk is never fetched" check).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Absolute paths of every `.js` file under `dir` (recursive) whose contents include `needle`. */
export function findChunksContaining(dir: string, needle: string): string[] {
  const matches: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const content = readFileSync(full, "utf8");
        if (content.includes(needle)) matches.push(full);
      }
    }
  };
  walk(dir);
  return matches;
}
