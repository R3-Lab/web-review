/**
 * `Panel` interaction tests (vitest + jsdom + React Testing Library).
 *
 * Renders `Panel` directly against a minimal `PanelRenderProps` fixture — no
 * `OverlayRoot` involved — so these tests exercise exactly the seam `Panel`
 * implements against (`./overlay-root`'s `PanelRenderProps`) in isolation.
 * `ThreadDetail` (rendered internally by `Panel` once `selected` is set) has
 * its own dedicated test file, `./thread-detail.test.tsx`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import type { ReviewAdapter } from "../core/adapter";
import { resolveConfig } from "../core/config";
import type { Anchor, ReviewThreadView } from "../core/types";
import { Panel } from "./panel";
import type { PanelRenderProps } from "./overlay-root";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

function makeAdapter(): ReviewAdapter {
  return {
    listThreads: vi.fn(),
    getThread: vi.fn(),
    createThread: vi.fn(),
    addComment: vi.fn(),
    setStatus: vi.fn(),
  };
}

function renderPanel(propsOverride: Partial<PanelRenderProps> = {}) {
  const config = resolveConfig({ adapter: makeAdapter() });
  const onFilterChange = vi.fn();
  const onSelect = vi.fn();
  const onToggleHighlights = vi.fn();
  const onTogglePinDrop = vi.fn();
  const onClose = vi.fn();
  const onBack = vi.fn();
  const onReply = vi.fn(() => Promise.resolve());
  const onToggleStatus = vi.fn(() => Promise.resolve());
  const onUnlocked = vi.fn();
  const props: PanelRenderProps = {
    config,
    urlKey: "/",
    threads: [],
    filter: "open",
    onFilterChange,
    selected: null,
    selectedResolved: undefined,
    identity: { id: "u1", name: "Ada" },
    // "right" is what `panelSideForEdge` returns for the launcher's default
    // edge, so the fixture describes the default configuration.
    panelSide: "right",
    showHighlights: true,
    onToggleHighlights,
    pinDropMode: false,
    onTogglePinDrop,
    onClose,
    onSelect,
    onBack,
    onReply,
    onToggleStatus,
    onUnlocked,
    ...propsOverride,
  };
  const utils = render(<Panel {...props} />);
  return {
    ...utils,
    onFilterChange,
    onSelect,
    onToggleHighlights,
    onTogglePinDrop,
    onClose,
    onBack,
    onReply,
    onToggleStatus,
    onUnlocked,
    props,
  };
}

describe("Panel", () => {
  it("renders one row per thread, showing category, title, author, comment count, and status", () => {
    const open = makeThread({
      title: "First issue",
      category: "bug",
      authorName: "Grace",
      commentCount: 3,
      status: "open",
      comments: [
        {
          id: "c1",
          threadId: "irrelevant",
          body: "The first comment's body",
          authorId: "u1",
          authorName: "Grace",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const resolved = makeThread({ title: "Second issue", status: "resolved" });
    renderPanel({ threads: [open, resolved] });

    const row = screen.getByRole("button", { name: /first issue/i });
    expect(row).toHaveTextContent("Bug");
    expect(row).toHaveTextContent("Open");
    expect(row).toHaveTextContent("3 comments");
    expect(row).toHaveTextContent("Grace");
    expect(row).toHaveTextContent("The first comment's body");

    expect(screen.getByRole("button", { name: /second issue/i })).toHaveTextContent("Resolved");
  });

  it("calls onFilterChange when a filter chip is clicked", async () => {
    const user = userEvent.setup();
    const { onFilterChange } = renderPanel();
    await user.click(screen.getByRole("button", { name: /^resolved$/i }));
    expect(onFilterChange).toHaveBeenCalledWith("resolved");
  });

  it("calls onSelect with the thread id when a row is clicked", async () => {
    const user = userEvent.setup();
    const thread = makeThread({ title: "Click me" });
    const { onSelect } = renderPanel({ threads: [thread] });
    await user.click(screen.getByRole("button", { name: /click me/i }));
    expect(onSelect).toHaveBeenCalledWith(thread.id);
  });

  it("calls onToggleHighlights when the highlight checkbox is toggled", async () => {
    const user = userEvent.setup();
    const { onToggleHighlights } = renderPanel();
    await user.click(screen.getByRole("checkbox", { name: /highlights/i }));
    expect(onToggleHighlights).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the close button is clicked", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();
    await user.click(screen.getByRole("button", { name: /close the review panel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();
    // The panel deliberately never steals focus on open (`useFocusTrap`'s
    // `autoFocus: false` — see the comment on `Panel`'s own `ref`), so a
    // keyboard user reaching for Escape must already have focus somewhere
    // inside it; clicking a real control here is the realistic way to get
    // there rather than asserting Escape works with focus still on <body>.
    await user.click(screen.getByRole("checkbox", { name: /highlights/i }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders ThreadDetail instead of the list once a thread is selected", () => {
    const thread = makeThread({ title: "Selected thread" });
    renderPanel({ threads: [thread], selected: thread });
    expect(screen.getByRole("heading", { name: /^thread$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /all feedback/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^resolved$/i })).not.toBeInTheDocument();
  });

  it("docks to the side it is told to, for both sides", () => {
    renderPanel({ panelSide: "right" });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "right");
    cleanup();

    renderPanel({ panelSide: "left" });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "left");
  });
});

// The launcher opens the panel and nothing else (WP2), so the explicit
// "arm picking" action lives here — and it is the ONLY primary action on this
// surface.
describe("Panel — the New comment control", () => {
  it("renders in the list view and calls onTogglePinDrop exactly once per click", async () => {
    const user = userEvent.setup();
    const { onTogglePinDrop } = renderPanel();
    await user.click(screen.getByRole("button", { name: /new comment/i }));
    expect(onTogglePinDrop).toHaveBeenCalledTimes(1);
  });

  it("carries aria-pressed matching pinDropMode", () => {
    renderPanel({ pinDropMode: false });
    expect(screen.getByRole("button", { name: /new comment/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    cleanup();

    renderPanel({ pinDropMode: true });
    expect(screen.getByRole("button", { name: /cancel adding a comment/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("offers the shortcut hint when idle and the cancel affordance (without it) when armed", () => {
    const { unmount } = renderPanel({ pinDropMode: false });
    const idle = screen.getByRole("button", { name: /new comment/i });
    expect(idle).toHaveTextContent("New comment");
    // The `c` shortcut is advertised here precisely because the launcher's
    // own label stopped advertising it.
    expect(idle.querySelector("kbd")).toHaveTextContent("C");
    unmount();

    renderPanel({ pinDropMode: true });
    const armed = screen.getByRole("button", { name: /cancel adding a comment/i });
    expect(armed).toHaveTextContent("Cancel");
    expect(armed).not.toHaveTextContent("New comment");
    // No hint while armed: the on-page capture hint already says what to
    // click and that Escape cancels.
    expect(armed.querySelector("kbd")).toBeNull();
  });

  it("is absent in the detail view, where the back button is the primary action", () => {
    const thread = makeThread({ title: "Selected thread" });
    renderPanel({ threads: [thread], selected: thread });
    expect(screen.queryByRole("button", { name: /new comment/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel adding a comment/i })).not.toBeInTheDocument();
  });
});

// The strip documents the OVERLAY, not the list, so it is present on both
// views — and every entry names a binding that really exists (`c` and Escape
// in `OverlayRoot`'s keydown handler, the arrow keys in `Launcher`'s).
describe("Panel — the keyboard shortcuts footer", () => {
  function expectShortcuts() {
    const list = screen.getByRole("list", { name: /keyboard shortcuts/i });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]!).toHaveTextContent(/^C\s*New pin$/);
    expect(items[1]!).toHaveTextContent(/^Esc\s*Close \/ cancel$/);
    // The arrows are the WCAG 2.5.7 alternative to dragging the launcher and
    // only work while it has focus — the label must not imply they are global.
    expect(items[2]!).toHaveTextContent(/while it has focus/i);
    expect(within(items[2]!).getAllByText(/^[←↑↓→]$/)).toHaveLength(4);
  }

  it("renders in the list view, named, with all three shortcuts", () => {
    renderPanel();
    expectShortcuts();
  });

  it("renders in the detail view too", () => {
    const thread = makeThread({ title: "Selected thread" });
    renderPanel({ threads: [thread], selected: thread });
    expectShortcuts();
  });

  it("sits outside the scrolling panel body, so a long list cannot scroll it away", () => {
    renderPanel({ threads: [makeThread(), makeThread(), makeThread()] });
    const footer = screen.getByRole("list", { name: /keyboard shortcuts/i }).closest("footer");
    if (!footer) throw new Error("expected the shortcuts list's <footer> ancestor");
    expect(footer.closest(".r3wr-panel-body")).toBeNull();
    expect(footer.parentElement).toHaveClass("r3wr-panel");
    // Last child, i.e. after `.r3wr-panel-body` — the strip is pinned below it.
    expect(footer.previousElementSibling).toHaveClass("r3wr-panel-body");
  });
});
