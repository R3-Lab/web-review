/**
 * Scenario 6 — reply and resolve. Opens a thread from the panel's list,
 * posts a reply, resolves it, and asserts both persisted in Postgres and
 * that the UI reflects the new status.
 */

import { test, expect } from "@playwright/test";
import { commentsForThread, findThreadsByCommentMarker } from "./db";
import { dropElementPin, expectSingle, marker, openPanel, unlock } from "./helpers";

test.describe("reply and resolve", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await unlock(page);
  });

  test("replying and resolving a thread persists to Postgres and updates the UI", async ({ page }, testInfo) => {
    const mark = marker(testInfo.title);
    const title = `Reply/resolve check ${mark}`;
    const target = page.getByTestId("hero-heading");

    await dropElementPin(page, target, {
      category: "Other",
      title,
      body: `Opening comment ${mark}`,
      name: "E2E Reviewer",
    });

    // submitThread leaves the panel open on the just-created thread's detail
    // — close it and re-open it via the LIST, to genuinely exercise "open
    // the thread from the panel" rather than relying on that auto-open.
    const panel = page.getByRole("dialog", { name: "Thread" });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close the review panel" }).click();
    await expect(panel).toHaveCount(0);

    // Re-open it the only way a reviewer can now: the launcher. This used to
    // press "c" and then Escape, which worked back when arming pin-drop mode
    // also opened the panel — it no longer does either job for the other, so
    // that sequence now leaves the panel shut. Re-opening lands on the
    // DETAIL view of the thread just created (closing the panel doesn't
    // clear the selection), so step back to the list explicitly.
    await openPanel(page);
    await page.getByRole("dialog", { name: "Thread" }).getByRole("button", { name: "All feedback" }).click();
    const list = page.getByRole("dialog", { name: "Feedback on this page" });
    await expect(list).toBeVisible();
    await list.locator(".r3wr-thread", { hasText: title }).click();

    const detail = page.getByRole("dialog", { name: "Thread" });
    await expect(detail).toBeVisible();
    await expect(detail.getByText(title)).toBeVisible();

    // ── reply ────────────────────────────────────────────────────────────
    const replyBody = `A reply worth persisting ${mark}`;
    await detail.getByLabel("Reply").fill(replyBody);
    await detail.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(detail.getByText(replyBody)).toBeVisible();

    // ── resolve ──────────────────────────────────────────────────────────
    await expect(detail.locator(".r3wr-status")).toHaveAttribute("data-status", "open");
    await detail.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(detail.locator(".r3wr-status")).toHaveAttribute("data-status", "resolved");
    await expect(detail.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();

    // ── straight from Postgres ──────────────────────────────────────────
    const threads = await findThreadsByCommentMarker(mark);
    expect(threads).toHaveLength(1);
    const thread = expectSingle(threads, `threads matching ${mark}`);
    expect(thread.status).toBe("resolved");
    expect(thread.resolved_at).not.toBeNull();

    const comments = await commentsForThread(thread.id);
    expect(comments.map((c) => c.body)).toEqual(
      expect.arrayContaining([`Opening comment ${mark}`, replyBody]),
    );
    expect(comments).toHaveLength(2);
  });
});
