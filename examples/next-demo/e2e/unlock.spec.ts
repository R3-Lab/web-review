/**
 * Scenario 1 — unlock. Real browser, real Postgres-backed API: the launcher
 * is visible while locked, a wrong password surfaces an inline error and
 * leaves the gate locked, and the correct password unlocks it.
 */

import { test, expect } from "@playwright/test";
import { REVIEW_PASSWORD } from "./constants";
import { assertUnlockRejected, lockedToggle, unlock, unlockedToggle } from "./helpers";

test.describe("unlock", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("the locked launcher is visible on a fresh visit", async ({ page }) => {
    await expect(lockedToggle(page)).toBeVisible();
    await expect(lockedToggle(page)).toHaveAttribute("aria-label", /locked/i);
    await expect(unlockedToggle(page)).toHaveCount(0);
  });

  test("a wrong password is rejected with an inline error and the gate stays locked", async ({ page }) => {
    await assertUnlockRejected(page, "definitely-not-the-password");
    await expect(lockedToggle(page)).toBeVisible();
  });

  test("the correct password unlocks the overlay", async ({ page }) => {
    await unlock(page, REVIEW_PASSWORD);
    await expect(unlockedToggle(page)).toBeVisible();
    await expect(lockedToggle(page)).toHaveCount(0);
  });
});
