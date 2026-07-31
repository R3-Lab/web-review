/**
 * Integration test — the full pin → composer → panel → reply → resolve
 * round trip, wired through `OverlayRoot`'s real render-prop seam with THIS
 * package's actual `Composer` / `Panel` / `UnlockDialog` (not the inline
 * stub components `./overlay-root.test.tsx` uses to test the seam itself in
 * isolation). A fake in-memory `ReviewAdapter` stands in for a consumer's
 * storage — copied from `./overlay-root.test.tsx`'s own fake, since it
 * already models the exact contract (`ReviewAdapter`, `core/adapter.ts`)
 * this test also needs.
 *
 * The DOM geometry stubbing (jsdom has no layout engine) is the same
 * established pattern as `./overlay-root.test.tsx` and `../anchor.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { ReviewApiError } from "../core/adapter";
import type { ListThreadsParams } from "../core/adapter";
import { resolveConfig } from "../core/config";
import type { ReviewConfig } from "../core/config";
import type {
  NewCommentInput,
  NewThreadInput,
  ReviewCommentView,
  ReviewStatus,
  ReviewThreadView,
} from "../core/types";
import { Composer } from "./composer";
import { OverlayRoot } from "./overlay-root";
import { Panel } from "./panel";
import { UnlockDialog } from "./unlock-dialog";

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

  // `addComment`/`setStatus` replace the store's entry with a FRESH object
  // rather than mutating the existing one in place. `getThread` hands its
  // return value straight into `OverlayRoot`'s React state (no defensive
  // copy — that's realistic; a real adapter wouldn't hand back the same JS
  // object across two different calls either), so mutating that shared
  // object here would alias the array `OverlayRoot`'s own immutable
  // `[...t.comments, comment]` update spreads from, silently doubling every
  // reply/status write. Copy-on-write in the fixture is what keeps that
  // invisible in a real adapter but caught here.
  const addComment = vi.fn(
    async (threadId: string, input: NewCommentInput): Promise<ReviewCommentView> => {
      await Promise.resolve();
      const idx = store.findIndex((row) => row.id === threadId);
      if (idx === -1) throw new ReviewApiError(404, "not found");
      seq += 1;
      const comment: ReviewCommentView = {
        id: `c${seq}`,
        threadId,
        body: input.body,
        authorId: input.authorId,
        authorName: input.authorName,
        createdAt: new Date().toISOString(),
      };
      const current = store[idx];
      if (!current) throw new ReviewApiError(404, "not found");
      store[idx] = {
        ...current,
        comments: [...current.comments, comment],
        commentCount: current.commentCount + 1,
      };
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
      const idx = store.findIndex((row) => row.id === threadId);
      if (idx === -1) throw new ReviewApiError(404, "not found");
      const current = store[idx];
      if (!current) throw new ReviewApiError(404, "not found");
      const updated: ReviewThreadView = {
        ...current,
        status,
        resolvedAt: status === "resolved" ? new Date().toISOString() : null,
        resolvedBy: status === "resolved" ? (resolvedBy ?? null) : null,
      };
      store[idx] = updated;
      return updated;
    },
  );

  return { listThreads, getThread, createThread, addComment, setStatus };
}

function renderFullOverlay(config: ReviewConfig) {
  return render(
    <OverlayRoot
      config={resolveConfig(config)}
      renderComposer={(p) => <Composer {...p} />}
      renderPanel={(p) => <Panel {...p} />}
      renderUnlockDialog={(p) => <UnlockDialog {...p} />}
    />,
  );
}

/** A host-page element to pin, with the geometry stubs the click path needs. */
function mountTarget() {
  const target = document.createElement("div");
  target.setAttribute("data-testid", "widget");
  target.textContent = "A page element under review";
  document.body.appendChild(target);
  stubRect(target, { x: 0, y: 0, w: 200, h: 60 });
  vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
  return target;
}

describe("panel-surface integration: pin drop → composer → panel → reply → resolve", () => {
  it("carries a new thread from pin-drop through the composer, the panel list, detail, a reply, and a resolve", async () => {
    const target = mountTarget();

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    renderFullOverlay({ adapter });

    // ── drop a pin, entering the composer ──────────────────────────────────
    await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await user.click(target);

    // ── fill the composer and submit ───────────────────────────────────────
    await user.type(screen.getByLabelText(/title/i), "Broken layout");
    await user.type(screen.getByLabelText(/comment/i), "This element overflows on mobile.");
    await user.type(screen.getByLabelText(/your name/i), "Ada Reviewer");
    await user.click(screen.getByRole("radio", { name: /bug/i }));
    await user.click(screen.getByRole("button", { name: /add feedback/i }));

    await waitFor(() => expect(adapter.createThread).toHaveBeenCalledTimes(1));
    expect(adapter.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "bug",
        title: "Broken layout",
        firstComment: "This element overflows on mobile.",
        authorName: "Ada Reviewer",
      }),
    );

    // Submitting opens straight to the new thread's own detail view.
    await screen.findByText(/broken layout/i);
    expect(screen.getByRole("heading", { name: /^thread$/i })).toBeInTheDocument();

    // ── back to the list: the thread is there ──────────────────────────────
    await user.click(screen.getByRole("button", { name: /all feedback/i }));
    // The on-page PIN also carries "Broken layout" in its own aria-label
    // ("Review pin 1, Bug, open: Broken layout"), so a role/name query for
    // the row would match both. `getByText` only matches rendered text
    // nodes (not attribute values), so it lands on the row's title
    // paragraph alone; `.closest("button")` gets the row itself.
    const titleEl = await screen.findByText(/broken layout/i);
    const row = titleEl.closest("button");
    if (!row) throw new Error("expected the thread row's <button> ancestor");
    expect(row).toHaveTextContent("Bug");
    expect(row).toHaveTextContent("Ada Reviewer");

    // ── open it ─────────────────────────────────────────────────────────────
    await user.click(row);
    await screen.findByRole("heading", { name: /^thread$/i });

    // ── reply ───────────────────────────────────────────────────────────────
    await user.type(screen.getByLabelText(/^reply$/i), "Confirmed, filing a fix.");
    await user.click(screen.getByRole("button", { name: /^reply$/i }));
    await waitFor(() => expect(adapter.addComment).toHaveBeenCalledTimes(1));
    await screen.findByText(/confirmed, filing a fix/i);

    // ── resolve ─────────────────────────────────────────────────────────────
    await user.click(screen.getByRole("button", { name: /resolve/i }));
    await waitFor(() =>
      expect(adapter.setStatus).toHaveBeenCalledWith(expect.any(String), "resolved", "Ada Reviewer"),
    );
    await screen.findByRole("button", { name: /reopen/i });
  });
});

/**
 * The decoupling, end to end through the real components rather than the seam
 * alone: the launcher used to do both jobs, and a reviewer who only wanted to
 * READ the feedback on a page was put into picking mode as a side effect —
 * crosshair cursor, capture scrim, every click on the host page swallowed.
 * These two intentions are now expressed separately, and the panel's own
 * control is the visible half of that split.
 */
describe("panel-surface integration: the launcher opens the panel, the panel arms picking", () => {
  it("opens the panel without arming pin-drop mode, then arms it from the panel's own New comment control", async () => {
    const target = mountTarget();
    const user = userEvent.setup();
    renderFullOverlay({ adapter: makeAdapter([]) });

    // ── the launcher opens the panel, and does nothing else ────────────────
    await user.click(await screen.findByRole("button", { name: /open the review panel/i }));
    const panel = await screen.findByRole("dialog");
    expect(panel).toHaveClass("r3wr-panel");

    // Picking is NOT armed: no capture hint over the page…
    expect(screen.queryByText(/select words to pin the copy/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new comment/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // …and a click on the host page is still the host page's own click, not
    // a pin drop, so no composer appears.
    await user.click(target);
    expect(screen.queryByLabelText(/^comment$/i)).not.toBeInTheDocument();

    // ── the panel's own control is what arms it ────────────────────────────
    await user.click(screen.getByRole("button", { name: /new comment/i }));
    expect(await screen.findByText(/select words to pin the copy/i)).toBeInTheDocument();
    const armed = screen.getByRole("button", { name: /cancel adding a comment/i });
    expect(armed).toHaveAttribute("aria-pressed", "true");
    expect(armed).toHaveTextContent("Cancel");

    // ── and now the same click really does drop a pin ──────────────────────
    await user.click(target);
    expect(await screen.findByLabelText(/^comment$/i)).toBeInTheDocument();
  });
});
