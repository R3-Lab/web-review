/**
 * `ThreadHighlight` rendering tests (vitest + jsdom + React Testing Library).
 *
 * The highlight has no copy of its own — it is pure geometry plus the two
 * anchor-state flags — so what matters here is that it agrees with `./pin`
 * on both: the same resolve must never produce a drifted pin and a
 * not-found highlight, and neither state may stop the boxes from being
 * drawn. The flags are also the hook `overlay.css` keys its greyscale-safe
 * forms off (dashed vs dotted), which is why they are asserted as attributes
 * rather than inferred from a class name.
 *
 * The highlight boxes are not in the accessibility tree (they are decorative
 * and `pointer-events: none`), so these query the container directly.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DEFAULT_CATEGORIES } from "../core/types";
import type { Anchor, ResolveResult, ReviewThreadView } from "../core/types";
import { ThreadHighlight } from "./thread-highlight";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function makeThread(): ReviewThreadView {
  const anchor: Anchor = {
    selector: "#target",
    textHint: "Target",
    tagName: "div",
    classes: [],
    ancestorPath: [],
    // Captured at (200, 300), 100×40. The single highlight rect covers the
    // left half of it ⇒ a box at (200, 300), 50×40 when drawn historically.
    rect: { x: 200, y: 300, w: 100, h: 40 },
    offsetPct: { x: 0.5, y: 0.5 },
    highlightRectsPct: [{ x: 0, y: 0, w: 0.5, h: 1 }],
    viewport: { w: 1024, h: 768, dpr: 1, scrollW: 1024, scrollH: 2000 },
    urlKey: "/",
    href: "https://example.test/",
    kind: "element",
  };
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
  };
}

function renderHighlight(resolved: ResolveResult | undefined): HTMLElement {
  const { container } = render(
    <ThreadHighlight
      thread={makeThread()}
      selected={false}
      resolved={resolved}
      categories={DEFAULT_CATEGORIES}
    />,
  );
  const box = container.querySelector<HTMLElement>(".r3wr-highlight");
  if (!box) throw new Error("expected a highlight box to be rendered");
  return box;
}

/** The live box a confident resolve lands on ⇒ a half-width box at (500, 200). */
const LIVE = new DOMRect(500, 200, 100, 40);

function boundTo(rect: DOMRect, confidence: number): ResolveResult {
  return { el: document.createElement("div"), rect, confidence };
}

describe("ThreadHighlight", () => {
  it("draws over the live rect, unflagged, when the anchor resolves confidently", () => {
    const box = renderHighlight(boundTo(LIVE, 0.9));

    expect(box).toHaveAttribute("data-drifted", "false");
    expect(box).toHaveAttribute("data-unplaceable", "false");
    expect(box.style.left).toBe("500px");
    expect(box.style.top).toBe("200px");
  });

  it("flags a weak match as drifted only, and falls back to the captured rect", () => {
    const box = renderHighlight(boundTo(LIVE, 0.2));

    expect(box).toHaveAttribute("data-drifted", "true");
    expect(box).toHaveAttribute("data-unplaceable", "false");
    expect(box.style.left).toBe("200px");
    expect(box.style.top).toBe("300px");
    expect(box.style.width).toBe("50px");
  });

  it("flags a resolve that matched nothing as unplaceable only, and still draws it", () => {
    const box = renderHighlight({ confidence: 0 });

    expect(box).toHaveAttribute("data-unplaceable", "true");
    expect(box).toHaveAttribute("data-drifted", "false");
    expect(box.style.left).toBe("200px");
    expect(box.style.top).toBe("300px");
    expect(box.style.width).toBe("50px");
  });

  it("treats a thread with no resolution yet as unplaceable, never as drifted", () => {
    const box = renderHighlight(undefined);

    expect(box).toHaveAttribute("data-unplaceable", "true");
    expect(box).toHaveAttribute("data-drifted", "false");
  });
});
