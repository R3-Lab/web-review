/**
 * Postgres connection + Drizzle client, via `node-postgres` (`pg`) rather
 * than an HTTP driver — deliberately, so `lib/review-store.ts` can wrap
 * `createThread`'s two inserts in a real interactive transaction
 * (`db.transaction`), which `node-postgres`'s persistent connection pool
 * supports and an HTTP-only driver (e.g. Neon's serverless driver) does not.
 *
 * Cached on `globalThis` so `next dev`'s module-reload-on-save doesn't open
 * a fresh connection pool on every edit.
 */

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __r3wrDemoPool: Pool | undefined;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and point it at the docker-compose Postgres (see README.md).",
  );
}

const pool =
  globalThis.__r3wrDemoPool ??
  new Pool({
    connectionString,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__r3wrDemoPool = pool;
}

export const db = drizzle(pool, { schema });
