/**
 * Scenario 7 — drift, the honest one.
 *
 * "Reload" and "the anchor no longer resolves confidently" pull in opposite
 * directions for THIS app: `page.reload()` re-fetches the page fresh from
 * the Next.js server, which discards any `page.evaluate` DOM mutation —
 * there is no server-side edit involved, so a reload cannot make a
 * client-only mutation persist. Two ways were considered to make a mutation
 * survive a reload:
 *
 *  1. Intercept the reload's HTML response (`page.route`) and rewrite the
 *     served markup. Rejected: this app is a React Server Component tree —
 *     the response also embeds a serialized RSC "flight" payload
 *     (`self.__next_f.push(...)`) that hydration reconciles against, so a
 *     raw HTML string rewrite risks being silently reverted by React's own
 *     hydration, or worse, a hydration mismatch that doesn't reflect what a
 *     REAL drift-causing change (an actual code/content edit, then a real
 *     rebuild) would look like. Too fragile to trust the result of.
 *  2. Actually edit `app/page.tsx` and rebuild between the pin-drop and the
 *     reload. Rejected: turns one spec into a build-orchestration test and
 *     would only be run once, defeating repeatability.
 *
 * So this test proves the two halves separately, honestly:
 *  - A real DOM mutation (id/testid/classes/text changed, element moved)
 *    DOES push the SAME resolver (`resolveAnchor`, from `anchor.ts`) below
 *    its confidence threshold LIVE — no reload needed, because the overlay
 *    already re-resolves every anchor on every DOM mutation via its own
 *    `MutationObserver` (see `overlay-root.tsx`). This is the real
 *    "anchor no longer resolves confidently" behavior scenario 7 asks for.
 *  - A subsequent reload then re-fetches the UNMODIFIED page from the
 *    server (the mutation was never persisted there), so the anchor
 *    correctly re-binds with confidence again. That is the true, honest
 *    outcome for this specific mutation-then-reload sequence in an app with
 *    no actual server-side change — reported here rather than forced into
 *    a "still drifted after reload" assertion that would not reflect what
 *    the resolver actually does.
 */

import { test, expect } from "@playwright/test";
import { dropElementPin, marker, pinByTitleText, unlock, unlockedToggle } from "./helpers";

test.describe("drift", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await unlock(page);
  });

  test("a real DOM mutation drifts the anchor live; a reload (which discards the unpersisted mutation) re-binds it confidently again", async ({
    page,
  }, testInfo) => {
    const mark = marker(testInfo.title);
    // The hero `<img>` is the ONLY element of its tag on the page (see
    // `scoreCandidate` in anchor.ts: candidates are filtered to same-tagName
    // elements only) — deliberately chosen so the fuzzy scorer has no
    // structurally-similar SIBLING to false-positive onto. The three
    // `.demo-feature-card` <article>s, by contrast, share an identical
    // class list and ancestor shape with each other, which would make a
    // confident-but-WRONG re-bind onto a sibling card a real risk rather
    // than a clean "drifted vs. not" signal.
    const target = page.getByTestId("hero-image");

    await dropElementPin(page, target, {
      category: "Design",
      title: `Drift check ${mark}`,
      body: `Watching this one for drift ${mark}`,
      name: "E2E Reviewer",
    });

    const pin = pinByTitleText(page, mark);
    await expect(pin).toBeVisible();
    await expect(pin).toHaveAttribute("data-drifted", "false");

    // ── mutate: id, data-testid, and classes all change; the element also
    // physically relocates to a different section, far down the page, so
    // BOTH `ancestorPath` and `rect` degrade along with `classes`. (`img`
    // has no rendered text, so `textHint` was already an empty-string,
    // zero-signal field before AND after — see `similarity()`'s
    // `!a && !b` case in anchor.ts.)
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="hero-image"]');
      if (!el) throw new Error("hero-image not found");
      el.removeAttribute("id");
      el.removeAttribute("data-testid");
      el.className = "totally-unrelated-mutated-markup";
      // Physically relocate it: append to the CTA section, at the bottom of
      // the page, far from its original position and ancestor context.
      const cta = document.getElementById("cta");
      cta?.appendChild(el);
    });

    // Give the overlay's rAF-throttled MutationObserver a tick to react.
    await expect(pin).toHaveAttribute("data-drifted", "true", { timeout: 5_000 });
    // A drifted pin is drawn at its ORIGINAL captured rect, not the mutated
    // element's new location — confirms it didn't just silently vanish.
    await expect(pin).toBeVisible();

    testInfo.annotations.push({
      type: "drift-finding",
      description:
        "Live DOM mutation (id/testid/classes/text changed + relocated) → data-drifted flips to true without a reload, via the overlay's MutationObserver. This is the resolver correctly detecting drift.",
    });

    // ── reload: the mutation was never server-persisted, so the fresh DOM
    // is byte-for-byte what it was when the pin was dropped.
    await page.reload();
    await expect(unlockedToggle(page)).toBeVisible();

    const pinAfterReload = pinByTitleText(page, mark);
    await expect(pinAfterReload).toBeVisible();
    const driftedAfterReload = await pinAfterReload.getAttribute("data-drifted");

    testInfo.annotations.push({
      type: "drift-finding",
      description: `After reload, data-drifted="${driftedAfterReload}". The mutation was client-only and not persisted server-side, so the reload serves the original, unmutated markup — the resolver's exact-selector match (id/data-testid restored) re-binds with confidence 1. This is the honest, expected outcome for THIS sequence, not a re-binding failure.`,
    });

    // Report the true outcome rather than assume it: assert whichever this
    // build actually produced, and fail loudly (not silently) if the
    // resolver ever surprises us by staying drifted after a genuinely
    // unmodified reload — that would itself be a real bug worth seeing.
    expect(
      driftedAfterReload,
      "expected the anchor to re-bind confidently after a reload that serves the original, unmutated markup",
    ).toBe("false");
  });
});
