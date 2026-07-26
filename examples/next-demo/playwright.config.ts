import { defineConfig, devices } from "@playwright/test";
import { DATABASE_URL, DISABLED_PORT, ENABLED_PORT, REVIEW_PASSWORD, REVIEW_SECRET } from "./e2e/constants";

/**
 * E2E config (WP11) — deliberately separate from the package's own
 * `vitest.config.ts`, never run by `pnpm -F @r3lab/web-review test`.
 * `scripts/e2e.sh` (via `pnpm e2e`) brings up a real, uniquely-named
 * Postgres container and applies the package's own `sql/postgres.sql`
 * before invoking `playwright test`; this file owns building and starting
 * TWO real Next.js servers against that database — one with the overlay
 * enabled, one without (scenario 8) — since `NEXT_PUBLIC_REVIEW_ENABLED` is
 * baked in at build time and can't be toggled per-request.
 */

const sharedServerEnv = { DATABASE_URL, REVIEW_PASSWORD, REVIEW_SECRET };

/** Long: each webServer entry is a real `next build` (Turbopack) + `next start`, not just a boot. */
const WEB_SERVER_TIMEOUT_MS = 180_000;

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
      command: "pnpm run e2e:build:enabled && pnpm run e2e:start:enabled",
      url: `http://localhost:${ENABLED_PORT}`,
      timeout: WEB_SERVER_TIMEOUT_MS,
      reuseExistingServer: false,
      env: { ...sharedServerEnv, NEXT_PUBLIC_REVIEW_ENABLED: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm run e2e:build:disabled && pnpm run e2e:start:disabled",
      url: `http://localhost:${DISABLED_PORT}`,
      timeout: WEB_SERVER_TIMEOUT_MS,
      reuseExistingServer: false,
      // Explicitly empty, not merely absent: the point is to prove the
      // build-time literal folds to `false`, not to rely on an unset var
      // possibly leaking in from the shell.
      env: { ...sharedServerEnv, NEXT_PUBLIC_REVIEW_ENABLED: "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
