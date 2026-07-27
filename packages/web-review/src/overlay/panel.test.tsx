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
import { cleanup, render, screen } from "@testing-library/react";
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
    showHighlights: true,
    onToggleHighlights,
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
});
