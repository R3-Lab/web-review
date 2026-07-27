/**
 * Scenario 8 — disabled overlay never executes. Scoped deliberately to what
 * Next.js + Turbopack actually guarantee, not more (see below).
 *
 * Runs against the SEPARATE build in the "disabled" Playwright project
 * (`NEXT_PUBLIC_REVIEW_ENABLED` unset — see `playwright.config.ts`'s second
 * `webServer` entry), not the main "enabled" build every other spec uses.
 *
 * What this test proves, at the network level, against a real build: no
 * overlay DOM ever appears, and no request to `/api/review/*` is ever made
 * — see `next/client.tsx`'s file header for why that's provably true at the
 * source level (a module-scope `process.env.NEXT_PUBLIC_REVIEW_ENABLED`
 * read that folds to a literal `false`, so `DynamicOverlayRoot` is never
 * rendered and `next/dynamic`'s loader is never called). The `/api/review/*`
 * check is doing double duty as an EXECUTION check, not just a DOM check:
 * `OverlayRoot` fires a `listThreads` request from a `useEffect` the moment
 * it mounts (`overlay-root.tsx`), so its total absence after the page goes
 * idle is direct evidence the module's code never ran — not merely that its
 * bytes never arrived.
 *
 * What this test deliberately does NOT assert, and used to (see git blame):
 * that the overlay's own JS chunk is never REQUESTED. That was true when
 * this suite's `e2e:build:disabled` script build was still measured only
 * against `next build --webpack`; it stopped being true once Turbopack
 * became `next build`'s default (this script has never passed `--webpack`).
 * Confirmed directly (see the README's "Bundle cost" caveat and
 * `next/client.tsx`'s file header for the full account, including the
 * webpack-vs-Turbopack comparison and a from-source rebuild that rules out
 * this package's own bundling as the cause): Turbopack's production builds
 * pre-fetch a route's entire async-import chunk graph as unconditional
 * `<script async>` tags in the initial HTML, including `next/dynamic`
 * boundaries whose runtime gate is closed, because that decision is made
 * from static reachability at build time, with no visibility into the
 * gate. `next build --webpack` does not have this problem. There is no
 * documented Turbopack option to exempt one boundary from it, so this
 * package cannot make that byte-cost guarantee unconditionally — only the
 * execution guarantee above. The block below still identifies the chunk
 * and records whether it was actually requested, so a regression that
 * makes things WORSE (e.g. the chunk's code starts actually running) is
 * still visible in the test report, but a Turbopack-only download is
 * reported, not failed.
 */

import { test, expect } from "@playwright/test";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { findChunksContaining } from "./chunk-finder";
import { expectSingle } from "./helpers";

/** The runtime attribute every overlay-owned DOM node carries (`OVERLAY_ATTR` in anchor.ts) — a distinctive fingerprint that survives minification because it's a literal string, not an identifier a minifier would rename. */
const OVERLAY_FINGERPRINT = "data-r3-review";

test.describe("disabled overlay never executes", () => {
  test("no overlay DOM and no /api/review requests — the overlay module never runs, whatever its bytes do", async ({
    page,
  }, testInfo) => {
    const chunksDir = join(import.meta.dirname, "..", ".next-e2e-disabled", "static", "chunks");
    const overlayChunks = findChunksContaining(chunksDir, OVERLAY_FINGERPRINT);
    expect(
      overlayChunks,
      `expected exactly one chunk containing "${OVERLAY_FINGERPRINT}" under ${chunksDir}, found: ${JSON.stringify(overlayChunks)}`,
    ).toHaveLength(1);
    const overlayChunkPath = expectSingle(overlayChunks, "overlay chunk candidates");
    const overlayChunkFile = basename(overlayChunkPath);
    const overlayChunkSize = statSync(overlayChunkPath).size;

    const requestedUrls: string[] = [];
    page.on("request", (req) => requestedUrls.push(req.url()));

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // No overlay DOM at all — not hidden, not present-but-inert.
    await expect(page.locator(`[${OVERLAY_FINGERPRINT}]`)).toHaveCount(0);
    await expect(page.locator(".r3wr-toggle")).toHaveCount(0);

    // No requests to the review API — see the file header: this is also
    // proof the overlay module's own code never ran, since a real mount
    // would fire this request immediately from its own effect.
    const reviewApiRequests = requestedUrls.filter((u) => u.includes("/api/review/"));
    expect(
      reviewApiRequests,
      `unexpected requests to the review API: ${JSON.stringify(reviewApiRequests)} — this would mean the overlay module actually executed`,
    ).toEqual([]);

    // The overlay's own chunk MAY be requested — recorded, not asserted
    // false, per the file header's Turbopack caveat. Bundler-dependent, and
    // outside this package's control.
    const overlayChunkRequests = requestedUrls.filter((u) => u.includes(overlayChunkFile));
    testInfo.annotations.push({
      type: "overlay-chunk",
      description:
        `Overlay chunk: ${overlayChunkFile} (${overlayChunkSize} bytes on disk, disabled build). ` +
        `Requested ${overlayChunkRequests.length} time(s) this run. A nonzero count is the documented ` +
        `Turbopack byte-download caveat (see README "Bundle cost"), not a failure — the execution ` +
        `assertions above are what actually guarantee the overlay stayed off.`,
    });
  });
});
