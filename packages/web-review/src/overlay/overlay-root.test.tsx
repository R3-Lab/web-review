/**
 * `OverlayRoot` interaction tests (vitest + jsdom + React Testing Library).
 *
 * The reference this package generalizes from (`feedback-overlay-inner.tsx`)
 * has NO tests at all — it was hand-verified in a browser. This is new work,
 * so the bar is real interactions (keyboard, click, selection), not render
 * smoke tests. A fake in-memory `ReviewAdapter` stands in for a consumer's
 * storage; these tests exercise `OverlayRoot`'s render-prop seam in
 * isolation from the real `Composer`/`Panel`/`UnlockDialog`, so wherever a
 * test needs to exercise that seam it supplies a minimal stub component
 * inline — that stub IS the contract the real components satisfy (see
 * `./panels-integration.test.tsx` for the same round trip through the real
 * components instead of stubs).
 *
 * jsdom has no layout engine (`getBoundingClientRect` returns zeros) and no
 * `elementFromPoint` at all — the geometry stubbing below is copied from the
 * established pattern in `../anchor.test.ts`; read that file first if this
 * setup looks unfamiliar.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { captureScreenshot } from "../client/screenshot";
import { OverlayRoot } from "./overlay-root";
import type { ComposerRenderProps, OverlayRootProps, PanelRenderProps } from "./overlay-root";

// `captureScreenshot` does real rasterization work (dynamic `@zumer/snapdom`
// import, canvas encode) that jsdom can't perform — mocked here so the
// "screenshot lifecycle" tests below can control exactly what
// `beginScreenshot` (`./overlay-root.tsx`) sees a capture resolve to,
// without needing a real DOM layout or canvas backend.
vi.mock("../client/screenshot", () => ({ captureScreenshot: vi.fn() }));

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

    await screen.findByRole("button", { name: /review panel/i });
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

    await screen.findByRole("button", { name: /review panel/i });
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
        renderPanel: () => <div data-testid="panel" />,
      },
    );

    const launcher = await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await screen.findByText(/select words to pin the copy/i);

    await user.click(launcher);

    expect(captured).toBeUndefined();
    // The launcher's own click handler still ran (the panel opened) — proof
    // the click reached the button rather than being silently eaten by the
    // capture handler.
    expect(await screen.findByTestId("panel")).toBeInTheDocument();
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

    await screen.findByRole("button", { name: /review panel/i });
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

    await screen.findByRole("button", { name: /review panel/i });
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

// The bug these cover: the launcher used to call `enterPinDropMode`, so
// pressing it both opened the panel AND armed picking — a reviewer who only
// wanted to read existing feedback got a crosshair cursor and a capture scrim
// over the page. The launcher now opens the panel and nothing else, and the
// `c` shortcut arms picking and nothing else.
describe("launcher ⇄ panel decoupling", () => {
  /**
   * A mutable box a render-prop stub publishes its payload into, so a test
   * can assert on values that have no DOM of their own (`panelSide`,
   * `pinDropMode`, `onTogglePinDrop`). A plain `let` would do, except that
   * TypeScript narrows a `let` only ever assigned inside a callback, which
   * would put a cast on every read.
   */
  interface Payload<T> {
    current: T | null;
  }

  /** A panel stub that both renders something findable and records its payload. */
  function capturePanel(sink: Payload<PanelRenderProps>) {
    return (props: PanelRenderProps) => {
      sink.current = props;
      return <div data-testid="panel" />;
    };
  }

  /** Pin-drop mode's two visible tells: the capture scrim and the hint strip. */
  function pickingChromeCount() {
    return document.querySelectorAll(".r3wr-capture, .r3wr-capture-hint").length;
  }

  it("opens the panel on launcher activation and leaves pin-drop mode disarmed", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    const panel: Payload<PanelRenderProps> = { current: null };
    renderOverlay({ adapter }, { renderPanel: capturePanel(panel) });

    await user.click(await screen.findByRole("button", { name: "Open the review panel" }));

    expect(await screen.findByTestId("panel")).toBeInTheDocument();
    expect(panel.current?.pinDropMode).toBe(false);
    expect(pickingChromeCount()).toBe(0);
  });

  it("closes the panel when the launcher is activated again", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    renderOverlay({ adapter }, { renderPanel: () => <div data-testid="panel" /> });

    const launcher = await screen.findByRole("button", { name: "Open the review panel" });
    await user.click(launcher);
    await screen.findByTestId("panel");

    await user.click(launcher);
    await waitFor(() => expect(screen.queryByTestId("panel")).toBeNull());
  });

  it("arms pin-drop mode on 'c' without opening the panel", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    renderOverlay({ adapter }, { renderPanel: () => <div data-testid="panel" /> });

    await screen.findByRole("button", { name: "Open the review panel" });
    await user.keyboard("c");

    await screen.findByText(/select words to pin the copy/i);
    expect(screen.queryByTestId("panel")).toBeNull();
    // And the launcher still offers to OPEN the panel — arming picking has
    // not touched what that button is for.
    expect(screen.getByRole("button", { name: "Open the review panel" })).toBeInTheDocument();
  });

  it("arms and disarms pin-drop mode through the panel's onTogglePinDrop", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    const panel: Payload<PanelRenderProps> = { current: null };
    renderOverlay({ adapter }, { renderPanel: capturePanel(panel) });

    await user.click(await screen.findByRole("button", { name: "Open the review panel" }));
    await screen.findByTestId("panel");

    act(() => panel.current?.onTogglePinDrop());
    await screen.findByText(/select words to pin the copy/i);
    expect(panel.current?.pinDropMode).toBe(true);

    act(() => panel.current?.onTogglePinDrop());
    await waitFor(() => expect(pickingChromeCount()).toBe(0));
    expect(panel.current?.pinDropMode).toBe(false);
    // Disarming picking is not closing the panel — they are separate axes in
    // both directions.
    expect(screen.getByTestId("panel")).toBeInTheDocument();
  });

  it("renders a composer with the panel shut, since pin-drop mode no longer opens it", async () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "widget");
    target.textContent = "A page element";
    document.body.appendChild(target);
    stubRect(target, { x: 0, y: 0, w: 200, h: 60 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    const composer: Payload<ComposerRenderProps> = { current: null };
    renderOverlay(
      { adapter },
      {
        renderPanel: () => <div data-testid="panel" />,
        renderComposer: (props) => {
          composer.current = props;
          return null;
        },
      },
    );

    await screen.findByRole("button", { name: "Open the review panel" });
    await user.keyboard("c");
    await user.click(target);

    await waitFor(() => expect(composer.current).not.toBeNull());
    expect(composer.current?.panelOpen).toBe(false);
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("names the launcher for what it does, carrying the open-thread count while shut", async () => {
    const adapter = makeAdapter([makeThread({ urlKey: "/" }), makeThread({ urlKey: "/" })]);
    const user = userEvent.setup();
    renderOverlay({ adapter }, { renderPanel: () => <div data-testid="panel" /> });

    const launcher = await screen.findByRole("button", {
      name: "Open the review panel. 2 open on this page",
    });
    await user.click(launcher);

    // Same node, renamed: the count goes away because the panel it counts is
    // now on screen, and the action on offer is the opposite one.
    expect(await screen.findByRole("button", { name: "Close the review panel" })).toBe(launcher);
  });

  it("drops the count from the launcher's name when nothing is open on this page", async () => {
    const adapter = makeAdapter([]);
    renderOverlay({ adapter });

    expect(await screen.findByRole("button", { name: "Open the review panel" })).toBeInTheDocument();
  });
});

describe("launcher docking", () => {
  /**
   * jsdom reports no layout at all, so the launcher's box and the viewport
   * both have to be stated outright — every coordinate in the drag below is
   * derived from these two. The values match jsdom's own defaults, so there
   * is nothing for a later test to inherit.
   */
  function setViewport(width: number, height: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  }

  it("docks the panel to the side that keeps it clear of the launcher, in both payloads", async () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "widget");
    target.textContent = "A page element";
    document.body.appendChild(target);
    stubRect(target, { x: 0, y: 0, w: 200, h: 60 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    let panelSide: string | undefined;
    let composerSide: string | undefined;
    renderOverlay(
      { adapter },
      {
        renderPanel: (props) => {
          panelSide = props.panelSide;
          return <div data-testid="panel" />;
        },
        renderComposer: (props) => {
          composerSide = props.panelSide;
          return null;
        },
      },
    );

    const launcher = await screen.findByRole("button", { name: "Open the review panel" });
    await user.click(launcher);
    await screen.findByTestId("panel");

    // The launcher starts on the right edge, so the panel stays where it has
    // always been — this is "move the panel only when staying put would hide
    // the launcher", not "mirror the launcher".
    expect(panelSide).toBe("right");
    expect(document.querySelector(".r3wr-root")).toHaveAttribute("data-panel-side", "right");

    // Arrow keys are the launcher's non-drag docking path (WCAG 2.5.7), and
    // they need no geometry — the honest way to move it in a DOM with no
    // layout engine.
    launcher.focus();
    await user.keyboard("{ArrowLeft}");

    await waitFor(() => expect(panelSide).toBe("left"));
    expect(launcher).toHaveAttribute("data-edge", "left");
    expect(document.querySelector(".r3wr-root")).toHaveAttribute("data-panel-side", "left");

    // And the same side reaches a composer, which clamps itself against it.
    await user.keyboard("c");
    await user.click(target);
    await waitFor(() => expect(composerSide).toBe("left"));
  });

  // WP9: the panel is an obstacle to the launcher, not just a state of it.
  // Both dock to a viewport edge, so an open panel can end up underneath the
  // pill — and in the shipped default (launcher bottom-right, panel right) it
  // did, over the panel's own keyboard-shortcuts strip. The fix has two
  // halves; this suite covers `OverlayRoot`'s obligation to both.
  it("hands the launcher the open panel's dock, and takes it back when the panel shuts", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    renderOverlay({ adapter }, { renderPanel: () => <div data-testid="panel" /> });

    const launcher = await screen.findByRole("button", { name: "Open the review panel" });
    setViewport(1440, 900);
    stubRect(launcher, { x: 0, y: 0, w: 132, h: 44 });

    // The bottom edge is where a dock actually constrains the launcher: the
    // panel is full-height, so a pill travelling a HORIZONTAL edge is the one
    // that can slide into its column. Arrow keys are the geometry-free way to
    // get it there (WCAG 2.5.7's non-drag path, reused here as a test seam).
    launcher.focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(launcher).toHaveAttribute("data-edge", "bottom"));

    // Panel shut: the far end of the 1440 - 132 = 1308px track, one 18px
    // margin in. Nothing to avoid, so nothing is given up.
    expect(launcher.style.getPropertyValue("--r3wr-launcher-pos")).toBe("1290px");

    await user.click(launcher);
    await screen.findByTestId("panel");

    // Panel open: the right-docked panel's 384px column comes off that same
    // end, leaving the pill's right edge one margin clear of it.
    await waitFor(() =>
      expect(launcher.style.getPropertyValue("--r3wr-launcher-pos")).toBe("906px"),
    );

    // And back again — the clamp is tied to the panel being up, not to
    // anything the launcher remembers.
    await user.click(launcher);
    await waitFor(() => expect(screen.queryByTestId("panel")).toBeNull());
    expect(launcher.style.getPropertyValue("--r3wr-launcher-pos")).toBe("1290px");
  });

  // The other half of WP9 is a pair of `overlay.css` rules: a launcher docked
  // to the SAME side as the panel is stepped inboard by the panel's width, on
  // an inset no JS value here carries. A DOM test cannot prove that offset —
  // jsdom applies no stylesheet — so what it proves instead is that the live
  // DOM really does match the selector those rules are written against. The
  // offset itself is verified visually, in `docs/images/`.
  it("carries exactly the attributes the stylesheet's same-edge step-inboard keys on", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    renderOverlay({ adapter }, { renderPanel: () => <div data-testid="panel" /> });

    const launcher = await screen.findByRole("button", { name: "Open the review panel" });
    const root = document.querySelector(".r3wr-root");

    // Shut, so the rules must not match — `data-panel-open` is the term that
    // says so, and it has to be present-and-false rather than absent.
    expect(root).toHaveAttribute("data-panel-open", "false");

    await user.click(launcher);
    await screen.findByTestId("panel");

    // Open, in the default arrangement: launcher on the right edge, panel
    // docked right, no drag in flight.
    expect(
      document.querySelector(
        '.r3wr-root[data-panel-open="true"][data-panel-side="right"] .r3wr-toggle[data-edge="right"]:not([data-dragging])',
      ),
    ).toBe(launcher);

    // The mirror rule, for a launcher a reviewer has moved to the left edge —
    // which takes the panel with it (`panelSideForEdge`), so the two collide
    // there too.
    launcher.focus();
    await user.keyboard("{ArrowLeft}");
    await waitFor(() =>
      expect(root).toHaveAttribute("data-panel-side", "left"),
    );
    expect(
      document.querySelector(
        '.r3wr-root[data-panel-open="true"][data-panel-side="left"] .r3wr-toggle[data-edge="left"]:not([data-dragging])',
      ),
    ).toBe(launcher);
  });

  it("persists the docked position under the configured prefix and restores it on remount", async () => {
    const adapter = makeAdapter([]);
    renderOverlay({ adapter, storagePrefix: "acme" });

    const launcher = await screen.findByRole("button", { name: "Open the review panel" });
    setViewport(1024, 768);
    // The suite's stubbed `getBoundingClientRect` reads `data-rect`, so this
    // is how the pill gets a box worth snapping from.
    stubRect(launcher, { x: 950, y: 700, w: 132, h: 44 });

    // Grabbed 10px in and 20px down from the pill's top-left and released
    // with that box at (30, 380) — centre (96, 402), nearest the left edge,
    // 402/768 of the way down it.
    fireEvent.pointerDown(launcher, { pointerId: 1, button: 0, clientX: 960, clientY: 720 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 40, clientY: 400 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 400 });
    // The browser fires a click after the release; delivering it is what
    // exercises (and clears) the launcher's one-shot suppression of it.
    fireEvent.click(launcher);

    await waitFor(() =>
      expect(window.localStorage.getItem("acme.launcher")).toBe(
        JSON.stringify({ edge: "left", offset: 402 / 768 }),
      ),
    );
    // Letting go of the launcher must not also press it.
    expect(screen.getByRole("button", { name: "Open the review panel" })).toBeInTheDocument();
    cleanup();

    renderOverlay({ adapter, storagePrefix: "acme" });
    expect(await screen.findByRole("button", { name: "Open the review panel" })).toHaveAttribute(
      "data-edge",
      "left",
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
    // The launcher only appears once the gate reaches "unlocked", so finding
    // it is also the wait — and pressing it is how a reviewer opens the panel
    // now that the launcher does that and nothing else.
    await firstUser.click(await screen.findByRole("button", { name: /review panel/i }));
    const toggle = await screen.findByRole("button", { name: /highlights: on/i });
    await firstUser.click(toggle);
    await screen.findByRole("button", { name: /highlights: off/i });
    expect(window.localStorage.getItem("acme.showHighlights")).toBe("0");
    cleanup();

    const secondUser = userEvent.setup();
    renderOverlay({ adapter, storagePrefix: "acme" }, { renderPanel });
    await secondUser.click(await screen.findByRole("button", { name: /review panel/i }));
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

  // Regression: a 404 for an unrelated reason (e.g. an unknown thread
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

    await screen.findByRole("button", { name: /review panel/i });
    expect(document.body.querySelector(`[${OVERLAY_ATTR}]`)).not.toBeNull();
  });
});

describe("polling", () => {
  it("refetches the thread list on the poll interval", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const adapter = makeAdapter([]);
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /review panel/i });
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

    await screen.findByRole("button", { name: /review panel/i });
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

// WP25 / defect 1: `beginScreenshot`'s resulting `shotState` must never
// claim "done" (attached) unless `adapter.uploadScreenshot` actually
// returned a key — see the sibling suite in `./composer.test.tsx` for the
// UI-copy side of this same contract.
describe("screenshot lifecycle", () => {
  // `vi.restoreAllMocks()` in the top-level `afterEach` only restores spies
  // created via `vi.spyOn` — it does not reset the call history or resolved
  // value of `captureScreenshot`, a plain `vi.fn()` supplied by the
  // top-of-file `vi.mock` factory. Without this, a later test in this suite
  // would see call counts left over from an earlier one.
  beforeEach(() => {
    vi.mocked(captureScreenshot).mockReset();
  });

  function dropPinAndCapture(
    target: HTMLElement,
    extraAdapter: Partial<{ uploadScreenshot: (blob: Blob) => Promise<string | null> }>,
  ) {
    stubRect(target, { x: 0, y: 0, w: 100, h: 40 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
    const adapter = { ...makeAdapter([]), ...extraAdapter };
    const shotStates: Array<string> = [];
    const user = userEvent.setup();
    renderOverlay(
      { adapter },
      {
        renderComposer: (props) => {
          shotStates.push(props.shotState);
          return null;
        },
      },
    );
    return { adapter, shotStates, user };
  }

  it('never reports "done" when uploadScreenshot resolves null — it reports "unavailable" instead', async () => {
    vi.mocked(captureScreenshot).mockResolvedValue(new Blob(["x"], { type: "image/png" }));
    const target = document.createElement("div");
    document.body.appendChild(target);
    const { shotStates, user } = dropPinAndCapture(target, {
      uploadScreenshot: vi.fn().mockResolvedValue(null),
    });

    await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await user.click(target);

    await waitFor(() => expect(shotStates).toContain("unavailable"));
    expect(shotStates).not.toContain("done");
  });

  it('reports "done" when uploadScreenshot resolves a real key', async () => {
    vi.mocked(captureScreenshot).mockResolvedValue(new Blob(["x"], { type: "image/png" }));
    const target = document.createElement("div");
    document.body.appendChild(target);
    const { shotStates, user } = dropPinAndCapture(target, {
      uploadScreenshot: vi.fn().mockResolvedValue("shots/abc123.png"),
    });

    await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await user.click(target);

    await waitFor(() => expect(shotStates).toContain("done"));
    expect(shotStates).not.toContain("unavailable");
  });

  it("never attempts a capture, and shotState stays idle, when the adapter has no uploadScreenshot at all", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const { shotStates, user } = dropPinAndCapture(target, {});

    await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await user.click(target);

    await waitFor(() => expect(shotStates.length).toBeGreaterThan(0));
    expect(captureScreenshot).not.toHaveBeenCalled();
    expect(shotStates.every((s) => s === "idle")).toBe(true);
  });
});
