import { defineConfig, devices } from "@playwright/test";
import { DATABASE_URL, DISABLED_PORT, ENABLED_PORT, REVIEW_PASSWORD, REVIEW_SECRET } from "./e2e/constants";

/**
 * E2E config (WP11) — deliberately separate from the package's own
 * `vitest.config.ts`, never run by `pnpm -F @r3lab/web-review test`.
 * `scripts/e2e.sh` (via `pnpm e2e`) brings up a real, uniquely-named
 * Postgres container, applies the package's own `sql/postgres.sql`, and —
 * load-bearing — builds BOTH Next.js variants (overlay enabled and
 * disabled; `NEXT_PUBLIC_REVIEW_ENABLED` is baked in at build time)
 * SEQUENTIALLY, before ever invoking `playwright test`.
 *
 * The `webServer` entries below therefore do ONLY `next start` against an
 * already-built `distDir`, nothing else. They used to also run
 * `next build`, but Playwright starts every `webServer` array entry
 * CONCURRENTLY — two `next build` invocations racing over the same project
 * directory's shared caches (Turbopack cache, `node_modules/.cache`) is a
 * real, reproducible failure: one build can lose the race and leave
 * `next start` with nothing to serve, or worse, corrupt output that mixes
 * both variants. Build ordering must live in `scripts/e2e.sh`, not here.
 */

const sharedServerEnv = { DATABASE_URL, REVIEW_PASSWORD, REVIEW_SECRET };

/** Generous for booting an ALREADY-BUILT `next start` (normally well under a second) — not a build timeout, `scripts/e2e.sh` owns that. */
const WEB_SERVER_TIMEOUT_MS = 30_000;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "enabled",
      testDir: "./e2e",
      testIgnore: /disabled\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://localhost:${ENABLED_PORT}`,
        // Much larger than Desktop Chrome's own default (1280×720) —
        // placed AFTER the `...devices["Desktop Chrome"]` spread above,
        // which carries its own `viewport` that would otherwise win
        // (project-level `use` merges per-key; last write wins) and
        // silently discard this override.
        //
        // Two real layout bugs found while writing this suite, worked
        // around here rather than in the component code (out of this
        // suite's scope) — see the task write-up for screenshots:
        //
        //  1. Width: the composer (`composer.tsx`) and the ALWAYS-open
        //     review panel (`.r3wr-panel`, a fixed 384px dock on the
        //     right — `enterPinDropMode` opens it unconditionally) don't
        //     know about each other's position, so a composer opened
        //     while the panel is showing can render partially or fully
        //     BEHIND the panel, its submit button unreachable. The demo's
        //     content container caps at `860px` (`app/globals.css`); at
        //     1800px viewport width the centered container's right edge
        //     sits safely clear of the panel's left edge (~90px margin)
        //     regardless of where in the page a pin is dropped.
        //  2. Height: the composer's `top` clamp
        //     (`Math.min(vy + 16, window.innerHeight - 160)`) only
        //     guarantees ~160px of headroom below the click point, but
        //     the composer's actual content is routinely ~450-550px tall.
        //     For an element near the bottom of the page, scrolling can
        //     bring it AT MOST to within `documentHeight - elementY` of
        //     the viewport's bottom — for this demo's CTA buttons that is
        //     only ~117px, no matter how the viewport is sized, AS LONG
        //     AS the page still scrolls at all. Making the viewport
        //     TALLER than the page's total height (~1387px at the time of
        //     writing) removes scrolling from the equation entirely: every
        //     element then sits at its fixed, unscrolled document
        //     position, which leaves genuine headroom below it.
        viewport: { width: 1800, height: 2000 },
      },
    },
    {
      name: "disabled",
      testDir: "./e2e",
      testMatch: /disabled\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${DISABLED_PORT}` },
    },
  ],
  webServer: [
    {
      // NOT `e2e:build:enabled && e2e:start:enabled` — see the file header.
      // scripts/e2e.sh already built .next-e2e-enabled before this ever runs.
      command: "pnpm run e2e:start:enabled",
      url: `http://localhost:${ENABLED_PORT}`,
      timeout: WEB_SERVER_TIMEOUT_MS,
      reuseExistingServer: false,
      // NEXT_PUBLIC_REVIEW_ENABLED is irrelevant here (already baked into
      // the build by scripts/e2e.sh) — DATABASE_URL/REVIEW_PASSWORD/
      // REVIEW_SECRET are what the running server actually needs.
      env: sharedServerEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm run e2e:start:disabled",
      url: `http://localhost:${DISABLED_PORT}`,
      timeout: WEB_SERVER_TIMEOUT_MS,
      reuseExistingServer: false,
      env: sharedServerEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
