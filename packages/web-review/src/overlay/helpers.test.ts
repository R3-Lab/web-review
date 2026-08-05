/**
 * `./helpers.ts` unit tests (vitest + jsdom) — `anchorPlacement` and the
 * persisted visibility switches.
 *
 * The three states `anchorPlacement` classifies are what the overlay is
 * allowed to SAY about a pin (see `./helpers.ts`'s `AnchorPlacement`), so the
 * boundaries between them are behaviour, not an implementation detail: a
 * resolve that bound nothing must never come back as "drifted", because the
 * pin, the highlight and the panel all read their copy off this one function.
 *
 * `CONFIDENCE_THRESHOLD` is imported rather than hard-coded so a future
 * change to the resolver's cut-off moves these cases with it instead of
 * silently invalidating them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { CONFIDENCE_THRESHOLD, resolveAnchor } from "../anchor";
import type { Anchor, ResolveResult } from "../core/types";
import {
  anchorPlacement,
  readShowHighlights,
  readShowPins,
  showHighlightsStorageKey,
  showPinsStorageKey,
  writeShowHighlights,
  writeShowPins,
} from "./helpers";

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/** A stand-in for a live element + its measured box. */
function boundEl(): { el: Element; rect: DOMRect } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return { el, rect: new DOMRect(12, 34, 100, 40) };
}

describe("anchorPlacement", () => {
  it("is anchored at exactly the confidence threshold, and carries the live rect", () => {
    const { el, rect } = boundEl();
    const placement = anchorPlacement({ el, rect, confidence: CONFIDENCE_THRESHOLD });

    expect(placement.state).toBe("anchored");
    // The rect rides on the variant so call sites never re-check `resolved`.
    if (placement.state !== "anchored") throw new Error("expected an anchored placement");
    expect(placement.rect).toBe(rect);
  });

  it("is anchored for a confident resolve", () => {
    const { el, rect } = boundEl();
    expect(anchorPlacement({ el, rect, confidence: 1 }).state).toBe("anchored");
  });

  it("is drifted when a candidate was found but scored below the threshold", () => {
    const { el, rect } = boundEl();
    const placement = anchorPlacement({
      el,
      rect,
      confidence: CONFIDENCE_THRESHOLD - 0.01,
    });

    expect(placement.state).toBe("drifted");
  });

  it("is unplaceable when the resolver bound nothing at all", () => {
    // Exactly what `resolveAnchor` returns when no candidate scored above
    // zero: a result object, but with neither an element nor a rect.
    const nothing: ResolveResult = { confidence: 0 };
    expect(anchorPlacement(nothing).state).toBe("unplaceable");
  });

  it("is unplaceable when there is no resolution for this thread yet", () => {
    expect(anchorPlacement(undefined).state).toBe("unplaceable");
  });

  it("degrades a confident-but-unmeasurable resolve to drifted, not anchored", () => {
    // The resolver sets `el` and `rect` together, so this pair should never
    // occur — but the type permits it, and with no rect there is nothing to
    // draw against. It matched something, so it is not "not found" either.
    const { el } = boundEl();
    expect(anchorPlacement({ el, confidence: 1 }).state).toBe("drifted");
  });
});

/**
 * The cases above hand `anchorPlacement` a `ResolveResult` built by hand,
 * which proves the classifier but not that the resolver ever produces the
 * inputs it classifies. These two run the REAL `resolveAnchor` against a real
 * (jsdom) document, so the drift path is not left resting on a fixture — or,
 * at the e2e level, on `examples/next-demo/e2e/drift.spec.ts` alone.
 *
 * jsdom has no layout, so every `getBoundingClientRect` is zeros and the
 * scorer's `rect` term (weight 0.15) contributes nothing. The drift case
 * below therefore earns its score almost entirely from `textHint` overlap
 * (weight 0.4), which is exactly the signal a real content edit degrades.
 */
describe("anchorPlacement over a real resolveAnchor", () => {
  /** An anchor captured on a `<p>` that has since been edited and re-classed. */
  function editedParagraphAnchor(overrides: Partial<Anchor> = {}): Anchor {
    return {
      // The id it was captured under is gone, so the exact-selector match
      // fails and the fuzzy scorer takes over — the real drift entry point.
      selector: "#old-id",
      textHint: "Pricing now starts at ten dollars a month",
      tagName: "p",
      classes: ["lede"],
      ancestorPath: [
        { tag: "div", idxOfType: 1 },
        { tag: "body", idxOfType: 1 },
      ],
      rect: { x: 200, y: 300, w: 100, h: 40 },
      offsetPct: { x: 0.5, y: 0.5 },
      viewport: { w: 1024, h: 768, dpr: 1, scrollW: 1024, scrollH: 2000 },
      urlKey: "/",
      href: "https://example.test/",
      kind: "element",
      ...overrides,
    };
  }

  it("calls a genuine low-confidence resolve drifted, not unplaceable", () => {
    // Same paragraph, rewritten copy and a different class/id/nesting: the
    // scorer still recognises it through the surviving words, but not well
    // enough to trust the live rect.
    document.body.innerHTML =
      '<main><section><p id="new-id" class="intro">' +
      "Pricing now starts at twenty dollars a month" +
      "</p></section></main>";

    const resolved = resolveAnchor(editedParagraphAnchor());

    // Asserted as a band, not a magic number: if a weight change ever moves
    // this scenario out of the drifted range, that shows up here as a failed
    // premise rather than as a test that quietly proves nothing.
    expect(resolved.el).toBeDefined();
    expect(resolved.confidence).toBeGreaterThan(0);
    expect(resolved.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(anchorPlacement(resolved).state).toBe("drifted");
  });

  it("calls a resolve with no candidate at all unplaceable, not drifted", () => {
    // Nothing of that tag on the page, so there is not even a bad match to
    // score — `resolveAnchor` returns no `el` and no `rect`.
    document.body.innerHTML = "<main><h1>An unrelated page</h1></main>";

    const resolved = resolveAnchor(editedParagraphAnchor());

    expect(resolved.el).toBeUndefined();
    expect(resolved.rect).toBeUndefined();
    expect(anchorPlacement(resolved).state).toBe("unplaceable");
  });
});

/**
 * The two persisted visibility switches.
 *
 * They are tested as a PAIR rather than one after the other because the thing
 * most worth protecting is that they are independent: two keys, two answers,
 * and no way for one to move the other. The pins switch exists precisely
 * because hiding highlights was never an acceptable price for getting a click
 * through to the page, and a shared key would quietly reintroduce that price.
 */
describe("the persisted visibility switches", () => {
  const PREFIX = "acme.review";

  it("keys each switch separately under the configured prefix", () => {
    expect(showPinsStorageKey(PREFIX)).toBe("acme.review.showPins");
    expect(showHighlightsStorageKey(PREFIX)).toBe("acme.review.showHighlights");
    expect(showPinsStorageKey(PREFIX)).not.toBe(showHighlightsStorageKey(PREFIX));
  });

  it("defaults both to on when nothing has ever been stored", () => {
    expect(readShowPins(PREFIX)).toBe(true);
    expect(readShowHighlights(PREFIX)).toBe(true);
  });

  it("round-trips each choice", () => {
    writeShowPins(PREFIX, false);
    expect(readShowPins(PREFIX)).toBe(false);
    writeShowPins(PREFIX, true);
    expect(readShowPins(PREFIX)).toBe(true);
  });

  it("scopes the choice to its prefix, so two overlays on one origin never share one", () => {
    writeShowPins(PREFIX, false);
    expect(readShowPins("other.review")).toBe(true);
  });

  it("leaves the other switch alone in both directions", () => {
    writeShowPins(PREFIX, false);
    expect(readShowHighlights(PREFIX)).toBe(true);

    writeShowPins(PREFIX, true);
    writeShowHighlights(PREFIX, false);
    expect(readShowPins(PREFIX)).toBe(true);
  });

  it('treats only "0" as off, so an unrecognised value reads as on', () => {
    // A value from an older build, another tool sharing the prefix, or a
    // reviewer poking at devtools. None of those is a reason to hide the
    // feedback someone came here to read.
    window.localStorage.setItem(showPinsStorageKey(PREFIX), "no");
    expect(readShowPins(PREFIX)).toBe(true);
  });

  it("reads as on when storage throws, and swallows a write that throws", () => {
    // Safari's private mode, a blocked third-party context, a full quota.
    // The overlay has to keep working, and it has to keep SHOWING things —
    // a storage error must never be the reason a pin is invisible.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    expect(readShowPins(PREFIX)).toBe(true);
    expect(readShowHighlights(PREFIX)).toBe(true);
    expect(() => writeShowPins(PREFIX, false)).not.toThrow();
    expect(() => writeShowHighlights(PREFIX, false)).not.toThrow();
  });
});
