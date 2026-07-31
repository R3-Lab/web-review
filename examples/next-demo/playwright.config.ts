import { defineConfig, devices } from "@playwright/test";
import { DATABASE_URL, DISABLED_PORT, ENABLED_PORT, REVIEW_PASSWORD, REVIEW_SECRET } from "./e2e/constants";

/**
 * E2E config — deliberately separate from the package's own
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
        // The panel and the composer are independent surfaces that are
        // routinely open AT THE SAME TIME here — `launcher-panel.spec.ts`
        // arms pin-drop from the panel's own "New comment" button, so the
        // panel is still docked when the composer opens — and the panel
        // (`.r3wr-panel`) is a fixed 384px dock laid OVER the page, not a
        // column beside it. Both dimensions exist so those two surfaces
        // and the page underneath them stay usable simultaneously:
        //
        //  1. Width: the demo's content container caps at `860px` and is
        //     centered (`app/globals.css`), so at 1800px its edges land at
        //     470/1330 while the dock takes 1416-1800 (or 0-384) — ~86px
        //     of clearance, and the SAME ~86px on either side, which
        //     matters now that the panel follows the draggable launcher to
        //     whichever edge it was left on (`launcher-position.spec.ts`
        //     drives it to the left one and asserts the dock lands there).
        //     Narrower, and the dock starts covering the very elements
        //     these specs click; the composer's own clamp would also begin
        //     dragging it away from its anchor, since `panelReservedWidth`
        //     (`composer.tsx`) subtracts the dock's full width from the
        //     space the composer is allowed to occupy.
        //  2. Height: 2000px is taller than the whole demo page (~1387px
        //     at the time of writing), so it never scrolls. Every target
        //     sits at its fixed, unscrolled document position, and the
        //     composer — `position: fixed`, opening 16px below the click
        //     point and ~450-550px tall — fits below it without
        //     `clampComposerPosition`'s `maxTop`
        //     (`innerHeight - composerHeight - 8`, ~1492px here) ever
        //     engaging and pulling it back off its anchor.
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
