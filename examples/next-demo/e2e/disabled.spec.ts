/**
 * Scenario 8 — disabled overlay costs nothing.
 *
 * Runs against the SEPARATE build in the "disabled" Playwright project
 * (`NEXT_PUBLIC_REVIEW_ENABLED` unset — see `playwright.config.ts`'s second
 * `webServer` entry), not the main "enabled" build every other spec uses.
 * With the flag off: no overlay DOM, no requests to `/api/review/*`, and
 * the overlay's own JS chunk is never fetched at all — see
 * `next/client.tsx`'s file header for why that's provably true at the
 * source level (a module-scope `process.env.NEXT_PUBLIC_REVIEW_ENABLED`
 * read that folds to a literal `false`, so `DynamicOverlayRoot` is never
 * rendered and its `next/dynamic` chunk is never requested). This test
 * proves that at the network level, against a real build.
 */

import { test, expect } from "@playwright/test";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { findChunksContaining } from "./chunk-finder";
import { expectSingle } from "./helpers";

/** The runtime attribute every overlay-owned DOM node carries (`OVERLAY_ATTR` in anchor.ts) — a distinctive fingerprint that survives minification because it's a literal string, not an identifier a minifier would rename. */
const OVERLAY_FINGERPRINT = "data-r3-review";

test.describe("disabled overlay costs nothing", () => {
  test("no overlay DOM, no /api/review requests, and the overlay chunk is never fetched", async ({ page }, testInfo) => {
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

    testInfo.annotations.push({
      type: "overlay-chunk",
      description: `Identified overlay chunk: ${overlayChunkFile} (${overlayChunkSize} bytes on disk, disabled build).`,
    });

    // No overlay DOM at all — not hidden, not present-but-inert.
    await expect(page.locator(`[${OVERLAY_FINGERPRINT}]`)).toHaveCount(0);
    await expect(page.locator(".r3wr-toggle")).toHaveCount(0);

    // No requests to the review API.
    const reviewApiRequests = requestedUrls.filter((u) => u.includes("/api/review/"));
    expect(
      reviewApiRequests,
      `unexpected requests to the review API: ${JSON.stringify(reviewApiRequests)}`,
    ).toEqual([]);

    // The overlay's own chunk is never requested, by name.
    const overlayChunkRequests = requestedUrls.filter((u) => u.includes(overlayChunkFile));
    expect(
      overlayChunkRequests,
      `the overlay chunk (${overlayChunkFile}, ${overlayChunkSize} bytes) should never be requested when the overlay is disabled at build time`,
    ).toEqual([]);
  });
});
