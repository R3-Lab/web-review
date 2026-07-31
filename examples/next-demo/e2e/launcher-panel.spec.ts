/**
 * The launcher and pin-drop mode are separate axes.
 *
 * The launcher used to do both jobs at once — open the panel AND arm
 * pin-drop mode — so a reviewer who only wanted to read the feedback already
 * on a page was put into picking mode as well: crosshair cursor, capture
 * scrim, every click on the host page swallowed. These tests pin down the
 * separation from both directions (the launcher opens the panel and does not
 * arm; `c` arms and does not open), and then drive the explicit control that
 * had to appear once the launcher stopped arming: the panel's own "New
 * comment" button.
 */

import { test, expect } from "@playwright/test";
import { findThreadsByCommentMarker } from "./db";
import {
  expectSingle,
  fillAndSubmitComposer,
  marker,
  newCommentButton,
  openPanel,
  pinByTitleText,
  unlock,
  unlockedToggle,
} from "./helpers";

test.describe("the launcher opens the panel; the panel arms pin-drop mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await unlock(page);
  });

  test("activating the launcher opens the panel without arming pin-drop mode", async ({ page }) => {
    const toggle = unlockedToggle(page);
    // The name says what pressing it does, and nothing else — it no longer
    // advertises the `c` shortcut, because it no longer performs it. The
    // count clause is only present when there is something to count, and
    // other specs in this run may have left threads on this same page, so
    // match the shape rather than a fixed number.
    await expect(toggle).toHaveAccessibleName(/^Open the review panel(\. \d+ open on this page)?$/);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".r3wr-panel")).toHaveCount(0);

    await openPanel(page);

    await expect(page.getByRole("dialog", { name: "Feedback on this page" })).toBeVisible();
    await expect(toggle).toHaveAccessibleName("Close the review panel");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // The load-bearing half: none of picking mode came with it. The hint and
    // the scrim are what `OverlayRoot` renders while `pinDropMode` is on, and
    // `r3wr-picking` is the crosshair-cursor class it puts on the document.
    await expect(page.locator(".r3wr-capture-hint")).toHaveCount(0);
    await expect(page.locator(".r3wr-capture")).toHaveCount(0);
    await expect(page.locator("html.r3wr-picking")).toHaveCount(0);
    await expect(newCommentButton(page)).toHaveAttribute("aria-pressed", "false");

    // And it really is a toggle, not a one-way open.
    await toggle.click();
    await expect(page.locator(".r3wr-panel")).toHaveCount(0);
  });

  test("the c shortcut arms pin-drop mode without opening the panel", async ({ page }) => {
    await page.keyboard.press("c");
    await expect(page.locator(".r3wr-capture-hint")).toBeVisible();
    // The same separation pointing the other way: someone who wants to pin
    // something has not asked to read the list.
    await expect(page.locator(".r3wr-panel")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(page.locator(".r3wr-capture-hint")).toHaveCount(0);
    await expect(page.locator(".r3wr-panel")).toHaveCount(0);
  });

  test("the panel's New comment button arms pin-drop mode, and the pin saves through the normal flow", async ({
    page,
  }, testInfo) => {
    const mark = marker(testInfo.title);
    // A leaf heading no other spec pins, so a marker from an earlier test in
    // this run can never leave a pin sitting over this one's click point
    // (the database is not reset between tests).
    const target = page.getByTestId("features-heading");

    const panel = await openPanel(page);
    const newComment = newCommentButton(page);
    await expect(newComment).toHaveAttribute("aria-pressed", "false");
    await expect(newComment).toHaveAccessibleName(
      "New comment. Select the words or the element to comment on",
    );

    await newComment.click();
    await expect(newComment).toHaveAttribute("aria-pressed", "true");
    await expect(newComment).toHaveAccessibleName("Cancel adding a comment");
    await expect(page.locator(".r3wr-capture-hint")).toBeVisible();

    // One control, both directions: pressing it again disarms.
    await newComment.click();
    await expect(newComment).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".r3wr-capture-hint")).toHaveCount(0);

    await newComment.click();
    await expect(page.locator(".r3wr-capture-hint")).toBeVisible();
    await target.click();

    // The panel stayed open the whole time, so this is also the case the
    // composer's own clamp exists for: it must position itself clear of the
    // panel, or its submit button lands underneath it and nothing can be
    // saved at all. Assert the boxes, not the intent.
    const composer = page.locator(".r3wr-composer");
    await expect(composer).toBeVisible();
    const composerBox = await composer.boundingBox();
    const panelBox = await panel.boundingBox();
    if (!composerBox || !panelBox) throw new Error("composer/panel has no bounding box");
    expect(
      composerBox.x + composerBox.width,
      `the composer's right edge (${composerBox.x + composerBox.width}) should stop before the right-docked panel's left edge (${panelBox.x})`,
    ).toBeLessThanOrEqual(panelBox.x);

    await fillAndSubmitComposer(page, {
      category: "Design",
      title: `Panel-armed pin ${mark}`,
      body: `Dropped from the panel's own button ${mark}`,
      name: "E2E Reviewer",
    });

    const pin = pinByTitleText(page, mark);
    await expect(pin).toBeVisible();
    await expect(pin).toHaveAttribute("data-drifted", "false");

    // Straight from Postgres — "saved" means a row, not a rendered pin.
    const threads = await findThreadsByCommentMarker(mark);
    expect(threads, `exactly one thread should carry a comment matching ${mark}`).toHaveLength(1);
    const thread = expectSingle(threads, `threads matching ${mark}`);
    expect(thread.title).toBe(`Panel-armed pin ${mark}`);
    expect(thread.category).toBe("design");
    expect(thread.status).toBe("open");
  });
});
