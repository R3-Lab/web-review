/**
 * Pins must not trap the page's own clicks.
 *
 * The bug this file exists for, reported from a real integration: a pin
 * dropped on (or just above) a link makes that link unusable. The marker is a
 * real `<button>` in the pin layer, it renders ABOVE its anchor — tip on the
 * point, body rising from there — and it used to be the only thing at that
 * point that could take a click. Playwright reports it exactly as a reviewer
 * experiences it: "Element is covered by `<button.r3wr-pin>` at its click
 * point." There was no way out from either side: a reviewer could not turn
 * the pins off, and a consumer embedding the overlay could not either.
 *
 * Three escapes now exist, and all three are driven here:
 *   - the panel's persisted **Pins** switch (off ⇒ no marker in the document)
 *   - a **held key** that makes the whole pin layer click-through for exactly
 *     as long as it is down
 *   - a **trimmed hit area**, so the parts of the marker's 30×30 box that
 *     nothing is painted in stop catching clicks at all
 *
 * The link is injected with `page.evaluate` because the demo page has none —
 * it is a landing page of headings, cards and buttons. That is the same use
 * `drift.spec.ts` puts `evaluate` to (simulating a real page mutation), not
 * the forbidden one: no overlay state is set here, every escape below is
 * driven through the real UI, and the injected element is an ordinary
 * same-origin `<a>` whose navigation is what the assertions actually watch
 * for. `app/page.tsx` is left alone rather than gaining a test-only link.
 *
 * This is also the one spec in the suite that cleans up after itself, and the
 * injected link is why. Every other spec pins a real element of the demo
 * page, so its threads re-bind on the next load and its pins sit where they
 * always sat — harmless, and in the persistence specs the whole point. A
 * thread anchored to an element that only ever existed in one test is
 * different: on the next load nothing matches it, so it becomes an
 * unplaceable pin drawn at its captured document position — in the CTA
 * section, which four later specs click in. The `afterEach` below removes
 * exactly the rows each test made, by its own unique marker.
 */

import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { deleteThreadsByCommentMarker } from "./db";
import { centerOf, fillAndSubmitComposer, marker, pinByTitleText, tipOf, unlock } from "./helpers";

/** The id every test's injected link carries — see the file header for why it is shared. */
const LINK_ID = "e2e-nav-link";

/** How far above the link's bottom edge the pin is dropped, in px. */
const DROP_INSET = 4;

/** The link's height, chosen so the marker's body lands squarely over its middle. */
const LINK_HEIGHT = 56;

/**
 * Half the diagonal of the marker's 30×30 box — i.e. how far its centre sits
 * above its tip once `rotate(-45deg)` is applied. `overlay.css`'s `.r3wr-pin`
 * rule derives this same number (`15 * √2`) for its own `margin-top`, and
 * `tipOf` reads the tip off the rendered box rather than re-deriving it.
 */
const PIN_CENTRE_ABOVE_TIP = 21.213;

/**
 * Appends a real, same-origin navigation link to the demo page's CTA section
 * and hands back its locator.
 *
 * Sized here rather than left to the stylesheet because the geometry is the
 * point: at {@link LINK_HEIGHT} tall, a pin dropped {@link DROP_INSET}px above
 * the link's bottom edge puts its ~42px-tall body straight over the link's
 * centre — which is where Playwright, and a reviewer, clicks.
 */
async function addNavLink(page: Page, href: string): Promise<Locator> {
  await page.evaluate(
    ({ href, id, height }) => {
      const link = document.createElement("a");
      link.id = id;
      link.setAttribute("data-testid", id);
      link.href = href;
      link.textContent = "Read the changelog";
      Object.assign(link.style, {
        display: "block",
        width: "260px",
        height: `${height}px`,
        lineHeight: `${height}px`,
        textAlign: "center",
        marginTop: "24px",
        border: "1px solid currentColor",
        borderRadius: "8px",
      });
      document.querySelector('[data-testid="cta"]')?.appendChild(link);
    },
    { href, id: LINK_ID, height: LINK_HEIGHT },
  );

  const link = page.getByTestId(LINK_ID);
  await expect(link).toBeVisible();
  return link;
}

/**
 * Drops a pin whose body covers `link`'s centre — pin-drop mode via the `c`
 * shortcut, a real click {@link DROP_INSET}px above the link's bottom edge,
 * then the composer filled and submitted — and hands back the new marker.
 *
 * Submitting opens the panel on the thread it just created (`submitThread` in
 * `overlay-root.tsx`: showing a reviewer the result of what they did), so the
 * panel is already up when this resolves; callers that need it do not have to
 * press the launcher, and callers that do not are unaffected — the panel docks
 * to the far right of an 1800px viewport, well clear of the 860px content
 * column this link lives in.
 */
async function dropPinOverLink(page: Page, link: Locator, mark: string): Promise<Locator> {
  const box = await link.boundingBox();
  if (!box) throw new Error("the injected link has no bounding box");

  await page.keyboard.press("c");
  await expect(page.locator(".r3wr-capture-hint")).toBeVisible();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - DROP_INSET);
  await fillAndSubmitComposer(page, {
    title: `Link-covering pin ${mark}`,
    body: `This pin sits on a navigation link ${mark}`,
    name: "E2E Reviewer",
  });

  const pin = pinByTitleText(page, mark);
  await expect(pin).toBeVisible();
  // Wait out `r3wr-pin-in`. The marker scales up as it arrives, so a
  // `boundingBox()` taken the moment it becomes visible reads a box part-way
  // through that — measured at ~35px across instead of its resting 42.43 —
  // and every point derived from it would be wrong by several px.
  await pin.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return pin;
}

/**
 * What would actually receive a click at this viewport point: the element's
 * `class`, or its tag name when it has none.
 *
 * A read, not a state change — the same use of `evaluate` the rest of the
 * suite makes of it. Probing the block this way rather than by letting a
 * `link.click()` time out is deliberate twice over: it names the covering
 * element the way the bug report did, and it cannot accidentally succeed and
 * navigate the page out from under the test that was meant to observe it.
 */
async function topmostAt(page: Page, point: { x: number; y: number }): Promise<string> {
  return page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return "(nothing)";
    return el.getAttribute("class") || el.tagName.toLowerCase();
  }, point);
}

test.describe("pins do not trap the page's clicks", () => {
  /**
   * This test's unique marker, minted once so the `afterEach` can delete
   * exactly the rows the test created. Module-scoped rather than returned
   * from a helper because `afterEach` needs the same value the test used, and
   * `marker()` mints a fresh one on every call. Safe: `fullyParallel: false`
   * runs a file's tests one at a time, and a parallel worker gets its own
   * module instance.
   */
  let mark = "";

  test.beforeEach(async ({ page }, testInfo) => {
    mark = marker(testInfo.title);
    await page.goto("/");
    await unlock(page);
  });

  test.afterEach(async () => {
    await deleteThreadsByCommentMarker(mark);
  });

  test("hiding the pins hands a covered link back", async ({ page }) => {
    const link = await addNavLink(page, `/?nav=${encodeURIComponent(mark)}`);
    await dropPinOverLink(page, link, mark);

    // The premise, stated the way the bug report stated it: the marker, not
    // the link, is what a click at the link's own click point would reach.
    const target = await centerOf(link);
    expect(await topmostAt(page, target)).toContain("r3wr-pin");

    // The way out. The panel is already open on the thread just created;
    // switch the pins off from its header and the markers leave the document
    // altogether — an element that is merely faded is still an element that
    // takes clicks.
    const panel = page.locator(".r3wr-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("checkbox", { name: "Pins", exact: true }).uncheck();
    await expect(page.locator(".r3wr-pin")).toHaveCount(0);

    // Highlights are a separate switch and must not have gone with them.
    await expect(panel.getByRole("checkbox", { name: "Highlights" })).toBeChecked();

    // And now the link is a link again. `link.click()` runs Playwright's full
    // actionability check, so this is the exact operation that used to fail.
    expect(await topmostAt(page, target)).toBe("a");
    await Promise.all([page.waitForURL(/nav=/), link.click()]);
  });

  test("holding the pass-through key hands it back for exactly as long as it is held", async ({
    page,
  }) => {
    const link = await addNavLink(page, `/?nav=${encodeURIComponent(mark)}`);
    await dropPinOverLink(page, link, mark);

    // Put focus back on the page before typing. The key is deliberately
    // ignored while a text field has focus, and the composer this test just
    // submitted is exactly the sort of thing that can leave focus in one.
    await page.getByTestId("hero-heading").click();

    const layer = page.locator(".r3wr-pin-layer");
    const target = await centerOf(link);
    expect(await topmostAt(page, target)).toContain("r3wr-pin");

    // Down: the whole layer stops catching anything.
    await page.keyboard.down("h");
    await expect(layer).toHaveAttribute("data-passthrough", "true");
    expect(await topmostAt(page, target)).toBe("a");

    // Up: it takes the clicks straight back. Momentary means momentary — a
    // reviewer who wants the markers gone for good has the switch instead.
    await page.keyboard.up("h");
    await expect(layer).toHaveAttribute("data-passthrough", "false");
    expect(await topmostAt(page, target)).toContain("r3wr-pin");

    // The markers stay visible throughout: this escape costs a reviewer
    // nothing, which is the whole reason it exists next to the switch.
    await expect(page.locator(".r3wr-pin").first()).toBeVisible();

    // And held, the click really does reach the page.
    await page.keyboard.down("h");
    await Promise.all([page.waitForURL(/nav=/), link.click()]);
    await page.keyboard.up("h");
  });

  test("the marker's box catches clicks only where the marker is drawn", async ({ page }) => {
    const link = await addNavLink(page, `/?nav=${encodeURIComponent(mark)}`);
    const pin = await dropPinOverLink(page, link, mark);

    // The marker is a 30×30 box rotated -45°, so its corners reach ~21.2px out
    // along the four diagonals while the round body it paints reaches only
    // 15px. `tipOf` gives the bottom vertex — the tip, which touches the
    // anchor — and the box's centre sits `PIN_CENTRE_ABOVE_TIP` above it.
    const tip = await tipOf(pin);
    const centre = { x: tip.x, y: tip.y - PIN_CENTRE_ABOVE_TIP };

    // 19px to the left of that centre: inside the box's own left vertex,
    // outside the painted teardrop by 4px. Nothing is drawn here, so nothing
    // should be catching clicks here either — and what is underneath is the
    // link, because the marker's body is sitting over its middle.
    const corner = { x: centre.x - 19, y: centre.y };
    expect(await topmostAt(page, corner)).toBe("a");

    // Dead centre, by contrast, is the marker and stays the marker. This
    // trims what catches a click; it does not move or shrink what is drawn,
    // and the pin is still a button a reviewer can press.
    expect(await topmostAt(page, centre)).toContain("r3wr-pin");

    // A raw click at the corner point, with no actionability check to route
    // around the marker: if the box were still catching it, the pin would
    // open its own thread and no navigation would happen at all.
    await Promise.all([page.waitForURL(/nav=/), page.mouse.click(corner.x, corner.y)]);
  });
});
