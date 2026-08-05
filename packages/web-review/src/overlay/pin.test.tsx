/**
 * `Pin` rendering tests (vitest + jsdom + React Testing Library).
 *
 * These are copy tests as much as render tests. A pin's `aria-label` and
 * `title` are the only place a reviewer is told why a marker isn't sitting
 * on its element, so the wording is the behaviour: "drifted" claims the page
 * changed, and that claim is only ours to make when the resolver actually
 * matched something. The `does not claim…` assertions below are deliberately
 * phrased as "no mention of drift/change anywhere in the copy" rather than
 * "the copy equals X", so re-introducing the old shared wording fails them
 * even if it is reworded on the way in.
 *
 * jsdom has no layout: `document.documentElement.scrollWidth/Height` are 0,
 * which would make `clampToDocument` (see `./helpers`) pull every pin to the
 * 16px corner and flatten the position assertions. They are stubbed to a
 * plausible page size below so "drawn at the live rect" and "drawn at the
 * captured rect" are actually distinguishable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { OVERLAY_ATTR } from "../anchor";
import { DEFAULT_CATEGORIES } from "../core/types";
import type { Anchor, ResolveResult, ReviewThreadView } from "../core/types";
import { Pin } from "./pin";
import type { PinProps } from "./pin";

beforeEach(() => {
  for (const prop of ["scrollWidth", "scrollHeight"] as const) {
    Object.defineProperty(document.documentElement, prop, {
      configurable: true,
      value: 4000,
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function makeAnchor(overrides: Partial<Anchor> = {}): Anchor {
  return {
    selector: "#target",
    textHint: "Target",
    tagName: "div",
    classes: [],
    ancestorPath: [],
    // Captured at (200, 300), 100×40, pinned dead centre ⇒ (250, 320).
    rect: { x: 200, y: 300, w: 100, h: 40 },
    offsetPct: { x: 0.5, y: 0.5 },
    viewport: { w: 1024, h: 768, dpr: 1, scrollW: 1024, scrollH: 2000 },
    urlKey: "/",
    href: "https://example.test/",
    kind: "element",
    ...overrides,
  };
}

function makeThread(overrides: Partial<ReviewThreadView> = {}): ReviewThreadView {
  const anchor = makeAnchor();
  const now = new Date().toISOString();
  return {
    id: "t1",
    project: "web",
    url: anchor.href,
    urlKey: anchor.urlKey,
    locale: null,
    route: "/",
    title: "Sample thread",
    category: "design",
    viewport: anchor.viewport,
    status: "open",
    authorId: "u1",
    authorName: "Reviewer",
    screenshotUrl: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolvedBy: null,
    comments: [],
    commentCount: 0,
    anchor,
    ...overrides,
  };
}

/**
 * A resolve that bound an element and measured it — what `resolveAnchor`
 * returns for both a confident match and a weak one; only `confidence`
 * separates the two. The element is never attached: `Pin` reads the rect,
 * and an attached node would only add cleanup no assertion depends on.
 */
function boundTo(rect: DOMRect, confidence: number): ResolveResult {
  return { el: document.createElement("div"), rect, confidence };
}

function renderPin(overrides: Partial<PinProps> = {}) {
  render(
    <Pin
      thread={makeThread()}
      index={1}
      selected={false}
      onSelect={() => {}}
      resolved={undefined}
      categories={DEFAULT_CATEGORIES}
      {...overrides}
    />,
  );
  return screen.getByRole("button", { name: /review pin 1/i });
}

/** The live box the "confident bind" cases below resolve onto: ⇒ (550, 220). */
const LIVE = new DOMRect(500, 200, 100, 40);

/**
 * The hit area. Its SHAPE lives in `overlay.css` (a clip path over the
 * teardrop) and jsdom has no layout to measure it with — that half is proved
 * in `examples/next-demo/e2e/pin-passthrough.spec.ts`, which clicks a point
 * inside the marker's box but outside its outline and asserts the page gets
 * the click. What is checkable here is that the marker carries the node the
 * stylesheet needs at all, and that adding it cost the button nothing: a
 * child inside a control is exactly the sort of thing that quietly ends up in
 * its accessible name.
 */
describe("Pin — the hit area", () => {
  function hitOf(pin: HTMLElement): HTMLElement {
    const hit = pin.querySelector<HTMLElement>(".r3wr-pin-hit");
    if (!hit) throw new Error("expected a .r3wr-pin-hit child inside the pin");
    return hit;
  }

  it("renders one, inside the button", () => {
    const pin = renderPin();
    expect(pin.querySelectorAll(".r3wr-pin-hit")).toHaveLength(1);
    expect(hitOf(pin).parentElement).toBe(pin);
  });

  it("is hidden from assistive tech and leaves the accessible name untouched", () => {
    const pin = renderPin({ resolved: boundTo(LIVE, 0.9) });
    expect(hitOf(pin)).toHaveAttribute("aria-hidden", "true");
    expect(pin).toHaveAccessibleName("Review pin 1, Design, open: Sample thread");
  });

  it("is tagged as the overlay's own, like every other node the overlay owns", () => {
    expect(hitOf(renderPin())).toHaveAttribute(OVERLAY_ATTR);
  });
});

describe("Pin — a confidently resolved anchor", () => {
  const resolved = boundTo(LIVE, 0.9);

  it("is neither drifted nor unplaceable", () => {
    const pin = renderPin({ resolved });
    expect(pin).toHaveAttribute("data-drifted", "false");
    expect(pin).toHaveAttribute("data-unplaceable", "false");
  });

  it("says nothing about the anchor at all", () => {
    const pin = renderPin({ resolved });
    expect(pin.getAttribute("aria-label")).toBe(
      "Review pin 1, Design, open: Sample thread",
    );
    expect(pin.getAttribute("title")).toBe("Design · open · Sample thread");
  });

  it("rides the live rect, not the captured one", () => {
    const pin = renderPin({ resolved });
    expect(pin.style.left).toBe("550px");
    expect(pin.style.top).toBe("220px");
  });
});

describe("Pin — an anchor that resolved below the confidence threshold", () => {
  const resolved = boundTo(LIVE, 0.2);

  it("is drifted, and not unplaceable", () => {
    const pin = renderPin({ resolved });
    expect(pin).toHaveAttribute("data-drifted", "true");
    expect(pin).toHaveAttribute("data-unplaceable", "false");
  });

  it("says the anchor drifted and that the page changed — the one state that earns that claim", () => {
    const pin = renderPin({ resolved });
    expect(pin.getAttribute("aria-label")).toBe(
      "Review pin 1, Design, open: Sample thread (anchor drifted — shown where it was originally dropped)",
    );
    expect(pin.getAttribute("title")).toBe(
      "Design · open · Sample thread\nAnchor drifted — the page changed, this is the original position",
    );
  });

  it("is drawn at the captured position, not the weak match's live rect", () => {
    const pin = renderPin({ resolved });
    expect(pin.style.left).toBe("250px");
    expect(pin.style.top).toBe("320px");
  });
});

// The two ways a pin ends up unplaceable: the resolver ran and bound
// nothing, or the caller has no resolution for this thread at all. Neither
// tells us anything about the page having changed, so both must produce
// identical copy.
const UNPLACEABLE: [string, ResolveResult | undefined][] = [
  ["the resolver matched nothing on this page", { confidence: 0 }],
  ["there is no resolution for this thread", undefined],
];

describe.each(UNPLACEABLE)("Pin — %s", (_label, resolved) => {
  it("is unplaceable, and not drifted", () => {
    const pin = renderPin({ resolved });
    expect(pin).toHaveAttribute("data-unplaceable", "true");
    expect(pin).toHaveAttribute("data-drifted", "false");
  });

  it("says only that the anchor was not found, and where the pin was dropped", () => {
    const pin = renderPin({ resolved });
    expect(pin.getAttribute("aria-label")).toBe(
      "Review pin 1, Design, open: Sample thread (anchor not found on this page — shown where it was dropped)",
    );
    expect(pin.getAttribute("title")).toBe(
      "Design · open · Sample thread\nAnchor not found on this page — this is where the pin was dropped",
    );
  });

  it("does not claim the anchor drifted or that the page changed", () => {
    const pin = renderPin({ resolved });
    for (const copy of [pin.getAttribute("aria-label"), pin.getAttribute("title")]) {
      expect(copy).not.toMatch(/drift/i);
      expect(copy).not.toMatch(/changed/i);
      expect(copy).not.toMatch(/original/i);
    }
  });

  it("still renders, at the position the pin was dropped at", () => {
    const pin = renderPin({ resolved });
    expect(pin).toBeVisible();
    expect(pin.style.left).toBe("250px");
    expect(pin.style.top).toBe("320px");
  });
});
