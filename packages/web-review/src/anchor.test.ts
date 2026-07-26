/**
 * Anchor engine unit tests (vitest + jsdom). Ported from the reference
 * single-app review tool's `feedback/anchor.test.ts` — this logic is subtle
 * and its regressions are invisible (a pin quietly lands on the wrong
 * paragraph), so the tests come with it. Covers:
 *  (a) captureAnchor builds a selector resolveAnchor binds to the SAME element;
 *  (b) when the captured selector no longer matches, the fuzzy scorer still
 *      binds the right element (above threshold);
 *  (c) when nothing matches above threshold, confidence is low (degrade path);
 *  (d) text-selection capture — the primary gesture for copy review;
 *  (e) normalizeUrl does NOT strip locale prefixes — ported verbatim from the
 *      reference, see the reasoning in anchor.ts;
 *  (f) localeFromPathPrefix — this package's general-purpose replacement for
 *      the reference's hard-coded `"en" | "tr"` `localeFromHref`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSelector,
  captureAnchor,
  CONFIDENCE_THRESHOLD,
  isStableClass,
  localeFromPathPrefix,
  normalizeUrl,
  pointInSelection,
  resolveAnchor,
  scoreCandidate,
} from "./anchor";
import type { Anchor } from "./core/types";

/**
 * jsdom has no layout engine, so getBoundingClientRect returns zeros. Stub a
 * deterministic rect per element keyed off a data attribute we set in the DOM,
 * so geometry-based scoring + capture have real numbers to work with.
 */
function stubRect(
  el: Element,
  rect: { x: number; y: number; w: number; h: number },
) {
  el.setAttribute("data-rect", JSON.stringify(rect));
}

beforeEach(() => {
  // elementFromPoint + getBoundingClientRect are not implemented in jsdom.
  // jsdom defines no `elementFromPoint`, so `vi.spyOn(document, 'elementFromPoint')`
  // has nothing to wrap and throws. Define a default stub here so each test can
  // spy on it and `mockReturnValue` the element under test.
  if (typeof document.elementFromPoint !== "function") {
    Object.defineProperty(Document.prototype, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: () => null,
    });
  }
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const raw = this.getAttribute("data-rect");
      const r = raw
        ? (JSON.parse(raw) as { x: number; y: number; w: number; h: number })
        : null;
      const x = r?.x ?? 0;
      const y = r?.y ?? 0;
      const w = r?.w ?? 0;
      const h = r?.h ?? 0;
      return {
        x,
        y,
        width: w,
        height: h,
        top: y,
        left: x,
        right: x + w,
        bottom: y + h,
        toJSON() {},
      };
    },
  );
  // innerText isn't populated by jsdom; fall back to textContent in the engine,
  // but define a getter so `'innerText' in el` is true and matches textContent.
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? "";
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  // Drop the innerText shim between tests.
  delete (HTMLElement.prototype as unknown as { innerText?: unknown }).innerText;
  // Drop the elementFromPoint stub between tests.
  delete (Document.prototype as unknown as { elementFromPoint?: unknown })
    .elementFromPoint;
});

describe("normalizeUrl", () => {
  it("strips origin and hash", () => {
    expect(normalizeUrl("https://x.com/departments#top")).toBe("/departments");
    expect(normalizeUrl("https://x.com/")).toBe("/");
    expect(normalizeUrl("https://x.com/flyer/")).toBe("/flyer");
  });

  // The behaviour that matters most here: /flyer and /tr/flyer are different
  // pages with independently-written copy, so a pin on the Turkish wording
  // must never surface on the English page.
  it("KEEPS a locale-shaped prefix (does not strip it)", () => {
    expect(normalizeUrl("https://x.com/tr/flyer")).toBe("/tr/flyer");
    expect(normalizeUrl("https://x.com/tr/hakkimizda")).toBe("/tr/hakkimizda");
    expect(normalizeUrl("https://x.com/tr")).toBe("/tr");
    expect(normalizeUrl("https://x.com/about")).toBe("/about");
  });

  it("does not confuse a /tr-prefixed word with a locale segment", () => {
    expect(normalizeUrl("https://x.com/traditional-baklava")).toBe(
      "/traditional-baklava",
    );
  });

  it("keeps significant query params (sorted) and drops tracking ones", () => {
    expect(normalizeUrl("https://x.com/p?utm_source=a&tab=2&page=1")).toBe(
      "/p?page=1&tab=2",
    );
    expect(normalizeUrl("https://x.com/p?fbclid=abc")).toBe("/p");
  });
});

describe("localeFromPathPrefix", () => {
  it("reads the locale from the path prefix when it matches the given list", () => {
    expect(localeFromPathPrefix("https://x.com/tr", ["en", "tr"])).toBe("tr");
    expect(
      localeFromPathPrefix("https://x.com/tr/hakkimizda", ["en", "tr"]),
    ).toBe("tr");
    expect(localeFromPathPrefix("https://x.com/", ["en", "tr"])).toBeNull();
    expect(localeFromPathPrefix("https://x.com/about", ["en", "tr"])).toBeNull();
  });

  it("does not match a word that merely starts with a locale code", () => {
    expect(
      localeFromPathPrefix("https://x.com/traditional-baklava", ["en", "tr"]),
    ).toBeNull();
  });

  it("is a general-purpose helper: any consumer-supplied locale list works", () => {
    expect(localeFromPathPrefix("https://x.com/fr/a-propos", ["fr", "de"])).toBe(
      "fr",
    );
    expect(localeFromPathPrefix("https://x.com/tr", ["fr", "de"])).toBeNull();
  });

  it("returns null with no locale list configured", () => {
    expect(localeFromPathPrefix("https://x.com/tr", [])).toBeNull();
  });
});

describe("isStableClass", () => {
  it("drops hashed / utility / variant classes", () => {
    expect(isStableClass("card")).toBe(true);
    expect(isStableClass("nav-item")).toBe(true);
    expect(isStableClass("Button_root__a1b2c")).toBe(false);
    expect(isStableClass("px-4")).toBe(false);
    expect(isStableClass("md:flex")).toBe(false);
    expect(isStableClass("hover:bg-red-500")).toBe(false);
  });
});

describe("buildSelector + resolveAnchor (identity)", () => {
  it("prefers a unique id", () => {
    document.body.innerHTML = `<div id="hero"><p class="lede">Hi</p></div>`;
    const p = document.querySelector(".lede")!;
    const sel = buildSelector(p);
    expect(sel).toBe("#hero > p:nth-of-type(1)");
    expect(document.querySelectorAll(sel)).toHaveLength(1);
  });

  it("prefers a data-testid", () => {
    document.body.innerHTML = `<section data-testid="checkout"><button>Pay</button></section>`;
    const btn = document.querySelector("button")!;
    const sel = buildSelector(btn);
    expect(sel).toBe('[data-testid="checkout"] > button:nth-of-type(1)');
  });

  it("captureAnchor → resolveAnchor binds to the SAME element", () => {
    document.body.innerHTML = `
      <main id="app">
        <article data-testid="card-1"><h2>Title A</h2><p>Body A</p></article>
        <article data-testid="card-2"><h2>Title B</h2><p>Body B</p></article>
      </main>`;
    const target = document.querySelector('[data-testid="card-2"] p')!;
    stubRect(target, { x: 100, y: 200, w: 300, h: 40 });

    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
    const anchor = captureAnchor(150, 210)!;
    expect(anchor).not.toBeNull();
    expect(anchor.tagName).toBe("p");
    expect(anchor.textHint).toBe("Body B");

    const resolved = resolveAnchor(anchor);
    expect(resolved.confidence).toBe(1);
    expect(resolved.el).toBe(target);
  });

  it("captures the in-element click offset as a fraction", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const el = document.querySelector("#b")!;
    stubRect(el, { x: 0, y: 0, w: 200, h: 100 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(el);
    const a = captureAnchor(50, 25)!;
    expect(a.offsetPct.x).toBeCloseTo(0.25, 5);
    expect(a.offsetPct.y).toBeCloseTo(0.25, 5);
  });

  // A naive `el.closest(':not([data-r3-review])')` skip would return the
  // overlay node itself (`closest` starts at the element, and it is the
  // ANCESTOR that carries the attribute), so it would never actually fire.
  // The engine looks through the hit-test stack instead; with no
  // `elementsFromPoint` (jsdom) it degrades to <body>.
  it("never anchors to the overlay's own DOM", () => {
    document.body.innerHTML = `
      <div id="page"><p>Real copy</p></div>
      <div data-r3-review=""><button id="pin">1</button></div>`;
    const ownPin = document.querySelector("#pin")!;
    vi.spyOn(document, "elementFromPoint").mockReturnValue(ownPin);
    const a = captureAnchor(5, 5)!;
    expect(a.selector).not.toContain("#pin");
    expect(a.tagName).toBe("body");
  });

  it("looks THROUGH overlay chrome to the page element beneath it", () => {
    document.body.innerHTML = `
      <div id="page"><p id="copy">Real copy</p></div>
      <div data-r3-review=""><button id="pin">1</button></div>`;
    const ownPin = document.querySelector("#pin")!;
    const beneath = document.querySelector("#copy")!;
    vi.spyOn(document, "elementFromPoint").mockReturnValue(ownPin);
    Object.defineProperty(Document.prototype, "elementsFromPoint", {
      configurable: true,
      writable: true,
      value: () => [ownPin, beneath, document.body],
    });

    const a = captureAnchor(5, 5)!;
    expect(a.selector).toBe("#copy");
    expect(a.textHint).toBe("Real copy");

    delete (Document.prototype as unknown as { elementsFromPoint?: unknown })
      .elementsFromPoint;
  });
});

describe("resolveAnchor fuzzy fallback (drift survives)", () => {
  it("binds the right element when the captured selector no longer matches", () => {
    // Capture against a testid-bearing element.
    document.body.innerHTML = `
      <ul id="list">
        <li data-testid="row-a" class="row"><span>Alpha item</span></li>
        <li data-testid="row-b" class="row"><span>Beta item</span></li>
      </ul>`;
    const target = document.querySelector('[data-testid="row-b"] span')!;
    stubRect(target, { x: 10, y: 300, w: 250, h: 30 });
    document.querySelectorAll("span").forEach((s, i) => {
      if (s !== target) stubRect(s, { x: 10, y: 100 + i * 5, w: 250, h: 30 });
    });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
    const anchor = captureAnchor(20, 310)!;

    // Now MUTATE the DOM so the captured selector breaks (testid removed +
    // re-rendered order) but the element's text/structure persist.
    document.body.innerHTML = `
      <ul id="list">
        <li class="row"><span>Alpha item</span></li>
        <li class="row"><span>Beta item</span></li>
      </ul>`;
    const moved = Array.from(document.querySelectorAll("span")).find(
      (s) => s.textContent === "Beta item",
    )!;
    stubRect(moved, { x: 10, y: 300, w: 250, h: 30 });

    const resolved = resolveAnchor(anchor);
    expect(resolved.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(resolved.el).toBe(moved);
    expect(resolved.el?.textContent).toBe("Beta item");
  });

  it("low confidence (degrade) when nothing matches above threshold", () => {
    document.body.innerHTML = `<div id="a"><p class="orig">Unique original copy here</p></div>`;
    const target = document.querySelector(".orig")!;
    stubRect(target, { x: 0, y: 500, w: 400, h: 20 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
    const anchor = captureAnchor(5, 505)!;

    // Replace with a completely different DOM: no <p>, no matching text.
    document.body.innerHTML = `<section><h1>Totally different heading</h1></section>`;

    const resolved = resolveAnchor(anchor);
    expect(resolved.confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    // The anchor is never dropped — the caller renders it at the captured rect,
    // badged "drifted", so the reviewer is never misled about what was pinned.
    expect(anchor.rect.y).toBe(500);
  });

  it("scoreCandidate rewards matching text + classes + path", () => {
    document.body.innerHTML = `
      <div class="card"><p class="lede">Hello world copy</p></div>`;
    const el = document.querySelector(".lede")!;
    stubRect(el, { x: 0, y: 0, w: 100, h: 20 });
    const anchor: Anchor = {
      selector: ".missing",
      textHint: "Hello world copy",
      tagName: "p",
      classes: ["lede"],
      ancestorPath: [{ tag: "div", idxOfType: 1 }],
      rect: { x: 0, y: 0, w: 100, h: 20 },
      offsetPct: { x: 0.5, y: 0.5 },
      viewport: { w: 1000, h: 800, dpr: 1, scrollW: 1000, scrollH: 800 },
      urlKey: "/",
      href: "https://x.com/",
    };
    expect(scoreCandidate(anchor, el)).toBeGreaterThanOrEqual(
      CONFIDENCE_THRESHOLD,
    );
  });
});

describe("captureAnchor selection capture (element + text)", () => {
  it("element kind (no selection): full-box highlightRectsPct, no selectedText", () => {
    document.body.innerHTML = `<div id="card"><p>Some copy</p></div>`;
    const el = document.querySelector("#card")!;
    stubRect(el, { x: 0, y: 0, w: 300, h: 120 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(el);

    const a = captureAnchor(10, 10)!;
    expect(a.kind).toBe("element");
    expect(a.highlightRectsPct).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
    expect(a.selectedText).toBeUndefined();
  });

  it("text kind (non-collapsed selection): highlightRectsPct + selectedText", () => {
    document.body.innerHTML = `<div id="wrap"><p id="para">Highlight this sentence please</p></div>`;
    const para = document.querySelector("#para")!;
    const anchorEl = document.querySelector("#wrap")!;
    stubRect(para, { x: 0, y: 0, w: 400, h: 40 });
    stubRect(anchorEl, { x: 0, y: 0, w: 400, h: 40 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(para);

    // Fake a live, non-collapsed selection whose common ancestor is #para and
    // whose client-rects are a single box inside the (stubbed) element rect.
    const range = {
      commonAncestorContainer: para,
      getClientRects: () =>
        [{ left: 0, top: 0, width: 200, height: 20 }] as unknown as DOMRectList,
    } as unknown as Range;
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "Highlight this sentence",
    } as unknown as Selection);

    const a = captureAnchor(20, 10)!;
    expect(a.kind).toBe("text");
    expect(a.selectedText).toBe("Highlight this sentence");
    // 200/400 = 0.5 wide, 20/40 = 0.5 tall, at the element origin.
    expect(a.highlightRectsPct).toEqual([{ x: 0, y: 0, w: 0.5, h: 0.5 }]);
  });

  // The overlay paints one box per entry here. `Range.getClientRects()` returns
  // one rect PER LINE BOX, so a sentence spanning three lines yields three
  // narrow strips — never one block covering the whole paragraph. (The overlay
  // downgrades the single-full-box case to an outline for exactly this reason.)
  it("a multi-line selection yields one NARROW box per line, not one big box", () => {
    document.body.innerHTML = `<div id="wrap"><p id="para">three lines of copy</p></div>`;
    const para = document.querySelector("#para")!;
    stubRect(para, { x: 0, y: 0, w: 400, h: 60 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(para);

    // What a browser reports for a selection running across three line boxes:
    // full width mid-lines, a short tail on the last.
    const range = {
      commonAncestorContainer: para,
      getClientRects: () =>
        [
          { left: 120, top: 0, width: 280, height: 20 },
          { left: 0, top: 20, width: 400, height: 20 },
          { left: 0, top: 40, width: 150, height: 20 },
        ] as unknown as DOMRectList,
    } as unknown as Range;
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "three lines of copy",
    } as unknown as Selection);

    const a = captureAnchor(10, 10)!;
    expect(a.kind).toBe("text");
    expect(a.highlightRectsPct).toHaveLength(3);
    // Every box is one line tall (20/60), so none of them washes the element.
    for (const r of a.highlightRectsPct!) {
      expect(r.h).toBeCloseTo(1 / 3, 5);
    }
    // And none is the degenerate full box the overlay draws as an outline.
    expect(a.highlightRectsPct!.some((r) => r.w >= 0.999 && r.h >= 0.999)).toBe(
      false,
    );
    expect(a.highlightRectsPct![0]).toEqual({ x: 0.3, y: 0, w: 0.7, h: 1 / 3 });
  });

  it("text selection with zero-size rects degrades to a full-element box", () => {
    // jsdom has no layout, so a real selection yields zero-size client-rects;
    // the engine must clamp to a single full box rather than divide by zero.
    document.body.innerHTML = `<p id="line">Zero layout text</p>`;
    const line = document.querySelector("#line")!;
    stubRect(line, { x: 0, y: 0, w: 0, h: 0 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(line);

    const range = {
      commonAncestorContainer: line,
      getClientRects: () => [] as unknown as DOMRectList,
    } as unknown as Range;
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "Zero layout text",
    } as unknown as Selection);

    const a = captureAnchor(0, 0)!;
    expect(a.kind).toBe("text");
    expect(a.highlightRectsPct).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
    expect(a.selectedText).toBe("Zero layout text");
  });

  it("collapsed selection is ignored (still element kind, no selectedText)", () => {
    document.body.innerHTML = `<div id="x"><span>hi</span></div>`;
    const el = document.querySelector("#x")!;
    stubRect(el, { x: 0, y: 0, w: 100, h: 50 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(el);
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: true,
      rangeCount: 1,
      getRangeAt: () => ({}) as Range,
      toString: () => "",
    } as unknown as Selection);

    const a = captureAnchor(5, 5)!;
    expect(a.kind).toBe("element");
    expect(a.highlightRectsPct).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
    expect(a.selectedText).toBeUndefined();
  });

  // Site-specific addition: the overlay snapshots the selection at MOUSEDOWN
  // (the browser collapses it before `click` fires), so captureAnchor takes an
  // explicit override. `null` must mean "no selection", not "read the live one".
  it("honours an explicit selection override taken at mousedown", () => {
    document.body.innerHTML = `<p id="line">Snapshotted copy here</p>`;
    const line = document.querySelector("#line")!;
    stubRect(line, { x: 0, y: 0, w: 400, h: 40 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(line);
    // The LIVE selection is already collapsed by the time click fires…
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: true,
      rangeCount: 0,
      getRangeAt: () => ({}) as Range,
      toString: () => "",
    } as unknown as Selection);

    const range = {
      commonAncestorContainer: line,
      getClientRects: () =>
        [{ left: 0, top: 0, width: 100, height: 20 }] as unknown as DOMRectList,
    } as unknown as Range;

    const a = captureAnchor(10, 10, { range, text: "Snapshotted copy" })!;
    expect(a.kind).toBe("text");
    expect(a.selectedText).toBe("Snapshotted copy");
    expect(a.highlightRectsPct).toEqual([{ x: 0, y: 0, w: 0.25, h: 0.5 }]);
  });

  it("an explicit null override suppresses the live selection", () => {
    document.body.innerHTML = `<p id="line">Some copy</p>`;
    const line = document.querySelector("#line")!;
    stubRect(line, { x: 0, y: 0, w: 400, h: 40 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(line);
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () =>
        ({
          commonAncestorContainer: line,
          getClientRects: () => [] as unknown as DOMRectList,
        }) as unknown as Range,
      toString: () => "Some copy",
    } as unknown as Selection);

    const a = captureAnchor(10, 10, null)!;
    expect(a.kind).toBe("element");
    expect(a.selectedText).toBeUndefined();
  });
});

describe("pointInSelection", () => {
  const selection = {
    text: "words",
    range: {
      getClientRects: () =>
        [
          { left: 100, top: 200, right: 300, bottom: 220 },
        ] as unknown as DOMRectList,
    } as unknown as Range,
  };

  it("accepts a click inside (or just outside) a selection rect", () => {
    expect(pointInSelection(selection, 150, 210)).toBe(true);
    expect(pointInSelection(selection, 100, 200)).toBe(true);
    expect(pointInSelection(selection, 303, 222)).toBe(true); // within the pad
  });

  it("rejects a click somewhere else entirely", () => {
    expect(pointInSelection(selection, 150, 600)).toBe(false);
    expect(pointInSelection(selection, 900, 210)).toBe(false);
  });
});
