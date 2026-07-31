/**
 * The launcher docks to the edge it is moved to, remembers it, and takes the
 * panel with it.
 *
 * The launcher used to be nailed to the bottom-right corner — the same
 * corner real sites put their chat widgets and cookie banners in, so a
 * reviewer could be asked to review something the review button was sitting
 * on top of. It is now draggable to any viewport edge, snaps to the nearest
 * one on release, and persists to localStorage.
 *
 * Two things here are only provable in a real browser, which is why they
 * live in this suite rather than in the package's jsdom unit tests: the
 * localStorage round trip survives an actual page load (the position is read
 * in a lazy `useState` initializer, so a regression would show up as a
 * launcher springing back to the corner), and the panel really is laid out
 * against the opposite edge rather than merely carrying an attribute.
 */

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openPanel, unlock, unlockedToggle } from "./helpers";

/** `launcherPositionStorageKey("r3wr")` — the demo leaves `storagePrefix` at its default. */
const LAUNCHER_KEY = "r3wr.launcher";

/** The persisted position, parsed. `null` when the overlay has never written one. */
async function storedPosition(page: Page): Promise<{ edge: string; offset: number } | null> {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), LAUNCHER_KEY);
  return raw === null ? null : (JSON.parse(raw) as { edge: string; offset: number });
}

test.describe("launcher position", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await unlock(page);
  });

  test("dragging the launcher docks it to the nearest edge, and it stays there across a reload", async ({
    page,
  }) => {
    const toggle = unlockedToggle(page);
    // Nothing written yet: the default (bottom of the right edge) is a value
    // in code, not a row in storage.
    await expect(toggle).toHaveAttribute("data-edge", "right");
    expect(await storedPosition(page)).toBeNull();

    const before = await toggle.boundingBox();
    if (!before) throw new Error("launcher has no bounding box");
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport size");

    // Grab it dead-centre, so the pill's centre — which is what `snapToEdge`
    // measures, not the pointer — tracks the cursor exactly. Release it a
    // quarter of the way down the left half of the window: nearest edge is
    // unambiguously the left one, and the offset lands at a clean 0.5.
    const dropX = Math.round(viewport.width * 0.1);
    const dropY = Math.round(viewport.height * 0.5);
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(dropX, dropY, { steps: 12 });
    // Genuinely in flight — past the 5px threshold, following the pointer on
    // inline styles rather than still parked on its docked insets.
    await expect(toggle).toHaveAttribute("data-dragging", "true");
    await page.mouse.up();

    await expect(toggle).toHaveAttribute("data-edge", "left");
    await expect(toggle).not.toHaveAttribute("data-dragging", "true");
    // It moved on screen, not just in an attribute. Polled, because the snap
    // is a CSS transition on `top`/`left`.
    await expect
      .poll(async () => (await toggle.boundingBox())?.x ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(viewport.width / 2);

    // A real drag is not a press: releasing the launcher must not also
    // activate it (`suppressNextClick` in `launcher.tsx`).
    await expect(page.locator(".r3wr-panel")).toHaveCount(0);

    // Persisted as an edge plus a 0..1 fraction ALONG that edge, never a
    // pixel pair — that is what lets the same value survive a resize, or a
    // different machine, without landing the button off-screen.
    const stored = await storedPosition(page);
    expect(stored?.edge).toBe("left");
    expect(stored?.offset, "released at half the viewport height").toBeCloseTo(0.5, 2);

    // ── the round trip ──────────────────────────────────────────────────
    await page.reload();
    await expect(unlockedToggle(page)).toBeVisible();
    await expect(unlockedToggle(page)).toHaveAttribute("data-edge", "left");
    const afterReload = await unlockedToggle(page).boundingBox();
    if (!afterReload) throw new Error("launcher has no bounding box after reload");
    expect(afterReload.x).toBeLessThan(viewport.width / 2);

    // ── and the panel follows it ────────────────────────────────────────
    // `panelSideForEdge`: left is the one arrangement where a right-docked
    // panel would cover the button that opened it.
    const panel = await openPanel(page);
    await expect(panel).toHaveAttribute("data-side", "left");
    await expect(page.locator(".r3wr-root[data-panel-side='left']")).toHaveCount(1);
    const panelBox = await panel.boundingBox();
    if (!panelBox) throw new Error("panel has no bounding box");
    expect(panelBox.x, "a left-docked panel starts at the left viewport edge").toBeLessThan(1);
  });

  test("arrow keys dock the launcher too, while it has focus", async ({ page }) => {
    const toggle = unlockedToggle(page);
    await expect(toggle).toHaveAttribute("data-edge", "right");

    // WCAG 2.5.7 (Dragging Movements): every edge the launcher can be dragged
    // to has to be reachable without a drag. Focusing the button is the
    // precondition the panel's shortcut strip states — these are not global
    // bindings.
    await toggle.focus();

    await page.keyboard.press("ArrowUp");
    await expect(toggle).toHaveAttribute("data-edge", "top");
    await page.keyboard.press("ArrowLeft");
    await expect(toggle).toHaveAttribute("data-edge", "left");

    // Only the edge changes — the position ALONG the edge is carried over,
    // so an arrow key never also throws away where the reviewer parked it.
    expect(await storedPosition(page)).toEqual({ edge: "left", offset: 1 });

    // Enter still activates the button it just moved: the keydown handler
    // claims the four arrows and leaves every other key alone.
    await page.keyboard.press("Enter");
    await expect(page.locator(".r3wr-panel")).toHaveCount(1);
  });
});
