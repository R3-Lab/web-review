/**
 * Scenario 5 — text-selection anchoring. A real mouse drag-select over a
 * phrase inside the testimonial paragraph, pinned via the "select, press c,
 * click the highlight" gesture, must store `anchor.kind: "text"` carrying
 * the selected words — and after a reload, the highlight must still cover
 * that same phrase (not just render somewhere).
 */

import { test, expect } from "@playwright/test";
import { findThreadsByCommentMarker } from "./db";
import { dropTextPin, expectSingle, marker, rectOfSubstring, unlock, unlockedToggle } from "./helpers";

/** The word actually baked into the demo's testimonial copy (app/page.tsx) — deliberately picked because it's the exact word the copy itself calls out as the thing worth reviewing. */
const PHRASE = "unlimited";

test.describe("text-selection anchoring", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await unlock(page);
  });

  test("selecting a phrase and pinning it stores a text anchor, and the highlight survives a reload over the same words", async ({
    page,
  }, testInfo) => {
    const mark = marker(testInfo.title);
    const testimonial = page.getByTestId("testimonial-quote");
    await expect(testimonial).toContainText(PHRASE);

    await dropTextPin(page, testimonial, PHRASE, {
      category: "Copy",
      title: `Wording check ${mark}`,
      body: `Is "${PHRASE}" the right word here? ${mark}`,
      name: "E2E Reviewer",
    });

    // ── stored shape ─────────────────────────────────────────────────────
    const threads = await findThreadsByCommentMarker(mark);
    expect(threads).toHaveLength(1);
    const thread = expectSingle(threads, `threads matching ${mark}`);
    const anchor = thread.anchor as Record<string, unknown>;
    expect(anchor.kind).toBe("text");
    expect(anchor.selectedText).toBe(PHRASE);
    expect(Array.isArray(anchor.highlightRectsPct)).toBe(true);
    expect((anchor.highlightRectsPct as unknown[]).length).toBeGreaterThan(0);

    // ── highlight renders now, over the right words ────────────────────
    const phraseRectBefore = await rectOfSubstring(testimonial, PHRASE);
    const highlightBefore = page.locator('.r3wr-highlight[data-kind="text"]');
    await expect(highlightBefore).toHaveCount(1);
    const highlightBoxBefore = await highlightBefore.boundingBox();
    if (highlightBoxBefore === null) throw new Error("highlight has no bounding box (not visible/attached)");
    assertBoxCoversRect(highlightBoxBefore, phraseRectBefore);

    // ── survives a reload, over the SAME words ──────────────────────────
    await page.reload();
    await expect(unlockedToggle(page)).toBeVisible();

    const testimonialAfter = page.getByTestId("testimonial-quote");
    const phraseRectAfter = await rectOfSubstring(testimonialAfter, PHRASE);
    const highlightAfter = page.locator('.r3wr-highlight[data-kind="text"]');
    await expect(highlightAfter).toHaveCount(1);
    // Not drifted: the confident-bind branch of `ThreadHighlight` is what's on screen.
    await expect(highlightAfter).toHaveAttribute("data-drifted", "false");
    const highlightBoxAfter = await highlightAfter.boundingBox();
    if (highlightBoxAfter === null) throw new Error("highlight has no bounding box (not visible/attached)");
    assertBoxCoversRect(highlightBoxAfter, phraseRectAfter);
  });
});

/**
 * Asserts `box` (a Playwright bounding box) substantially overlaps `rect`
 * (a DOMRect-shaped object) — i.e. the highlight is drawn over the actual
 * words, not just somewhere on the page. Uses intersection-over-each-area
 * rather than strict containment: sub-pixel rounding between the Range API
 * (used to locate the phrase) and the highlight's own percentage-of-element
 * math (`highlightRectsPct`) can legitimately differ by a pixel or two.
 */
function assertBoxCoversRect(
  box: { x: number; y: number; width: number; height: number },
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number },
): void {
  const ix = Math.max(0, Math.min(box.x + box.width, rect.right) - Math.max(box.x, rect.left));
  const iy = Math.max(0, Math.min(box.y + box.height, rect.bottom) - Math.max(box.y, rect.top));
  const intersection = ix * iy;
  const boxArea = box.width * box.height;
  const rectArea = rect.width * rect.height;
  expect(boxArea, "highlight box should have a real, non-zero area").toBeGreaterThan(0);
  expect(rectArea, "phrase rect should have a real, non-zero area").toBeGreaterThan(0);
  expect(
    intersection / boxArea,
    `highlight box barely overlaps the phrase rect (${(intersection / boxArea) * 100}% of the highlight's own area)`,
  ).toBeGreaterThan(0.8);
  expect(
    intersection / rectArea,
    `highlight box barely overlaps the phrase rect (${(intersection / rectArea) * 100}% of the phrase's own area)`,
  ).toBeGreaterThan(0.8);
}
