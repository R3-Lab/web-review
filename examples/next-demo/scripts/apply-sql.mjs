#!/usr/bin/env node
/**
 * `pnpm db:apply` — applies `packages/web-review/sql/postgres.sql` against
 * `DATABASE_URL`.
 *
 * Deliberately NOT a bare `psql "$DATABASE_URL" -f ...` shell command: pnpm
 * (like npm) does not source `.env.local` before running a package script —
 * only `next dev`/`next build`/`next start` do that, via Next's own dotenv
 * loading. A bare `psql "$DATABASE_URL"` therefore sees an EMPTY
 * `DATABASE_URL` and fails with a misleading "connection to server on
 * socket ... failed" error that has nothing to do with the real problem.
 * This script reads `.env.local` itself (falling back to whatever is
 * already in `process.env`, so it still works unmodified in CI, where
 * `DATABASE_URL` is typically exported directly rather than filed).
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const demoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const envLocalPath = join(demoRoot, ".env.local");

/** Minimal `KEY=VALUE` parser — good enough for this project's flat env files (no multiline values, no `export` prefix). */
function parseEnvFile(path) {
  const out = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = { ...process.env };
if (existsSync(envLocalPath)) {
  const fromFile = parseEnvFile(envLocalPath);
  for (const [key, value] of Object.entries(fromFile)) {
    // A real environment variable (e.g. set by CI) always wins over the file.
    if (env[key] === undefined) env[key] = value;
  }
}

if (!env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Copy .env.example to .env.local (see README.md) or export DATABASE_URL before running `pnpm db:apply`.",
  );
  process.exit(1);
}

const sqlPath = join(demoRoot, "..", "..", "packages", "web-review", "sql", "postgres.sql");
const result = spawnSync("psql", [env.DATABASE_URL, "-f", sqlPath], {
  stdio: "inherit",
  env,
});

if (result.error) {
  console.error(`Failed to run psql: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
