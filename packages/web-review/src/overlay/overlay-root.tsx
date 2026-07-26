"use client";

/**
 * `OverlayRoot` — the review overlay's state machine and shell chrome.
 *
 * Ported from a working single-app review tool's `FeedbackOverlayInner`
 * (`feedback-overlay-inner.tsx`, lines 1-1130 of that file, plus its helper
 * section). This file owns EVERYTHING that isn't visual composition of the
 * composer / thread panel / thread detail / unlock dialog — those four
 * surfaces are WP4b's job. What lives here:
 *
 *   - the access gate (checking / locked / unlocked / disabled)
 *   - loading + polling threads for the current page
 *   - resolving every thread's anchor against the live DOM each render
 *   - pin-drop mode: the "c" shortcut, click capture, text-selection capture
 *   - pin + highlight rendering (via `./pin`, `./thread-highlight`)
 *   - the draft anchor, screenshot capture, and thread/reply/status writes
 *   - the highlight-visibility toggle (persisted)
 *   - the ARIA live region
 *
 * WP4b's Composer / Panel / ThreadDetail / UnlockDialog are plugged in via
 * `renderComposer` / `renderPanel` / `renderUnlockDialog` render props rather
 * than being imported here — this file has no knowledge of their internals,
 * only of the data and callbacks they need. See the exported `*RenderProps`
 * interfaces below for the exact contract; each one is documented at its
 * declaration since those doc comments ARE the seam WP4b implements against.
 *
 * Differences from the reference, and why:
 *  - `usePathname()` (Next-only) → `useLocation()` (`../client/use-location`,
 *    framework-agnostic, already covers popstate/hashchange/pushState).
 *  - The reference's `commentMode` is named `pinDropMode` here — this
 *    package's overlay drops "pins", not "comments", onto a page; nothing
 *    behavioural changed.
 *  - The click-capture handler also skips `isEditableTarget` targets (the
 *    reference only checked this in the keyboard handler). This is a
 *    deliberate WP4a requirement: a reviewer should never have a pin dropped
 *    UNDER them while typing into a form field on the host page.
 *  - Screenshot upload goes through `config.adapter.uploadScreenshot`
 *    (present only when `config.screenshots` resolved `true`) instead of a
 *    hardcoded API call.
 */

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  captureAnchor,
  getTextSelection,
  isOverlayNode,
  OVERLAY_ATTR,
  pointInSelection,
  resolveAnchor,
} from "../anchor";
import type { SelectionSnapshot } from "../anchor";
import { isFeatureDisabled, isLocked } from "../core/adapter";
import type { ResolvedReviewConfig } from "../core/config";
import type {
  Anchor,
  ResolveResult,
  ReviewerIdentity,
  ReviewStatus,
  ReviewThreadView,
} from "../core/types";
import { ensureIdentity, getIdentity } from "../client/identity";
import { captureScreenshot } from "../client/screenshot";
import { useLocation } from "../client/use-location";
import { KeyRoundIcon, MessageSquarePlusIcon } from "./icons";
import {
  isEditableTarget,
  LiveRegion,
  readShowHighlights,
  toDocRects,
  writeShowHighlights,
} from "./helpers";
import type { DocRect } from "./helpers";
import { DraftPin, Pin } from "./pin";
import { ThreadHighlight } from "./thread-highlight";

/** Marks every node the overlay owns. */
const TAG = { [OVERLAY_ATTR]: "" } as const;

/** Keyboard shortcut (no modifier) that toggles pin-drop mode. */
const PIN_SHORTCUT_KEY = "c";

/** Poll cadence for the thread list, so two reviewers see each other's pins. */
const POLL_MS = 60_000;

/**
 * How long `submitThread` will wait on the in-flight screenshot before
 * giving up and creating the thread without one. Capture starts the moment
 * the pin drops, so in practice this has almost always already resolved by
 * the time a reviewer finishes typing.
 */
const SCREENSHOT_WAIT_MS = 8_000;

/** The overlay's top-level gate. */
type Gate = "checking" | "locked" | "unlocked" | "disabled";

/** Lifecycle of the draft pin's screenshot upload. */
export type ShotState = "idle" | "pending" | "done" | "error";

/** What the hover preview is previewing, so it can be drawn accordingly. */
interface HoverPreview {
  kind: "text" | "element";
  rects: DocRect[];
}

/** The pending anchor a composer is being written against. */
interface Draft {
  anchor: Anchor;
}

// ─────────────────────────── WP4b seam contracts ────────────────────────────

/**
 * Everything WP4b's Composer needs to render a form for `anchor` and report
 * back what happened. `OverlayRoot` calls `renderComposer(props)` in place
 * of the composer whenever `draft` is set (i.e. right after a pin drops) and
 * stops calling it the moment `onCancel` or a successful `onSubmit` runs.
 */
export interface ComposerRenderProps {
  /** The anchor captured at pin-drop. Immutable for the life of one draft. */
  anchor: Anchor;
  /** Carries `adapter`, `categories`, `screenshots`, `debug`, etc. */
  config: ResolvedReviewConfig;
  /** The current reviewer identity, or `null` if never set. */
  identity: ReviewerIdentity | null;
  /** Lifecycle of the screenshot capture kicked off at pin-drop. */
  shotState: ShotState;
  /** Dismiss the draft without creating a thread (also bound to Escape). */
  onCancel: () => void;
  /**
   * Create the thread. `OverlayRoot` fills in `anchor`/`viewport`/`url`/
   * `urlKey`/`locale`/`route` from the draft anchor and resolves the
   * reviewer identity from `name` (falling back to the existing identity,
   * then `"Anonymous"`) — the composer only supplies what the reviewer
   * typed. Resolves once the thread is created, merged into overlay state,
   * selected, and the panel is opened; rejects (typically with a
   * `ReviewApiError`, status 401 on a locked session) otherwise, leaving the
   * draft in place so nothing typed is lost.
   */
  onSubmit: (input: {
    category: string;
    title: string;
    body: string;
    name: string;
  }) => Promise<void>;
  /**
   * Call after an inline unlock (a 401 from `onSubmit`, recovered via
   * `config.adapter.unlock`) succeeds. Flips the gate back to `"unlocked"`
   * and refreshes the thread list; does NOT retry `onSubmit` — the composer
   * does that itself once this resolves.
   */
  onUnlocked: () => void;
}

/**
 * Everything WP4b's thread panel (list + detail) needs. `OverlayRoot` calls
 * `renderPanel(props)` whenever `panelOpen` is true; `threads` is already
 * filtered by `filter`, `selected` is the full thread (with comments) once
 * `onSelect` has resolved it, or the list-row projection until then.
 */
export interface PanelRenderProps {
  config: ResolvedReviewConfig;
  /** The current page's key — display it so a reviewer knows what they're viewing. */
  urlKey: string;
  /** Pre-filtered by `filter`; drives both the panel's list and the on-page pins. */
  threads: ReviewThreadView[];
  filter: ReviewStatus | "all";
  onFilterChange: (filter: ReviewStatus | "all") => void;
  /** The thread whose detail view is open, or `null` for the list view. */
  selected: ReviewThreadView | null;
  /** `selected`'s live anchor resolution, for a drift note in the detail view. */
  selectedResolved: ResolveResult | undefined;
  identity: ReviewerIdentity | null;
  showHighlights: boolean;
  onToggleHighlights: () => void;
  onClose: () => void;
  /** Select a thread by id — fetches its full comment list and opens the panel. */
  onSelect: (id: string) => void;
  /** Back out of the detail view to the list. */
  onBack: () => void;
  /** Post a reply on `threadId`. Resolves once merged into overlay state. */
  onReply: (threadId: string, body: string, name: string) => Promise<void>;
  /** Flip a thread's status (open ⇄ resolved). Resolves once merged. */
  onToggleStatus: (thread: ReviewThreadView) => Promise<void>;
  /** Same contract as {@link ComposerRenderProps.onUnlocked}. */
  onUnlocked: () => void;
}

/**
 * Rendered by `OverlayRoot` when the gate is `"locked"` and the reviewer has
 * opened the launcher's dialog. `OverlayRoot` owns the launcher button
 * itself (see `renderUnlockDialog`'s call site) — WP4b supplies only the
 * dialog's contents (a password field wired to `config.adapter.unlock`).
 */
export interface UnlockRenderProps {
  config: ResolvedReviewConfig;
  onClose: () => void;
  /** Call once `config.adapter.unlock` resolves. Re-probes access and closes the dialog. */
  onUnlocked: () => void;
}

export interface OverlayRootProps {
  config: ResolvedReviewConfig;
  renderComposer?: (props: ComposerRenderProps) => ReactNode;
  renderPanel?: (props: PanelRenderProps) => ReactNode;
  renderUnlockDialog?: (props: UnlockRenderProps) => ReactNode;
}

export function OverlayRoot({
  config,
  renderComposer,
  renderPanel,
  renderUnlockDialog,
}: OverlayRootProps) {
  const href = useLocation();
  const urlKey = useMemo(() => config.urlKeyFromHref(href), [href, config]);

  const [gate, setGate] = useState<Gate>("checking");

  const [panelOpen, setPanelOpen] = useState(false);
  const [pinDropMode, setPinDropMode] = useState(false);
  // Lazy initializers, not effects: this component only ever mounts on the
  // client (its wrapper renders nothing during prerender), so there is no
  // server render for these reads to disagree with.
  const [showHighlights, setShowHighlights] = useState(() =>
    readShowHighlights(config.storagePrefix),
  );
  const [hover, setHover] = useState<HoverPreview | null>(null);

  const [threads, setThreads] = useState<ReviewThreadView[]>([]);
  const [filter, setFilter] = useState<ReviewStatus | "all">("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [shotState, setShotState] = useState<ShotState>("idle");
  const shotRef = useRef<Promise<string | null> | null>(null);

  const [identity, setIdentity] = useState<ReviewerIdentity | null>(() =>
    getIdentity(config.storagePrefix),
  );

  // The locked launcher's dialog.
  const [unlockOpen, setUnlockOpen] = useState(false);

  // Polite live region — pin-drop mode, pin drops, resolves.
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((msg: string) => setAnnouncement(msg), []);

  // The selection captured at mousedown. The browser collapses the live
  // selection as part of its default mousedown handling, so by the time
  // `click` fires a pre-existing highlight is already gone — snapshotting
  // here is what makes "select the sentence, press c, click it" work at all.
  const pendingSelection = useRef<SelectionSnapshot | null>(null);

  // Force pin repositioning without re-fetching (scroll/resize/mutation).
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => (n + 1) % 1_000_000), []);

  const toggleShowHighlights = useCallback(() => {
    setShowHighlights((prev) => {
      const next = !prev;
      writeShowHighlights(config.storagePrefix, next);
      return next;
    });
  }, [config]);

  // ── the gate: one probe decides locked / unlocked / feature-off ───────────
  const probe = useCallback(
    async (key: string): Promise<Gate> => {
      try {
        const list = await config.adapter.listThreads({
          urlKey: key,
          project: config.project,
          status: "all",
        });
        setThreads(list);
        return "unlocked";
      } catch (err) {
        if (isFeatureDisabled(err)) return "disabled";
        if (isLocked(err)) return "locked";
        // Fail soft: a transient network failure must not lock a reviewer
        // out of a tool that is already behind its own gate. Writes will
        // surface the real error.
        if (config.debug) console.warn("[web-review] thread probe failed", err);
        return "unlocked";
      }
    },
    [config],
  );

  useEffect(() => {
    if (!urlKey) return;
    let cancelled = false;
    void (async () => {
      const next = await probe(urlKey);
      if (!cancelled) setGate(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [urlKey, probe]);

  // ── load + poll threads for the current page ──────────────────────────────
  const reload = useCallback(async () => {
    if (!urlKey) return;
    try {
      setThreads(
        await config.adapter.listThreads({ urlKey, project: config.project, status: "all" }),
      );
    } catch (err) {
      if (isLocked(err)) {
        setGate("locked");
        return;
      }
      // A failed poll is non-fatal: keep the last list.
    }
  }, [urlKey, config]);

  useEffect(() => {
    if (gate !== "unlocked" || !urlKey) return;
    const t = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(t);
  }, [gate, urlKey, reload]);

  /** After an inline unlock succeeded mid-write: re-open the gate and re-fetch. */
  const onUnlocked = useCallback(() => {
    setGate("unlocked");
    void reload();
  }, [reload]);

  // ── live tracking: scroll/resize (rAF) and mutations, nothing else ────────
  useEffect(() => {
    if (gate !== "unlocked") return;
    let raf = 0;
    const onMove = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        bump();
      });
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);

    // Ignore mutations that are entirely our own — observing everything
    // would feed the observer with our own re-render, and the overlay would
    // re-render every frame forever. (The rAF throttle hides the cost; it
    // doesn't remove it.)
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        const node = r.target;
        const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
        if (isOverlayNode(el)) continue;
        onMove();
        return;
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });

    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      mo.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [gate, bump]);

  // ── pin-drop mode ──────────────────────────────────────────────────────────
  const enterPinDropMode = useCallback(() => {
    setPinDropMode(true);
    setPanelOpen(true);
    setSelectedId(null);
    announce("Pin-drop mode on. Select text or click an element to drop a pin. Press Escape to cancel.");
  }, [announce]);

  const exitPinDropMode = useCallback(() => {
    setPinDropMode(false);
    pendingSelection.current = null;
    announce("Pin-drop mode off.");
  }, [announce]);

  const cancelDraft = useCallback(() => {
    setDraft(null);
    setShotState("idle");
    shotRef.current = null;
  }, []);

  // ── screenshot: starts at pin-drop, never blocks the submit ───────────────
  // Kicked off as soon as the pin lands, so it captures the page as the
  // reviewer saw it rather than whatever it looks like once they finish
  // typing, and so the submit almost never has to wait on it.
  const beginScreenshot = useCallback(
    (anchor: Anchor) => {
      if (!config.screenshots || !config.adapter.uploadScreenshot) return;
      setShotState("pending");
      shotRef.current = (async () => {
        try {
          const target = resolveAnchor(anchor).el ?? null;
          const blob = await captureScreenshot(target, { debug: config.debug });
          if (!blob) {
            setShotState("error");
            return null;
          }
          // Re-checked via optional chaining rather than hoisting a bare
          // reference to `config.adapter.uploadScreenshot`: TS narrowing on
          // an object property doesn't survive crossing into this nested
          // closure, and calling it unbound (not through `config.adapter.`)
          // would silently break a consumer whose adapter is a class method
          // relying on `this` — see `use-location.ts`'s
          // `unboundHistoryMethod` for the same concern elsewhere.
          const key = (await config.adapter.uploadScreenshot?.(blob)) ?? null;
          setShotState("done");
          return key;
        } catch (err) {
          // Hard contract: a screenshot failure is never allowed to cost the
          // reviewer their comment. Log it and carry on without an image.
          if (config.debug) console.warn("[web-review] screenshot upload failed", err);
          setShotState("error");
          return null;
        }
      })();
    },
    [config],
  );

  // Keyboard: "c" toggles pin-drop mode, Escape unwinds the deepest surface.
  useEffect(() => {
    if (gate === "disabled" || gate === "checking") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (unlockOpen) {
          setUnlockOpen(false);
          e.preventDefault();
        } else if (pinDropMode) {
          exitPinDropMode();
          e.preventDefault();
        } else if (draft) {
          cancelDraft();
          e.preventDefault();
        } else if (panelOpen) {
          setPanelOpen(false);
          e.preventDefault();
        }
        return;
      }
      if (gate !== "unlocked") return;
      if (e.key.toLowerCase() !== PIN_SHORTCUT_KEY) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Never steal a keystroke from a text field — including our own.
      if (isEditableTarget(document.activeElement)) return;
      // The composer is open; "c" must not re-arm picking underneath it.
      if (draft) return;
      e.preventDefault();
      if (pinDropMode) exitPinDropMode();
      else enterPinDropMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gate, pinDropMode, draft, panelOpen, unlockOpen, enterPinDropMode, exitPinDropMode, cancelDraft]);

  // Crosshair cursor while picking. The capture scrim is `pointer-events:
  // none` (clicks and text selection must reach the page), so it can't carry
  // the cursor itself — the document root does.
  useEffect(() => {
    if (!pinDropMode || gate !== "unlocked") return;
    const { documentElement, body } = document;
    documentElement.classList.add("r3wr-picking");
    body.classList.add("r3wr-picking");
    return () => {
      documentElement.classList.remove("r3wr-picking");
      body.classList.remove("r3wr-picking");
    };
  }, [pinDropMode, gate]);

  // Snapshot the selection at mousedown, but only when the press lands ON
  // the highlight — a reviewer who selects a sentence and then clicks a
  // button across the page wants an element pin there, not the stale
  // selection.
  useEffect(() => {
    if (!pinDropMode || gate !== "unlocked") return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (isOverlayNode(target)) return;
      const sel = getTextSelection();
      pendingSelection.current = sel && pointInSelection(sel, e.clientX, e.clientY) ? sel : null;
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [pinDropMode, gate]);

  // Click capture: drop the pin. Skips our own chrome AND editable targets —
  // the latter is a WP4a requirement the reference implementation didn't
  // need: a reviewer must never have a pin dropped under them while typing
  // into a host-page form field.
  useEffect(() => {
    if (!pinDropMode || gate !== "unlocked") return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (isOverlayNode(target) || isEditableTarget(target)) return;
      // Capture phase, so the page never sees the click: no navigation, no
      // form submit, no accordion toggling under the reviewer.
      e.preventDefault();
      e.stopPropagation();

      // Two ways to land a text pin, and they get different trust:
      //  - A LIVE selection at click time means the reviewer just finished
      //    drag-selecting and this click is that drag's mouseup.
      //  - The mousedown SNAPSHOT may be minutes old, so it only counts when
      //    the press landed on the highlight itself.
      const selection = getTextSelection() ?? pendingSelection.current;
      pendingSelection.current = null;

      const anchor = captureAnchor(e.clientX, e.clientY, selection);
      if (!anchor) return;
      setDraft({ anchor });
      setPinDropMode(false);
      setHover(null);
      beginScreenshot(anchor);
      announce(
        anchor.kind === "text"
          ? `Pinned the text "${(anchor.selectedText ?? "").slice(0, 80)}". Describe the problem.`
          : "Pin dropped. Describe the problem.",
      );
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [pinDropMode, gate, announce, beginScreenshot]);

  // Hover-to-select preview. A live selection wins over the element box, so
  // the reviewer sees exactly the words that will be recorded. rAF-throttled;
  // boxes are in DOCUMENT coords so they stay glued to the page while
  // scrolling.
  useEffect(() => {
    if (!pinDropMode || gate !== "unlocked") return;
    let raf = 0;
    let lastX = 0;
    let lastY = 0;
    const compute = () => {
      raf = 0;
      const sel = getTextSelection();
      if (sel) {
        const boxes = toDocRects(sel.range.getClientRects()).filter(
          (b) => b.width > 0 && b.height > 0,
        );
        if (boxes.length > 0) {
          setHover({ kind: "text", rects: boxes });
          return;
        }
      }
      let el = document.elementFromPoint(lastX, lastY);
      if (isOverlayNode(el)) {
        setHover(null);
        return;
      }
      if (!el || el === document.documentElement) el = document.body;
      if (!el) {
        setHover(null);
        return;
      }
      setHover({ kind: "element", rects: toDocRects([el.getBoundingClientRect()]) });
    };
    const onMove = (e: MouseEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (raf) return;
      raf = window.requestAnimationFrame(compute);
    };
    document.addEventListener("mousemove", onMove, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      if (raf) window.cancelAnimationFrame(raf);
      setHover(null);
    };
  }, [pinDropMode, gate]);

  // ── create thread ───────────────────────────────────────────────────────
  const submitThread = useCallback(
    async (input: { category: string; title: string; body: string; name: string }) => {
      if (!draft) return;
      const who = ensureIdentity(config.storagePrefix, input.name || identity?.name || "Anonymous");
      setIdentity(who);

      const screenshotKey = await waitForScreenshot(shotRef.current);

      const thread = await config.adapter.createThread({
        project: config.project,
        url: draft.anchor.href,
        urlKey: draft.anchor.urlKey,
        locale: config.localeFromHref(draft.anchor.href),
        route: new URL(draft.anchor.href, window.location.origin).pathname,
        title: input.title.trim() || null,
        category: input.category,
        anchor: draft.anchor,
        viewport: draft.anchor.viewport,
        authorId: who.id,
        authorName: who.name,
        firstComment: input.body.trim(),
        screenshotKey,
      });

      setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
      cancelDraft();
      setSelectedId(thread.id);
      setPanelOpen(true);
      setFilter((f) => (f === "resolved" ? "open" : f));
      announce("Feedback saved.");
    },
    [draft, identity, config, cancelDraft, announce],
  );

  const onSelectThread = useCallback(
    (id: string) => {
      setSelectedId(id);
      setPanelOpen(true);
      void (async () => {
        try {
          const full = await config.adapter.getThread(id);
          setThreads((prev) => prev.map((t) => (t.id === id ? full : t)));
        } catch {
          // Keep the list-row projection; the detail view degrades to its snippet.
        }
      })();
    },
    [config],
  );

  const submitReply = useCallback(
    async (threadId: string, body: string, name: string) => {
      const who = ensureIdentity(config.storagePrefix, name || identity?.name || "Anonymous");
      setIdentity(who);
      // The adapter returns the COMMENT, not the thread — merge it in by hand.
      const comment = await config.adapter.addComment(threadId, {
        body: body.trim(),
        authorId: who.id,
        authorName: who.name,
      });
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId
            ? {
                ...t,
                comments: [...t.comments, comment],
                commentCount: t.commentCount + 1,
                updatedAt: comment.createdAt,
              }
            : t,
        ),
      );
      announce("Reply posted.");
    },
    [identity, config, announce],
  );

  const toggleStatus = useCallback(
    async (thread: ReviewThreadView) => {
      const next: ReviewStatus = thread.status === "open" ? "resolved" : "open";
      const who = identity ?? getIdentity(config.storagePrefix);
      const updated = await config.adapter.setStatus(thread.id, next, who?.name ?? null);
      setThreads((prev) => prev.map((t) => (t.id === thread.id ? updated : t)));
      announce(next === "resolved" ? "Thread resolved." : "Thread reopened.");
    },
    [identity, config, announce],
  );

  // ── render ──────────────────────────────────────────────────────────────

  // The `document` guard is belt-and-braces — this component only ever
  // mounts client-side (see `./review-overlay.tsx`) — but `createPortal`
  // would throw rather than degrade if that ever stopped being true.
  // `gate === "disabled"` means the adapter reported the feature switched
  // off server-side (404 `not_found`): there is nothing to unlock and no
  // honest prompt to show, so the overlay disappears entirely.
  if (typeof document === "undefined" || gate === "disabled") return null;

  if (gate !== "unlocked") {
    return createPortal(
      <div className="r3wr-root" {...TAG}>
        <LiveRegion message={announcement} className="r3wr-sr-only" tag={TAG} />
        {unlockOpen &&
          gate === "locked" &&
          renderUnlockDialog?.({
            config,
            onClose: () => setUnlockOpen(false),
            onUnlocked: () => {
              setUnlockOpen(false);
              setGate("checking");
              void (async () => setGate(await probe(urlKey)))();
            },
          })}
        <div className="r3wr-interactive" {...TAG}>
          <button
            type="button"
            className="r3wr-toggle"
            data-locked="true"
            {...TAG}
            disabled={gate === "checking"}
            aria-haspopup="dialog"
            aria-expanded={unlockOpen}
            aria-label={
              gate === "checking"
                ? "Checking review access"
                : "Review is locked — enter the review password"
            }
            onClick={() => setUnlockOpen((open) => !open)}
          >
            <KeyRoundIcon size={16} />
            <span>Review</span>
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  const visibleThreads = threads.filter((t) => (filter === "all" ? true : t.status === filter));
  const openCount = threads.filter((t) => t.status === "open").length;
  const selected = threads.find((t) => t.id === selectedId) ?? null;

  // Resolved ONCE per render and shared by the highlight and pin layers.
  // Deliberately not memoised: liveness on bump()/scroll/route is the point.
  const resolvedByThread = new Map(
    visibleThreads.map((t) => [t.id, resolveAnchor(t.anchor)] as const),
  );

  return createPortal(
    <>
      {/* Document-anchored layer: pins + highlights in page coordinates. */}
      <div className="r3wr-pin-layer" {...TAG}>
        {showHighlights &&
          visibleThreads.map((t) => (
            <ThreadHighlight
              key={`hl-${t.id}`}
              thread={t}
              selected={t.id === selectedId}
              resolved={resolvedByThread.get(t.id)}
              categories={config.categories}
            />
          ))}

        {pinDropMode &&
          hover?.rects.map((r, i) => (
            <div
              key={`hover-${i}`}
              className="r3wr-hover-hl"
              data-kind={hover.kind}
              {...TAG}
              style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            />
          ))}

        {visibleThreads.map((t, i) => (
          <Pin
            key={t.id}
            index={i + 1}
            thread={t}
            selected={t.id === selectedId}
            resolved={resolvedByThread.get(t.id)}
            categories={config.categories}
            onSelect={() => onSelectThread(t.id)}
          />
        ))}

        {draft && (
          <DraftPin
            x={draft.anchor.rect.x + draft.anchor.offsetPct.x * draft.anchor.rect.w}
            y={draft.anchor.rect.y + draft.anchor.offsetPct.y * draft.anchor.rect.h}
          />
        )}
      </div>

      {/* Viewport-fixed chrome. */}
      <div className="r3wr-root" data-panel-open={panelOpen} {...TAG}>
        <LiveRegion message={announcement} className="r3wr-sr-only" tag={TAG} />

        {pinDropMode && (
          <>
            <div className="r3wr-capture" {...TAG} />
            <p className="r3wr-capture-hint" {...TAG}>
              {hover?.kind === "text" ? (
                <>
                  Click the highlighted text to pin it · <kbd {...TAG}>Esc</kbd> to cancel
                </>
              ) : (
                <>
                  Select words to pin the copy, or click any element ·{" "}
                  <kbd {...TAG}>Esc</kbd> to cancel
                </>
              )}
            </p>
          </>
        )}

        {draft &&
          renderComposer?.({
            anchor: draft.anchor,
            config,
            identity,
            shotState,
            onCancel: cancelDraft,
            onSubmit: submitThread,
            onUnlocked,
          })}

        {panelOpen &&
          renderPanel?.({
            config,
            urlKey,
            threads: visibleThreads,
            filter,
            onFilterChange: setFilter,
            selected,
            selectedResolved: selected ? resolvedByThread.get(selected.id) : undefined,
            identity,
            showHighlights,
            onToggleHighlights: toggleShowHighlights,
            onClose: () => setPanelOpen(false),
            onSelect: onSelectThread,
            onBack: () => setSelectedId(null),
            onReply: submitReply,
            onToggleStatus: toggleStatus,
            onUnlocked,
          })}

        <div className="r3wr-interactive" {...TAG}>
          <button
            type="button"
            className="r3wr-toggle"
            data-active={pinDropMode}
            {...TAG}
            aria-pressed={pinDropMode}
            aria-label={
              pinDropMode
                ? "Cancel pin-drop mode (shortcut: C)"
                : `Drop a review pin (shortcut: C). ${openCount} open on this page`
            }
            onClick={() => (pinDropMode ? exitPinDropMode() : enterPinDropMode())}
          >
            <MessageSquarePlusIcon size={16} />
            <span>Review</span>
            {openCount > 0 && (
              <span className="r3wr-toggle-count" {...TAG} aria-hidden="true">
                {openCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * Wait for the in-flight screenshot upload, but never longer than
 * {@link SCREENSHOT_WAIT_MS}. Resolves to `null` on timeout or failure — the
 * thread is always created, with or without an image.
 */
async function waitForScreenshot(pending: Promise<string | null> | null): Promise<string | null> {
  if (!pending) return null;
  let timer: number | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), SCREENSHOT_WAIT_MS);
  });
  try {
    return await Promise.race([pending, timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}
