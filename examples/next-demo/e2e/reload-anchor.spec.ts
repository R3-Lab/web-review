/**
 * Scenario 4 — THE CRITICAL ONE. A pin must survive a reload, re-anchored to
 * the SAME element — not merely "some pin exists" after reload, but its
 * rendered position matching the target element's real bounding box.
 *
 * The click in `dropElementPin` lands dead-center on the target
 * (Playwright's default click point), so the captured `offsetPct` is very
 * close to `{x:0.5, y:0.5}` — that makes "the pin's tip" (see `tipOf` in
 * `./helpers.ts`, and `.r3wr-pin`'s CSS comment for why it's the tip and
 * not the marker's bounding-box center) directly comparable to "the target
 * element's bounding-box center" with a small pixel tolerance, rather than
 * needing to replicate the offset math.
 *
 * The target is deliberately a LEAF element (a button, no nested block
 * children): `captureAnchor` anchors to whatever `document.elementFromPoint`
 * returns at the click coordinate, which is the DEEPEST element there — for
 * a container like a feature card's `<article>` (heading + paragraph
 * inside), that is one of its children, not the card itself, which would
 * make "the target's own bounding box" the wrong thing to compare against.
 * A leaf keeps "what got clicked" and "what the anchor is for" the same
 * element.
 */

import { test, expect } from "@playwright/test";
import { centerOf, dropElementPin, marker, pinByTitleText, tipOf, unlock, unlockedToggle } from "./helpers";

/**
 * Tight: `tipOf` reads `boundingBox()`, and a correctly-placed pin's tip
 * should land within a couple of sub-pixel rounding errors of the target's
 * true center — not merely "close by chance". A few px of slack covers
 * layout jitter (e.g. a late web-font swap), nothing more.
 *
 * History, for anyone tempted to touch this number again:
 *  - Originally 20, papering over a real, reproducible ~15-16px gap
 *    (WP29): `.r3wr-pin`/`.r3wr-pin-draft` used `margin-top: -30px`
 *    instead of the ~-36.2px that puts the marker's TIP exactly on its
 *    anchor — see `.r3wr-pin`'s CSS comment in `overlay.css` for the
 *    derivation. -30px was close, not exact.
 *  - WP29's own "fix" made this WORSE, not better: it set
 *    `margin-top: -15px` (matching `margin-left`) so the bounding-box
 *    CENTER sat exactly on the anchor. That made THIS test pass at tight
 *    tolerances — `centerOf(pin)` really was within a few px of
 *    `centerOf(target)` — but it was asserting the wrong thing. A
 *    teardrop marker's CENTER landing on the target means its ROUND BODY
 *    covers the target, not its tip pointing at it; the regenerated
 *    product screenshots showed pins sitting on top of the content they
 *    were meant to flag. WP32 reverted the CSS and fixed the assertion
 *    below to compare the tip (`tipOf`), not the bounding-box center, to
 *    the target's center — which is the geometry the design actually
 *    wants.
 */
const POSITION_TOLERANCE_PX = 5;

test.describe("pin survives a reload, anchored to the same element", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await unlock(page);
  });

  test("after reload, the pin re-binds confidently and renders at the target element's live position", async ({
    page,
  }, testInfo) => {
    const mark = marker(testInfo.title);
    const target = page.getByTestId("cta-primary");

    await dropElementPin(page, target, {
      category: "Design",
      title: `Anchoring card ${mark}`,
      body: `Reload-survival check ${mark}`,
      name: "E2E Reviewer",
    });

    const pinBefore = pinByTitleText(page, mark);
    await expect(pinBefore).toBeVisible();
    const targetCenterBefore = await centerOf(target);
    const pinTipBefore = await tipOf(pinBefore);

    // ── the actual reload ──────────────────────────────────────────────
    // The access cookie is httpOnly and survives the reload in this same
    // browser context, so the overlay's mount-time probe re-unlocks on its
    // own — no password re-entry. We just wait for that probe to resolve.
    await page.reload();
    await expect(unlockedToggle(page)).toBeVisible();

    const pinAfter = pinByTitleText(page, mark);
    await expect(pinAfter).toBeVisible();

    // The load-bearing assertion: NOT drifted — the resolver re-bound with
    // confidence, it didn't fall back to the absolute captured rect.
    await expect(pinAfter).toHaveAttribute("data-drifted", "false");

    const targetCenterAfter = await centerOf(page.getByTestId("cta-primary"));
    const pinTipAfter = await tipOf(pinAfter);

    // Report-worthy values — see the task write-up for the actual numbers
    // this produced.
    testInfo.attach("reload-anchor-measurements.json", {
      body: JSON.stringify(
        { targetCenterBefore, pinTipBefore, targetCenterAfter, pinTipAfter },
        null,
        2,
      ),
      contentType: "application/json",
    });

    expect(
      Math.abs(pinTipAfter.x - targetCenterAfter.x),
      `pin tip x (${pinTipAfter.x}) should be within ${POSITION_TOLERANCE_PX}px of the target's live center x (${targetCenterAfter.x})`,
    ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
    expect(
      Math.abs(pinTipAfter.y - targetCenterAfter.y),
      `pin tip y (${pinTipAfter.y}) should be within ${POSITION_TOLERANCE_PX}px of the target's live center y (${targetCenterAfter.y})`,
    ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);

    // And, for good measure: pre- and post-reload pin positions agree with
    // each other too, not just with the target — the anchor didn't just
    // happen to re-resolve near the right spot, it resolved to the exact
    // same visual position it had before the reload.
    expect(Math.abs(pinTipAfter.x - pinTipBefore.x)).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
    expect(Math.abs(pinTipAfter.y - pinTipBefore.y)).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
  });
});
