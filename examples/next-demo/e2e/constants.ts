/**
 * Shared constants for the E2E suite. `DATABASE_URL` / `REVIEW_PASSWORD`
 * / `REVIEW_SECRET` are read from `process.env` — `scripts/e2e.sh` exports
 * them before invoking `playwright test`, so this is the single place both
 * `playwright.config.ts` (webServer env for the Next.js processes it spawns)
 * and the spec files (which need the password to type into the unlock UI)
 * read them from. The literal fallbacks here match `scripts/e2e.sh`'s own
 * defaults exactly, so `pnpm exec playwright test` still works if a
 * developer already ran the Postgres setup by hand.
 */

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://r3wr:r3wr@localhost:55499/r3wr_e2e";

export const REVIEW_PASSWORD = process.env.REVIEW_PASSWORD ?? "e2e-review-password";

export const REVIEW_SECRET =
  process.env.REVIEW_SECRET ?? "e2e-review-secret-not-for-production-use-only-for-tests";

/** Port for the build with `NEXT_PUBLIC_REVIEW_ENABLED=1` — every scenario except #8. */
export const ENABLED_PORT = 32111;

/** Port for the build with `NEXT_PUBLIC_REVIEW_ENABLED` unset — scenario #8 only. */
export const DISABLED_PORT = 32112;

export const ENABLED_BASE_URL = `http://localhost:${ENABLED_PORT}`;
export const DISABLED_BASE_URL = `http://localhost:${DISABLED_PORT}`;
