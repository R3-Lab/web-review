/**
 * `OverlayRoot` interaction tests (vitest + jsdom + React Testing Library).
 *
 * The reference this package generalizes from (`feedback-overlay-inner.tsx`)
 * has NO tests at all — it was hand-verified in a browser. This is new work,
 * so the bar is real interactions (keyboard, click, selection), not render
 * smoke tests. A fake in-memory `ReviewAdapter` stands in for a consumer's
 * storage; WP4b's Composer/Panel/UnlockDialog don't exist yet, so wherever a
 * test needs to exercise a render-prop seam it supplies a minimal stub
 * component inline — that stub IS the contract WP4b's real components will
 * satisfy.
 *
 * jsdom has no layout engine (`getBoundingClientRect` returns zeros) and no
 * `elementFromPoint` at all — the geometry stubbing below is copied from the
 * established pattern in `../anchor.test.ts`; read that file first if this
 * setup looks unfamiliar.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { OVERLAY_ATTR } from "../anchor";
import { ReviewApiError } from "../core/adapter";
import type { ListThreadsParams } from "../core/adapter";
import { resolveConfig } from "../core/config";
import type { ReviewConfig } from "../core/config";
import type {
  Anchor,
  NewCommentInput,
  NewThreadInput,
  ReviewCommentView,
  ReviewStatus,
  ReviewThreadView,
} from "../core/types";
import { OverlayRoot } from "./overlay-root";
import type { OverlayRootProps, PanelRenderProps } from "./overlay-root";

// ─────────────────────────────── DOM stubbing ────────────────────────────────
// jsdom has no layout: getBoundingClientRect returns zeros unless stubbed.

function stubRect(el: Element, rect: { x: number; y: number; w: number; h: number }) {
  el.setAttribute("data-rect", JSON.stringify(rect));
}

beforeEach(() => {
  if (typeof document.elementFromPoint !== "function") {
    Object.defineProperty(Document.prototype, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: () => null,
    });
  }
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
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
  });
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? "";
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  window.localStorage.clear();
  delete (HTMLElement.prototype as unknown as { innerText?: unknown }).innerText;
  delete (Document.prototype as unknown as { elementFromPoint?: unknown }).elementFromPoint;
});

// ────────────────────────────── fake ReviewAdapter ───────────────────────────

function makeAdapter(initial: ReviewThreadView[] = []) {
  const store = [...initial];
  let seq = store.length;

  const listThreads = vi.fn(
    (params: ListThreadsParams): Promise<ReviewThreadView[]> =>
      Promise.resolve(
        store.filter(
          (t) =>
            (!params.urlKey || t.urlKey === params.urlKey) &&
            (!params.status || params.status === "all" || t.status === params.status),
        ),
      ),
  );

  const getThread = vi.fn((id: string): Promise<ReviewThreadView> => {
    const t = store.find((row) => row.id === id);
    if (!t) return Promise.reject(new ReviewApiError(404, "not found"));
    return Promise.resolve(t);
  });

  const createThread = vi.fn(async (input: NewThreadInput): Promise<ReviewThreadView> => {
    await Promise.resolve();
    seq += 1;
    const now = new Date().toISOString();
    const comment: ReviewCommentView = {
      id: `c${seq}`,
      threadId: `t${seq}`,
      body: input.firstComment,
      authorId: input.authorId,
      authorName: input.authorName,
      createdAt: now,
    };
    const thread: ReviewThreadView = {
      id: `t${seq}`,
      project: input.project ?? "web",
      url: input.url,
      urlKey: input.urlKey,
      locale: input.locale,
      route: input.route ?? null,
      title: input.title ?? null,
      category: input.category,
      anchor: input.anchor,
      viewport: input.viewport ?? null,
      status: "open",
      authorId: input.authorId,
      authorName: input.authorName,
      screenshotUrl: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolvedBy: null,
      comments: [comment],
      commentCount: 1,
    };
    store.push(thread);
    return thread;
  });

  const addComment = vi.fn(
    async (threadId: string, input: NewCommentInput): Promise<ReviewCommentView> => {
      await Promise.resolve();
      const t = store.find((row) => row.id === threadId);
      if (!t) throw new ReviewApiError(404, "not found");
      seq += 1;
      const comment: ReviewCommentView = {
        id: `c${seq}`,
        threadId,
        body: input.body,
        authorId: input.authorId,
        authorName: input.authorName,
        createdAt: new Date().toISOString(),
      };
      t.comments.push(comment);
      t.commentCount += 1;
      return comment;
    },
  );

  const setStatus = vi.fn(
    async (
      threadId: string,
      status: ReviewStatus,
      resolvedBy?: string | null,
    ): Promise<ReviewThreadView> => {
      await Promise.resolve();
      const t = store.find((row) => row.id === threadId);
      if (!t) throw new ReviewApiError(404, "not found");
      t.status = status;
      t.resolvedAt = status === "resolved" ? new Date().toISOString() : null;
      t.resolvedBy = status === "resolved" ? (resolvedBy ?? null) : null;
      return t;
    },
  );

  return { listThreads, getThread, createThread, addComment, setStatus };
}

// ──────────────────────────────── fixtures ───────────────────────────────────

function makeAnchor(overrides: Partial<Anchor> = {}): Anchor {
  return {
    selector: "#target",
    textHint: "Target",
    tagName: "div",
    classes: [],
    ancestorPath: [],
    rect: { x: 10, y: 10, w: 100, h: 40 },
    offsetPct: { x: 0.5, y: 0.5 },
    viewport: { w: 1024, h: 768, dpr: 1, scrollW: 1024, scrollH: 2000 },
    urlKey: "/",
    href: "https://example.test/",
    kind: "element",
    highlightRectsPct: [{ x: 0, y: 0, w: 1, h: 1 }],
    ...overrides,
  };
}

let threadSeq = 0;
function makeThread(
  overrides: Omit<Partial<ReviewThreadView>, "anchor"> & { anchor?: Partial<Anchor> } = {},
): ReviewThreadView {
  threadSeq += 1;
  const anchor = makeAnchor(overrides.anchor);
  const now = new Date().toISOString();
  return {
    id: `t${threadSeq}`,
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
    ...overrides,
    anchor,
  };
}

function renderOverlay(config: ReviewConfig, extraProps: Partial<Omit<OverlayRootProps, "config">> = {}) {
  return render(<OverlayRoot config={resolveConfig(config)} {...extraProps} />);
}

// ────────────────────────────────── tests ────────────────────────────────────

describe("thread loading + pin rendering", () => {
  it("fetches threads for the current urlKey and renders a pin per thread", async () => {
    const thread = makeThread({ urlKey: "/" });
    const adapter = makeAdapter([thread]);
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /review pin 1/i });
    expect(adapter.listThreads).toHaveBeenCalledWith(
      expect.objectContaining({ urlKey: "/", status: "all" }),
    );
  });

  it("renders a drifted pin when the anchor resolves below the confidence threshold", async () => {
    const thread = makeThread({
      anchor: {
        selector: "#does-not-exist-anywhere",
        textHint: "Nothing on this page resembles this text at all",
        tagName: "div",
      },
    });
    const adapter = makeAdapter([thread]);
    renderOverlay({ adapter });

    const pin = await screen.findByRole("button", { name: /review pin 1/i });
    expect(pin).toHaveAttribute("data-drifted", "true");
  });
});

describe("pin-drop mode", () => {
  it("enters pin-drop mode on 'c' and captures an element anchor with a plausible selector", async () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "widget");
    target.textContent = "A page element";
    document.body.appendChild(target);
    stubRect(target, { x: 0, y: 0, w: 200, h: 60 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    let captured: Anchor | undefined;

    renderOverlay(
      { adapter },
      {
        renderComposer: (props) => {
          captured = props.anchor;
          return null;
        },
      },
    );

    await screen.findByRole("button", { name: /drop a review pin/i });
    await user.keyboard("c");
    await screen.findByText(/select words to pin the copy/i);

    await user.click(target);

    await waitFor(() => expect(captured).toBeDefined());
    expect(captured?.kind).toBe("element");
    expect(captured?.selector).toContain('data-testid="widget"');
  });

  it("captures a text-kind anchor carrying the selected words", async () => {
    const para = document.createElement("p");
    para.id = "para";
    para.textContent = "Highlight this sentence please";
    document.body.appendChild(para);
    stubRect(para, { x: 0, y: 0, w: 400, h: 40 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(para);

    // A live, non-collapsed selection whose common ancestor is `para` — see
    // `../anchor.test.ts` for why a fake Selection is used rather than a
    // real jsdom Range (jsdom's Range/Selection geometry support is limited).
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

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    let captured: Anchor | undefined;

    renderOverlay(
      { adapter },
      {
        renderComposer: (props) => {
          captured = props.anchor;
          return null;
        },
      },
    );

    await screen.findByRole("button", { name: /drop a review pin/i });
    await user.keyboard("c");
    await user.click(para);

    await waitFor(() => expect(captured).toBeDefined());
    expect(captured?.kind).toBe("text");
    expect(captured?.selectedText).toBe("Highlight this sentence");
  });

  it("does not drop a pin when clicking the overlay's own chrome", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    let captured: Anchor | undefined;

    renderOverlay(
      { adapter },
      {
        renderComposer: (props) => {
          captured = props.anchor;
          return null;
        },
      },
    );

    await screen.findByRole("button", { name: /drop a review pin/i });
    await user.keyboard("c");
    const cancelToggle = await screen.findByRole("button", { name: /cancel pin-drop mode/i });

    await user.click(cancelToggle);

    expect(captured).toBeUndefined();
    // The toggle's own click handler still ran (pin-drop mode exited) —
    // proof the click reached the button rather than being silently eaten.
    expect(await screen.findByRole("button", { name: /drop a review pin/i })).toBeInTheDocument();
  });

  it("does not drop a pin when clicking an editable target", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    stubRect(input, { x: 0, y: 0, w: 100, h: 30 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(input);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    let captured: Anchor | undefined;

    renderOverlay(
      { adapter },
      {
        renderComposer: (props) => {
          captured = props.anchor;
          return null;
        },
      },
    );

    await screen.findByRole("button", { name: /drop a review pin/i });
    await user.keyboard("c");
    await user.click(input);

    expect(captured).toBeUndefined();
  });

  it("creates a thread via the composer seam, merges it into state, and selects it", async () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "widget");
    target.textContent = "A page element";
    document.body.appendChild(target);
    stubRect(target, { x: 0, y: 0, w: 200, h: 60 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();

    renderOverlay(
      { adapter },
      {
        renderComposer: (props) => (
          <button
            type="button"
            onClick={() =>
              void props.onSubmit({
                category: "bug",
                title: "A bug",
                body: "It broke",
                name: "Ada",
              })
            }
          >
            submit draft
          </button>
        ),
      },
    );

    await screen.findByRole("button", { name: /drop a review pin/i });
    await user.keyboard("c");
    await user.click(target);
    const submit = await screen.findByRole("button", { name: /submit draft/i });
    await user.click(submit);

    await screen.findByRole("button", { name: /review pin 1/i });
    expect(adapter.createThread).toHaveBeenCalledTimes(1);
    expect(adapter.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "bug",
        title: "A bug",
        firstComment: "It broke",
        authorName: "Ada",
      }),
    );
  });
});

describe("highlight visibility", () => {
  it("persists the toggle to localStorage under the configured prefix and honours it on remount", async () => {
    const adapter = makeAdapter([]);
    const renderPanel = (props: PanelRenderProps) => (
      <button type="button" onClick={props.onToggleHighlights}>
        highlights: {props.showHighlights ? "on" : "off"}
      </button>
    );

    const firstUser = userEvent.setup();
    renderOverlay({ adapter, storagePrefix: "acme" }, { renderPanel });
    // Wait for the gate to reach "unlocked" — the keydown listener isn't
    // attached until then, so pressing "c" any earlier would be a no-op.
    await screen.findByRole("button", { name: /drop a review pin/i });
    await firstUser.keyboard("c"); // enterPinDropMode also opens the panel
    const toggle = await screen.findByRole("button", { name: /highlights: on/i });
    await firstUser.click(toggle);
    await screen.findByRole("button", { name: /highlights: off/i });
    expect(window.localStorage.getItem("acme.showHighlights")).toBe("0");
    cleanup();

    const secondUser = userEvent.setup();
    renderOverlay({ adapter, storagePrefix: "acme" }, { renderPanel });
    await screen.findByRole("button", { name: /drop a review pin/i });
    await secondUser.keyboard("c");
    expect(await screen.findByRole("button", { name: /highlights: off/i })).toBeInTheDocument();
  });
});

describe("gate", () => {
  it("unmounts entirely when the adapter reports the feature disabled (404 feature_disabled)", async () => {
    const adapter = makeAdapter([]);
    adapter.listThreads = vi.fn(() => {
      throw new ReviewApiError(404, "disabled", "feature_disabled");
    });

    const { container } = renderOverlay({ adapter });

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(document.body.querySelector(`[${OVERLAY_ATTR}]`)).toBeNull();
  });

  // WP19 regression: a 404 for an unrelated reason (e.g. an unknown thread
  // id, coded `not_found`) must NOT be mistaken for the feature being
  // switched off — `isFeatureDisabled` only recognizes `feature_disabled`.
  // The probe fails soft here (see `OverlayRoot`'s `probe` callback), so the
  // overlay stays mounted rather than tearing itself down over an
  // unrelated, likely transient, 404.
  it("does NOT unmount for a 404 carrying an unrelated code (e.g. not_found)", async () => {
    const adapter = makeAdapter([]);
    adapter.listThreads = vi.fn(() => {
      throw new ReviewApiError(404, "missing", "not_found");
    });

    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /drop a review pin/i });
    expect(document.body.querySelector(`[${OVERLAY_ATTR}]`)).not.toBeNull();
  });
});

describe("polling", () => {
  it("refetches the thread list on the poll interval", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const adapter = makeAdapter([]);
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /drop a review pin/i });
    expect(adapter.listThreads).toHaveBeenCalledTimes(1);

    const call = setIntervalSpy.mock.calls.find(([, delay]) => delay === 60_000);
    expect(call).toBeDefined();
    const callback = call?.[0] as (() => void) | undefined;
    if (!callback) throw new Error("expected a 60s setInterval registration");

    await act(async () => {
      callback();
      await Promise.resolve();
    });

    await waitFor(() => expect(adapter.listThreads).toHaveBeenCalledTimes(2));
  });
});

describe("accessibility", () => {
  it("announces via the live region and tags every owned node with OVERLAY_ATTR", async () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "thing");
    target.textContent = "Thing";
    document.body.appendChild(target);
    stubRect(target, { x: 0, y: 0, w: 100, h: 40 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /drop a review pin/i });
    const liveRegion = document.querySelector('[role="status"]');
    expect(liveRegion).toBeTruthy();

    await user.keyboard("c");
    await waitFor(() => expect(liveRegion?.textContent).toMatch(/pin-drop mode on/i));

    await user.click(target);
    await waitFor(() => expect(liveRegion?.textContent).toMatch(/pin dropped/i));

    const owned = document.body.querySelectorAll(`[${OVERLAY_ATTR}]`);
    expect(owned.length).toBeGreaterThan(0);
    owned.forEach((el) => expect(el.getAttribute(OVERLAY_ATTR)).toBe(""));
  });
});
