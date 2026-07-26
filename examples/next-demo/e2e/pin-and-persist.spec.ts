/**
 * Scenarios 2 & 3 — pin drop → composer → submit, and persistence: the
 * created thread and its opening comment land in Postgres, with the
 * `anchor` JSONB intact (the exact shape `core/types.ts`'s `Anchor`
 * describes, round-tripped verbatim per the schema's own design note).
 */

import { test, expect } from "@playwright/test";
import { findThreadsByCommentMarker } from "./db";
import { dropElementPin, expectSingle, marker, pinByTitleText, unlock } from "./helpers";

test.describe("pin drop, composer, submit — and persistence", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await unlock(page);
  });

  test("dropping a pin on an element creates a thread that appears on the page and in Postgres, anchor JSONB intact", async ({
    page,
  }, testInfo) => {
    const mark = marker(testInfo.title);
    // A leaf element (a button, no nested block children) deliberately —
    // `captureAnchor` anchors to whatever is DEEPEST under the click point
    // (`document.elementFromPoint`), so clicking a container with nested
    // text (e.g. a feature card's `<article>`) anchors to whichever child
    // happens to sit under the click, not the container itself. A leaf
    // keeps "what got clicked" and "what got anchored" the same element,
    // which is what this test's tagName/selector assertions rely on.
    const target = page.getByTestId("cta-secondary");

    await dropElementPin(page, target, {
      category: "Bug",
      title: `CTA button note ${mark}`,
      body: `This is the E2E first comment ${mark}`,
      name: "E2E Reviewer",
    });

    // The pin renders on the page immediately (no reload) — `submitThread`
    // merges the new thread into overlay state and selects it.
    const pin = pinByTitleText(page, mark);
    await expect(pin).toBeVisible();
    await expect(pin).toHaveAttribute("data-status", "open");
    await expect(pin).toHaveAttribute("data-drifted", "false");

    // Now prove it independently, straight from Postgres — no app code involved.
    const threads = await findThreadsByCommentMarker(mark);
    expect(threads, `exactly one thread should carry a comment matching ${mark}`).toHaveLength(1);
    const thread = expectSingle(threads, `threads matching ${mark}`);

    expect(thread.category).toBe("bug");
    expect(thread.title).toBe(`CTA button note ${mark}`);
    expect(thread.author_name).toBe("E2E Reviewer");
    expect(thread.status).toBe("open");
    expect(thread.url_key).toBe("/");

    // The anchor is opaque per the schema's design note, but its SHAPE is
    // owned by this package's `Anchor` type (core/types.ts) — assert the
    // structural contract round-tripped verbatim, not just "some JSON landed".
    const anchor = thread.anchor as Record<string, unknown>;
    expect(anchor.kind).toBe("element");
    expect(anchor.tagName).toBe("button");
    expect(typeof anchor.selector).toBe("string");
    expect(anchor.selector as string).toContain("cta-secondary");
    expect(anchor.rect).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      w: expect.any(Number),
      h: expect.any(Number),
    });
    expect(anchor.offsetPct).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    expect(anchor.viewport).toMatchObject({ w: expect.any(Number), h: expect.any(Number) });
    expect(anchor.href as string).toContain("/");

    expect(thread.viewport).toMatchObject({ w: expect.any(Number), h: expect.any(Number) });
  });
});
