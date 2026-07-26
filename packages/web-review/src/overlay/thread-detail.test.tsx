/**
 * `ThreadDetail` interaction tests (vitest + jsdom + React Testing Library).
 *
 * Renders `ThreadDetail` directly against its own props (see
 * `./thread-detail`'s `ThreadDetailProps`) — no `Panel`/`OverlayRoot`
 * involved — so these tests exercise the component in isolation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { ReviewApiError } from "../core/adapter";
import { resolveConfig } from "../core/config";
import type { Anchor, ReviewCommentView, ReviewThreadView } from "../core/types";
import { ThreadDetail } from "./thread-detail";
import type { ThreadDetailProps } from "./thread-detail";

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

function makeComment(overrides: Partial<ReviewCommentView> = {}): ReviewCommentView {
  return {
    id: "c1",
    threadId: "t1",
    body: "A comment",
    authorId: "u1",
    authorName: "Reviewer",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Deliberately NOT typed against the `ReviewAdapter` interface — see the
// matching comment in `./composer.test.tsx`'s `makeAdapter`.
function makeAdapter() {
  return {
    listThreads: vi.fn(),
    getThread: vi.fn(),
    createThread: vi.fn(),
    addComment: vi.fn(),
    setStatus: vi.fn(),
    unlock: vi.fn(() => Promise.resolve()),
  };
}

function renderDetail(propsOverride: Partial<ThreadDetailProps> = {}) {
  const adapter = makeAdapter();
  const config = resolveConfig({ adapter });
  const onBack = vi.fn();
  const onReply = vi.fn(() => Promise.resolve());
  const onToggleStatus = vi.fn(() => Promise.resolve());
  const onUnlocked = vi.fn();
  const props: ThreadDetailProps = {
    config,
    thread: makeThread(),
    resolved: { confidence: 1 },
    identity: { id: "u1", name: "Ada" },
    onBack,
    onReply,
    onToggleStatus,
    onUnlocked,
    ...propsOverride,
  };
  const utils = render(<ThreadDetail {...props} />);
  return { ...utils, adapter, onBack, onReply, onToggleStatus, onUnlocked, props };
}

describe("ThreadDetail", () => {
  it("renders comments oldest-first, preserving the order they're given in", () => {
    const oldest = makeComment({ id: "c1", body: "First comment", createdAt: "2024-01-01T00:00:00.000Z" });
    const newest = makeComment({ id: "c2", body: "Second comment", createdAt: "2024-01-02T00:00:00.000Z" });
    const { container } = renderDetail({ thread: makeThread({ comments: [oldest, newest] }) });

    const bodies = Array.from(container.querySelectorAll(".r3wr-comment-body")).map((el) => el.textContent);
    expect(bodies).toEqual(["First comment", "Second comment"]);
  });

  it("posts a reply via onReply with the typed body", async () => {
    const user = userEvent.setup();
    const thread = makeThread();
    const { onReply } = renderDetail({ thread });

    await user.type(screen.getByLabelText(/^reply$/i), "New reply text");
    await user.click(screen.getByRole("button", { name: /^reply$/i }));

    await waitFor(() => expect(onReply).toHaveBeenCalledWith(thread.id, "New reply text", "Ada"));
  });

  it("calls onToggleStatus to resolve an open thread", async () => {
    const user = userEvent.setup();
    const thread = makeThread({ status: "open" });
    const { onToggleStatus } = renderDetail({ thread });

    await user.click(screen.getByRole("button", { name: /resolve/i }));
    expect(onToggleStatus).toHaveBeenCalledWith(thread);
  });

  it("calls onToggleStatus to reopen a resolved thread", async () => {
    const user = userEvent.setup();
    const thread = makeThread({ status: "resolved" });
    const { onToggleStatus } = renderDetail({ thread });

    await user.click(screen.getByRole("button", { name: /reopen/i }));
    expect(onToggleStatus).toHaveBeenCalledWith(thread);
  });

  it("shows the drift note when resolved is below the confidence threshold", () => {
    renderDetail({ resolved: { confidence: 0.1 } });
    expect(screen.getByText(/page changed since this was pinned/i)).toBeInTheDocument();
  });

  it("shows the drift note when resolved is undefined", () => {
    renderDetail({ resolved: undefined });
    expect(screen.getByText(/page changed since this was pinned/i)).toBeInTheDocument();
  });

  it("does not show the drift note when resolved is confident", () => {
    renderDetail({ resolved: { confidence: 0.9 } });
    expect(screen.queryByText(/page changed since this was pinned/i)).not.toBeInTheDocument();
  });

  it("renders a screenshot thumbnail only when screenshotUrl is set", () => {
    renderDetail({ thread: makeThread({ screenshotUrl: null }) });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/no screenshot was captured/i)).toBeInTheDocument();
    cleanup();

    renderDetail({ thread: makeThread({ screenshotUrl: "https://cdn.test/shot.png" }) });
    expect(screen.getByRole("img")).toHaveAttribute("src", "https://cdn.test/shot.png");
  });

  it("calls onBack when the back button is clicked", async () => {
    const user = userEvent.setup();
    const { onBack } = renderDetail();
    await user.click(screen.getByRole("button", { name: /all feedback/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("on a 401 from onReply, shows the password field and retries the reply after unlock", async () => {
    const user = userEvent.setup();
    const onReply = vi
      .fn<ThreadDetailProps["onReply"]>()
      .mockRejectedValueOnce(new ReviewApiError(401, "locked"))
      .mockResolvedValueOnce(undefined);
    const { adapter, onUnlocked } = renderDetail({ onReply });

    await user.type(screen.getByLabelText(/^reply$/i), "Locked reply");
    await user.click(screen.getByRole("button", { name: /^reply$/i }));
    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));

    // The inline unlock form's OWN label text contains the word "reply" too
    // ("...this reply will be posted."), so once it appears `/reply/i`
    // (unanchored) would match both labels — anchor to the reply field's
    // exact "Reply" label to keep pointing at the textarea.
    const passwordField = await screen.findByPlaceholderText(/review password/i);
    // The reply survives the failed post.
    expect(screen.getByLabelText(/^reply$/i)).toHaveValue("Locked reply");

    await user.type(passwordField, "secret");
    await user.click(screen.getByRole("button", { name: /unlock & reply/i }));

    await waitFor(() => expect(adapter.unlock).toHaveBeenCalledWith("secret"));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(2));
  });

  it("on a 401 from onToggleStatus, shows the password field and retries the status change after unlock", async () => {
    const user = userEvent.setup();
    const onToggleStatus = vi
      .fn<ThreadDetailProps["onToggleStatus"]>()
      .mockRejectedValueOnce(new ReviewApiError(401, "locked"))
      .mockResolvedValueOnce(undefined);
    const thread = makeThread({ status: "open" });
    const { adapter } = renderDetail({ thread, onToggleStatus });

    await user.click(screen.getByRole("button", { name: /resolve/i }));
    await waitFor(() => expect(onToggleStatus).toHaveBeenCalledTimes(1));

    const passwordField = await screen.findByPlaceholderText(/review password/i);
    await user.type(passwordField, "secret");
    await user.click(screen.getByRole("button", { name: /unlock & save/i }));

    await waitFor(() => expect(adapter.unlock).toHaveBeenCalledWith("secret"));
    await waitFor(() => expect(onToggleStatus).toHaveBeenCalledTimes(2));
  });
});
