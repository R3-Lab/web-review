/**
 * Scenario 4 — THE CRITICAL ONE. A pin must survive a reload, re-anchored to
 * the SAME element — not merely "some pin exists" after reload, but its
 * rendered position matching the target element's real bounding box.
 *
 * The click in `dropElementPin` lands dead-center on the target
 * (Playwright's default click point), so the captured `offsetPct` is very
 * close to `{x:0.5, y:0.5}` — that makes "the pin's on-screen position"
 * directly comparable to "the target element's bounding-box center" with a
 * small pixel tolerance, rather than needing to replicate the offset math.
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
import { centerOf, dropElementPin, marker, pinByTitleText, unlock, unlockedToggle } from "./helpers";

/**
 * Tight: `centerOf` reads `boundingBox()`, and rotation around a fixed
 * transform-origin never moves an element's own center — so a correctly
 * centered pin should land within a couple of sub-pixel rounding errors of
 * the target's, not merely "close by chance". A few px of slack covers
 * layout jitter (e.g. a late web-font swap), nothing more.
 *
 * Previously widened to 20 to paper over a real, reproducible ~15-16px
 * gap (WP29): `.r3wr-pin`/`.r3wr-pin-draft` used `margin-top: -30px`
 * (a full box-height) instead of `-15px` (half — matching `margin-left`).
 * Since a marker's `getBoundingClientRect()` bounding box is centered on
 * its own untransformed box regardless of `border-radius`, that
 * asymmetric margin put the box's rendered CENTER 15px above the intended
 * anchor point, even though the visual "tip" landed close to it — the pin
 * looked roughly right but measured wrong. Fixed in `overlay.css`; see its
 * comment on `.r3wr-pin` for the geometry.
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
    const pinCenterBefore = await centerOf(pinBefore);

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
    const pinCenterAfter = await centerOf(pinAfter);

    // Report-worthy values — see the task write-up for the actual numbers
    // this produced.
    testInfo.attach("reload-anchor-measurements.json", {
      body: JSON.stringify(
        { targetCenterBefore, pinCenterBefore, targetCenterAfter, pinCenterAfter },
        null,
        2,
      ),
      contentType: "application/json",
    });

    expect(
      Math.abs(pinCenterAfter.x - targetCenterAfter.x),
      `pin x (${pinCenterAfter.x}) should be within ${POSITION_TOLERANCE_PX}px of the target's live center x (${targetCenterAfter.x})`,
    ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
    expect(
      Math.abs(pinCenterAfter.y - targetCenterAfter.y),
      `pin y (${pinCenterAfter.y}) should be within ${POSITION_TOLERANCE_PX}px of the target's live center y (${targetCenterAfter.y})`,
    ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);

    // And, for good measure: pre- and post-reload pin positions agree with
    // each other too, not just with the target — the anchor didn't just
    // happen to re-resolve near the right spot, it resolved to the exact
    // same visual position it had before the reload.
    expect(Math.abs(pinCenterAfter.x - pinCenterBefore.x)).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
    expect(Math.abs(pinCenterAfter.y - pinCenterBefore.y)).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
  });
});
