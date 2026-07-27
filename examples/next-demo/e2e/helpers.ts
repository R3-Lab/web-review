/**
 * Shared browser-driving helpers for the E2E suite. Every helper drives the
 * REAL overlay DOM exactly the way a reviewer would — keyboard shortcut,
 * real clicks, real form fills — never `page.evaluate`-ing overlay state
 * directly. `page.evaluate` is used only in `helpers.ts`/spec files for
 * reading DOM geometry (bounding rects) or, in the drift spec, for
 * simulating a real page mutation — never to shortcut the overlay's own
 * interaction model.
 */

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { REVIEW_PASSWORD } from "./constants";

/** The locked launcher toggle — see `overlay-root.tsx`'s locked-gate render branch. */
export function lockedToggle(page: Page): Locator {
  return page.locator(".r3wr-toggle[data-locked='true']");
}

/** The unlocked launcher toggle (the "Review"/pin-drop button) — absent while locked. */
export function unlockedToggle(page: Page): Locator {
  return page.locator(".r3wr-toggle:not([data-locked])");
}

/**
 * Opens the locked launcher's password dialog, types `password`, submits,
 * and waits for the gate to flip to unlocked (the locked toggle disappears,
 * replaced by the pin-drop toggle).
 */
export async function unlock(page: Page, password: string = REVIEW_PASSWORD): Promise<void> {
  await lockedToggle(page).click();
  const dialog = page.getByRole("dialog", { name: "Unlock review" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Review password").fill(password);
  await dialog.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(lockedToggle(page)).toHaveCount(0);
  await expect(unlockedToggle(page)).toBeVisible();
}

/** Asserts the unlock dialog rejects a wrong password with an inline error, and never flips the gate. */
export async function assertUnlockRejected(page: Page, wrongPassword: string): Promise<void> {
  await lockedToggle(page).click();
  const dialog = page.getByRole("dialog", { name: "Unlock review" });
  await dialog.getByPlaceholder("Review password").fill(wrongPassword);
  await dialog.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(lockedToggle(page)).toBeVisible();
  // Close the dialog so it doesn't linger for whatever the caller does next.
  await dialog.getByRole("button", { name: "Close" }).click();
}

export interface ComposerFields {
  /** Category radio's accessible name, e.g. "Design" | "Copy" | "Bug" | "Other". Defaults to whatever the composer pre-selects. */
  category?: string;
  title?: string;
  body: string;
  name?: string;
}

/** Fills the open composer and submits it, waiting for it to close (i.e. the thread was created). */
export async function fillAndSubmitComposer(page: Page, fields: ComposerFields): Promise<void> {
  const composer = page.locator(".r3wr-composer");
  await expect(composer).toBeVisible();

  if (fields.category) {
    await composer.getByRole("radio", { name: fields.category }).click();
  }
  if (fields.title !== undefined) {
    await composer.getByLabel("Title (optional)").fill(fields.title);
  }
  await composer.getByLabel("Comment").fill(fields.body);

  const nameField = composer.getByLabel("Your name");
  if (fields.name !== undefined && (await nameField.count()) > 0) {
    await nameField.fill(fields.name);
  }

  await composer.getByRole("button", { name: "Add feedback" }).click();
  await expect(composer).toHaveCount(0);
}

/**
 * Scrolls so `locator`'s vertical CENTER (i.e. where a centered click
 * lands) sits ~60px below the viewport top — maximum headroom for the
 * composer below the click point, regardless of the target's own height.
 *
 * Working around a real bug found while writing this suite: the composer
 * (`composer.tsx`) positions itself with
 * `top = Math.max(8, Math.min(vy + 16, window.innerHeight - 160))` — that
 * clamp only guarantees ~160px of headroom below the click point, but the
 * composer's actual content (category picker + title + comment + name +
 * screenshot note + the submit/cancel buttons) is routinely ~450-500px
 * tall. A pin dropped anywhere in roughly the lower two-thirds of the
 * viewport renders a composer whose "Add feedback" button is BELOW the
 * viewport's bottom edge — and unreachable by scrolling, since the
 * composer is `position: fixed` (page scroll does nothing to it) and its
 * own `overflow-y: auto` only helps when CONTENT exceeds the box, not when
 * the box itself is positioned partly off-screen. A real reviewer clicking
 * near the bottom of their window would hit the exact same dead end. See
 * the task write-up for a screenshot. Filed as a package bug, not fixed
 * here (out of this suite's scope) — this helper keeps every drop's click
 * point near the top of the viewport so the suite isn't blocked by it.
 *
 * The companion horizontal half of this problem (the composer can also
 * render partially BEHIND the always-open `.r3wr-panel`, a fixed 384px
 * dock on the right) is worked around at the project level instead —
 * see `playwright.config.ts`'s `viewport` — since it depends on the
 * demo's own `860px` content max-width, not on any one element's position.
 */
async function positionNearViewportTop(locator: Locator): Promise<void> {
  await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    window.scrollBy(0, centerY - 60);
  });
}

/**
 * Presses "c" to enter pin-drop mode, clicks `locator` (dead-center, so the
 * captured `offsetPct` lands very close to `{x:0.5, y:0.5}` — scenario 4's
 * position check relies on this), fills the composer, and submits.
 */
export async function dropElementPin(page: Page, locator: Locator, fields: ComposerFields): Promise<void> {
  await positionNearViewportTop(locator);
  await page.keyboard.press("c");
  await expect(page.locator(".r3wr-capture-hint")).toBeVisible();
  await locator.click();
  await fillAndSubmitComposer(page, fields);
}

/** A pin's DOM element, located by the (native `title` attribute) summary text the Pin component renders — see `pin.tsx`. Unique as long as callers embed a distinctive marker in their comment's `title`. */
export function pinByTitleText(page: Page, titleText: string): Locator {
  return page.locator(`.r3wr-pin[title*="${titleText}"]`);
}

/** The document-coordinate-independent viewport center of an element's bounding box. */
export async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element has no bounding box (not visible/attached)");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The visual TIP of a `.r3wr-pin`/`.r3wr-pin-draft` marker — the pointed
 * corner meant to touch its anchor — as opposed to `centerOf`'s
 * bounding-box center. `.r3wr-pin` is a 30×30 box, `border-radius:
 * 50% 50% 50% 0`, `rotate(-45deg)`, positioned so its tip lands on the
 * anchor point (see that rule's CSS comment in `overlay.css` for the exact
 * margin derivation). For that specific shape and rotation, the tip works
 * out to exactly the bounding box's own bottom-center point — no need to
 * replicate the rotation math here, just read it off `boundingBox()`.
 */
export async function tipOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element has no bounding box (not visible/attached)");
  return { x: box.x + box.width / 2, y: box.y + box.height };
}

/**
 * Finds the substring's bounding client rect inside `container` via a
 * throwaway `Range` (never mutates the live selection) — used to compute
 * real mouse-drag coordinates for a genuine text selection gesture.
 */
export async function rectOfSubstring(
  container: Locator,
  substring: string,
): Promise<{ left: number; top: number; right: number; bottom: number; width: number; height: number }> {
  const rect = await container.evaluate((el: Element, needle: string) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      const idx = text.indexOf(needle);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needle.length);
        const r = range.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      }
    }
    return null;
  }, substring);
  if (!rect) throw new Error(`Substring "${substring}" not found as a single text node inside the container`);
  return rect;
}

/**
 * Performs a REAL mouse drag-select over `phrase` inside `container` (a
 * native browser text selection, not a scripted `Selection` object), then
 * enters pin-drop mode and clicks inside the highlighted text — the exact
 * "select words, press c, click the highlight" gesture
 * `overlay-root.tsx`'s own doc comment describes, so the anchor's `kind`
 * ends up `"text"` for real, not merely asserted to be.
 */
export async function dropTextPin(page: Page, container: Locator, phrase: string, fields: ComposerFields): Promise<void> {
  await positionNearViewportTop(container);
  const rect = await rectOfSubstring(container, phrase);
  const y = rect.top + rect.height / 2;
  await page.mouse.move(rect.left + 1, y);
  await page.mouse.down();
  await page.mouse.move(rect.right - 1, y, { steps: 5 });
  await page.mouse.up();

  // Confirm the drag actually produced a live selection containing the phrase before proceeding — a failed/short drag here would silently degrade to an element pin, defeating the whole point of this scenario.
  const selectedNow = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selectedNow, "the mouse drag should have produced a live text selection").toContain(phrase);

  await page.keyboard.press("c");
  await expect(page.locator(".r3wr-capture-hint")).toBeVisible();
  await page.mouse.click(rect.left + rect.width / 2, y);
  await fillAndSubmitComposer(page, fields);
}

/** A unique-enough marker for one test's rows, so assertions never pick up another test's data even though the database isn't reset between tests in a single run. */
export function marker(testTitle: string): string {
  const slug = testTitle.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40);
  return `E2E-${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Narrows `items` to its one element via a real control-flow check
 * (destructure + `throw` on the way out for anything but exactly one),
 * never a non-null assertion — an earlier `expect(items).toHaveLength(1)`
 * already reports the count mismatch with a Playwright-formatted diff;
 * this is what actually gives callers a non-`| undefined` value to use
 * afterward.
 */
export function expectSingle<T>(items: readonly T[], label: string): T {
  const [only, extra] = items;
  if (only === undefined || extra !== undefined) {
    throw new Error(`${label}: expected exactly one item, got ${items.length}`);
  }
  return only;
}
