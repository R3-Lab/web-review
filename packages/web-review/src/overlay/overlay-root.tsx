"use client";

/**
 * `OverlayRoot` — the review overlay's state machine and shell chrome.
 *
 * Ported from a working single-app review tool's `FeedbackOverlayInner`
 * (`feedback-overlay-inner.tsx`, lines 1-1130 of that file, plus its helper
 * section). This file owns EVERYTHING that isn't visual composition of the
 * composer / thread panel / thread detail / unlock dialog — those four
 * surfaces are implemented in `./composer`, `./panel`, and
 * `./unlock-dialog`. What lives here:
 *
 *   - the access gate (checking / locked / unlocked / disabled)
 *   - loading, polling, and PAGE-SCOPING threads for the current page
 *   - resolving every thread's anchor against the live DOM each render
 *   - pin-drop mode: the "c" shortcut, click capture, text-selection capture
 *   - whether the panel is open — an axis of its own, independent of
 *     pin-drop mode (see the differences section below)
 *   - pin + highlight rendering (via `./pin`, `./thread-highlight`)
 *   - the draft anchor, screenshot capture, and thread/reply/status writes
 *   - the pin- and highlight-visibility toggles (persisted, independent), and
 *     the held key that makes the pin layer momentarily click-through
 *   - counting the pins that could not be placed, for the panel's summary
 *   - where the launcher is docked: its state, its persistence, and the
 *     `panelSide` derived from it (component in `./launcher`, model and
 *     storage round trip in `./launcher-position`)
 *   - the ARIA live region
 *
 * `Composer` / `Panel` / `ThreadDetail` / `UnlockDialog` are plugged in via
 * `renderComposer` / `renderPanel` / `renderUnlockDialog` render props rather
 * than being imported here — this file has no knowledge of their internals,
 * only of the data and callbacks they need. See the exported `*RenderProps`
 * interfaces below for the exact contract; each one is documented at its
 * declaration since those doc comments ARE the seam those components
 * implement against.
 *
 * Differences from the reference, and why:
 *  - `usePathname()` (Next-only) → `useLocation()` (`../client/use-location`,
 *    framework-agnostic, already covers popstate/hashchange/pushState).
 *  - The reference's `commentMode` is named `pinDropMode` here — this
 *    package's overlay drops "pins", not "comments", onto a page; nothing
 *    behavioural changed.
 *  - The click-capture handler also skips `isEditableTarget` targets (the
 *    reference only checked this in the keyboard handler). This is a
 *    deliberate requirement: a reviewer should never have a pin dropped
 *    UNDER them while typing into a form field on the host page.
 *  - Screenshot upload goes through `config.adapter.uploadScreenshot`
 *    (present only when `config.screenshots` resolved `true`) instead of a
 *    hardcoded API call.
 *  - The launcher no longer arms pin-drop mode, and pin-drop mode no longer
 *    opens the panel. The reference had one button doing both jobs, so a
 *    reviewer who only wanted to READ the feedback already on the page was
 *    put into picking mode as well — crosshair cursor, capture scrim, every
 *    click on the host page swallowed. Here the launcher opens the panel and
 *    nothing else; arming is an explicit act, either the panel's own control
 *    (`PanelRenderProps.onTogglePinDrop`) or the `c` shortcut. `c` stopping
 *    short of opening the panel is the same separation pointing the other
 *    way: someone who wants to pin something has not asked to read the list.
 *    The one place the two still meet is `submitThread`, which opens the
 *    panel on the thread it just created — that is showing a reviewer the
 *    result of what they did, not a mode being forced on them.
 *  - The launcher is draggable to any viewport edge instead of being nailed
 *    to the bottom-right corner, which on a real site is contested ground
 *    (chat widgets, cookie banners). `OverlayRoot` holds that position and
 *    persists it; `./launcher-position` owns the model and the geometry. The
 *    panel docks to whichever side keeps it off the launcher — `panelSide`,
 *    published to both panel surfaces and written to the chrome wrapper as
 *    `data-panel-side` for the stylesheet. The obligation runs both ways:
 *    with the panel up, the launcher is also handed that side as a `dock` so
 *    it can move out of the panel's column rather than sit on top of its
 *    shortcuts strip. Whether the panel is up at all is carried by
 *    `data-panel-open` on the same wrapper.
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
import {
  anchorPlacement,
  isEditableTarget,
  LiveRegion,
  readShowHighlights,
  readShowPins,
  toDocRects,
  writeShowHighlights,
  writeShowPins,
} from "./helpers";
import type { DocRect } from "./helpers";
import { Launcher } from "./launcher";
import {
  panelSideForEdge,
  readLauncherPosition,
  writeLauncherPosition,
} from "./launcher-position";
import type { LauncherPosition, PanelSide } from "./launcher-position";
import { DraftPin, Pin } from "./pin";
import { ThreadHighlight } from "./thread-highlight";

/** Marks every node the overlay owns. */
const TAG = { [OVERLAY_ATTR]: "" } as const;

/** Keyboard shortcut (no modifier) that toggles pin-drop mode. */
const PIN_SHORTCUT_KEY = "c";

/**
 * Held (not pressed) to make the whole pin layer click-through, so a reviewer
 * can reach a link or a button a pin is sitting on without hiding the pins
 * first. Released, everything goes back.
 *
 * A PLAIN LETTER, and specifically not Alt/Option, which is the obvious first
 * choice and the wrong one. The gesture this exists for is "hold the key,
 * click the thing underneath", so whatever is held is held DURING the click —
 * and every one of the four modifiers rewrites what a click on a link means:
 * Alt/Option downloads the target instead of following it, Ctrl and Meta open
 * it in a new tab, Shift opens it in a new window. A pass-through key that
 * turns the reviewer's click into a download is not a pass-through key. (Alt
 * has a second problem on Windows — pressed alone it focuses the menu bar —
 * but that one is survivable by simply never calling `preventDefault` on it,
 * which is what this handler does anyway. The click semantics are not.)
 *
 * A bare letter has no such baggage: the click that follows carries no
 * modifier flags at all, so the page sees exactly the click a reviewer would
 * have made with no overlay present. `h` for "hide", next to the panel's own
 * Pins switch, which is the same idea made permanent.
 *
 * Matched on the produced character AND the physical key, which is belt and
 * braces in both directions. `e.key` alone strands the state when a modifier
 * is pressed mid-hold and mangles the character the keyup reports (macOS
 * turns Option+h into "˙", which matches nothing); `e.code` alone would bind
 * the physical QWERTY-H position on layouts where that key types something
 * else entirely. Either one matching is enough.
 */
const PASS_THROUGH_KEY = "h";
const PASS_THROUGH_CODE = "KeyH";

/** Whether a key event is {@link PASS_THROUGH_KEY} — see its comment for why both. */
function isPassThroughKey(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === PASS_THROUGH_KEY || e.code === PASS_THROUGH_CODE;
}

/**
 * Shortest gap between a landed fetch and the next refetch triggered by
 * focus/visibility.
 *
 * This is the guard against a reviewer who flicks between two windows
 * comparing them: that is a normal way to review, and it must not turn the
 * overlay into a request generator against the host's API.
 *
 * It is NOT what keeps a single alt-tab down to one request. Both events fire
 * on one return in most browsers, but they fire in the same task — before any
 * request either could start has come back — so a window measured from landed
 * fetches cannot separate them. `refetchInFlight` below is what does, and the
 * two are complementary: one covers returns that overlap, this one covers
 * returns that merely come too close together.
 */
const REFETCH_THROTTLE_MS = 5_000;

/**
 * How long `submitThread` will wait on the in-flight screenshot before
 * giving up and creating the thread without one. Capture starts the moment
 * the pin drops, so in practice this has almost always already resolved by
 * the time a reviewer finishes typing.
 */
const SCREENSHOT_WAIT_MS = 8_000;

/** The overlay's top-level gate. */
type Gate = "checking" | "locked" | "unlocked" | "disabled";

/**
 * Lifecycle of the draft pin's screenshot upload.
 *  - `"idle"`   — not attempted (screenshots off, or no pin yet).
 *  - `"pending"` — capture/upload in flight.
 *  - `"done"`   — a storage key came back; a screenshot really is attached.
 *  - `"unavailable"` — capture succeeded but nothing was stored: either
 *    `adapter.uploadScreenshot` resolved `null` (its documented "storage
 *    failed" signal) or the composer's own capture returned no blob. Either
 *    way, the thread is created with no image — the UI must say so, never
 *    "attached".
 *  - `"error"` — the upload itself threw.
 */
export type ShotState = "idle" | "pending" | "done" | "unavailable" | "error";

/** What the hover preview is previewing, so it can be drawn accordingly. */
interface HoverPreview {
  kind: "text" | "element";
  rects: DocRect[];
}

/** The pending anchor a composer is being written against. */
interface Draft {
  anchor: Anchor;
}

/**
 * A fetched thread list, stamped with the page it was fetched for.
 *
 * The list used to be a bare array, which made "which page is this?"
 * unanswerable and cost two bugs at once. A single-page app changes `urlKey`
 * without unmounting the overlay, so between the navigation and the moment
 * the new fetch resolves the old array was still in state — and every pin in
 * it was still being drawn, anchored against a document it no longer
 * describes. Worse, a fetch for the page being left could resolve AFTER the
 * fetch for the page being entered and quietly replace it.
 *
 * Stamping fixes the first half by construction: the render path compares
 * this key against the page it is actually drawing and renders nothing when
 * they disagree, so navigating clears the pins in the same commit rather than
 * on some later tick. It does NOT fix the second half on its own — see
 * `commitThreads`, which is the half that keeps a late arrival from
 * clobbering a fresher one.
 */
interface ThreadSet {
  /** The `urlKey` these threads were fetched for. `""` before the first fetch. */
  urlKey: string;
  threads: ReviewThreadView[];
}

/** Nothing fetched yet. A module constant so the "no threads" render path keeps a stable array identity. */
const NO_THREADS: ReviewThreadView[] = [];
const EMPTY_THREAD_SET: ThreadSet = { urlKey: "", threads: NO_THREADS };

// ────────────────────────── Panel-surface seam contracts ────────────────────

/**
 * Everything `Composer` needs to render a form for `anchor` and report
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
  /**
   * Whether `.r3wr-panel` is currently rendered alongside the composer.
   * Neither value is the normal case: the panel is a separate axis from
   * pin-drop mode, so a reviewer who armed picking with the `c` shortcut
   * drops a pin with the panel shut, one who armed it from the panel's own
   * control drops a pin with the panel open, and either of them can flip
   * that mid-draft from the launcher or the panel's close button. The
   * composer must read this every render rather than assume either state.
   * On a wide viewport the panel docks 384px along one edge; the composer
   * needs this (with {@link ComposerRenderProps.panelSide}) to keep its own
   * position — the submit button in particular — out from underneath it.
   */
  panelOpen: boolean;
  /**
   * Which side `.r3wr-panel` is docked to right now, so a composer that
   * clamps itself clear of the panel reserves space on the correct edge.
   * Follows the launcher — see `panelSideForEdge` in `./launcher-position`.
   */
  panelSide: PanelSide;
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
 * Everything the thread panel (list + detail) needs. `OverlayRoot` calls
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
  /** Which side the panel docks to. Follows the launcher; see `panelSideForEdge`. */
  panelSide: PanelSide;
  showHighlights: boolean;
  onToggleHighlights: () => void;
  /**
   * Whether the on-page pins are being drawn at all. Persisted, and a
   * separate axis from {@link PanelRenderProps.showHighlights} in both
   * directions — turning one off must never turn the other off.
   *
   * Named `onToggleShowPins` rather than the shorter `onTogglePins` that
   * would match `onToggleHighlights`: this surface already has an
   * `onTogglePinDrop`, and two callbacks a character apart that mean
   * "hide the markers" and "arm picking" is a mistake waiting to be made.
   */
  showPins: boolean;
  onToggleShowPins: () => void;
  /**
   * How many of `threads` have a pin the overlay could not place on this page
   * — anchors that resolved to nothing (`unplaceable`), never ones that
   * resolved weakly (`drifted`). `0` when there are none.
   *
   * A count rather than a list because the panel's job with it is to replace
   * N identical badges with one line. It is scoped to `threads`, i.e. to what
   * the current filter is actually drawing, so the number always describes
   * pins the reviewer can see rather than a page-wide total they cannot
   * reconcile with anything.
   *
   * What the panel may SAY about this is narrow, and it is the same
   * constraint `./pin`'s `ANCHOR_NOTES` works under: an anchor that resolves
   * to nothing here is just as consistent with a page that never held it as
   * with one that changed, so the copy stops at what was observed.
   */
  unplaceableCount: number;
  /** Whether pin-drop mode is currently armed, so the panel's own control can reflect it. */
  pinDropMode: boolean;
  /**
   * Toggle pin-drop mode. This is now the panel's job: the launcher opens the
   * panel and nothing else, so the panel owns the explicit "add a comment"
   * action (the `c` shortcut remains a second path to the same toggle).
   */
  onTogglePinDrop: () => void;
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
 * itself (see `renderUnlockDialog`'s call site) — `UnlockDialog` supplies
 * only the dialog's contents (a password field wired to
 * `config.adapter.unlock`).
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
  const [showPins, setShowPins] = useState(() => readShowPins(config.storagePrefix));
  /**
   * Whether the pass-through key is down right now — the momentary twin of
   * `showPins`, held rather than persisted, and never written to storage: a
   * key that is down cannot survive a reload, so a stored copy of it could
   * only ever be a lie waiting to be read back.
   */
  const [passThrough, setPassThrough] = useState(false);
  const [launcherPosition, setLauncherPosition] = useState(() =>
    readLauncherPosition(config.storagePrefix),
  );
  const [hover, setHover] = useState<HoverPreview | null>(null);

  const [loaded, setLoaded] = useState<ThreadSet>(EMPTY_THREAD_SET);
  const [filter, setFilter] = useState<ReviewStatus | "all">("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /**
   * The threads for the page being rendered right now, or none at all.
   *
   * Two checks, and neither is redundant — they fail in different directions
   * and only both of them together make a wrong-page pin unreachable.
   *
   * The STAMP (`loaded.urlKey === urlKey`) scopes the list as a whole.
   * `loaded` lags `urlKey` for as long as a fetch takes, and during that
   * window the honest answer is "nothing known about this page yet" — not
   * "here are the previous page's pins", which is what drawing
   * `loaded.threads` unconditionally would mean. Being derived, it also
   * settles when the pins disappear: they are gone in the render the URL
   * changed on, not one effect or one response later, so there is no frame in
   * which a reviewer sees another page's feedback over this page's document.
   *
   * The PER-THREAD match (`t.urlKey === urlKey`) scopes the rows inside an
   * otherwise-correct list. Nothing this file does can cause that — it is a
   * server answering a `urlKey` query with a row for a different page, an
   * adapter with an off-by-one in its filter, a shared cache keyed too
   * loosely. The stamp is no defence there, because such a list arrives for
   * the right page and is stamped truthfully. This is cheap, and what it buys
   * is that "a pin renders on a page it does not belong to" has no path
   * through this component at all, rather than no path through the paths we
   * happened to think of.
   */
  const threads =
    loaded.urlKey === urlKey ? loaded.threads.filter((t) => t.urlKey === urlKey) : NO_THREADS;

  /**
   * The page being viewed as of the latest render, readable from inside an
   * async callback that was created before the reviewer navigated.
   *
   * Written during render on purpose. The question this answers — "is the
   * request I am about to commit still the page we are on?" — is asked at the
   * moment a promise RESOLVES, and by then every closure that could ask has
   * long since captured a stale `urlKey`. Assigning in an effect instead
   * would leave a window between the navigation render and the effect flush
   * in which this still names the page we just left.
   */
  const viewedUrlKey = useRef(urlKey);
  viewedUrlKey.current = urlKey;

  /**
   * When the last fetch of any kind landed, so focus and visibility can share
   * one throttle. `0` until the first one does — see {@link commitThreads},
   * which is the only thing that writes it.
   */
  const lastRefetchAt = useRef(0);

  /**
   * Commit a freshly-fetched list for `key`, unless the reviewer has already
   * navigated away from it.
   *
   * Dropping the write is not the same as letting the stamp make it
   * harmless. A stale list committed under its own key would render as
   * nothing — correct — but it would also have thrown away the CURRENT
   * page's list on the way in, leaving the reviewer staring at an empty page
   * until the next poll. Requests do not resolve in the order they were
   * sent, so this is the ordinary case on a slow connection, not a rare one.
   *
   * This is also where `lastRefetchAt` gets stamped, which makes the throttle
   * below mean what it says: time since the last fetch that actually landed,
   * whichever path produced it — the mount probe, the unlock re-probe, the
   * poll interval, or a return to the tab. Stamping in `refetch` instead
   * measured only one of those four, which is why the mount case needed a
   * seeded initial value to stand in for the probe. There is nothing to seed
   * now: the probe commits, and the commit stamps.
   *
   * Deliberately inside the guard, so only an ACCEPTED commit counts. A write
   * dropped for being about the page we just left did not fetch anything for
   * the page we are on, and must not hold off the fetch that will.
   */
  const commitThreads = useCallback((key: string, threads: ReviewThreadView[]) => {
    if (viewedUrlKey.current !== key) return;
    lastRefetchAt.current = Date.now();
    setLoaded({ urlKey: key, threads });
  }, []);

  /**
   * Apply a local edit — a created thread, a posted reply, a status flip — to
   * whichever page's list is currently held.
   *
   * Deliberately preserves the existing stamp rather than re-stamping with
   * the current page. These edits always concern a thread the reviewer was
   * just looking at, so if a navigation raced ahead of the write the result
   * belongs to the page they left: it stays out of the new page's render, and
   * it is still there if they go back.
   */
  const updateThreads = useCallback(
    (update: (prev: ReviewThreadView[]) => ReviewThreadView[]) =>
      setLoaded((prev) => ({ urlKey: prev.urlKey, threads: update(prev.threads) })),
    [],
  );

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

  /**
   * The pins switch. Independent of the highlights one in both directions —
   * see `readShowPins`'s comment in `./helpers` for why they are two keys and
   * not one — and deliberately narrow in what it hides: the launcher, the
   * panel, the composer and the DRAFT pin all keep rendering with pins off,
   * because someone who has turned the markers off to unblock a page is
   * still, right then, a reviewer who wants to drop the next one.
   */
  const toggleShowPins = useCallback(() => {
    setShowPins((prev) => {
      const next = !prev;
      writeShowPins(config.storagePrefix, next);
      return next;
    });
  }, [config]);

  /**
   * Commit a launcher move: state, then storage, so the position survives a
   * reload the way the reviewer left it.
   *
   * The stable identity is load-bearing rather than hygiene — `Launcher`
   * mounts the drag's `pointermove`/`pointerup` listeners in an effect keyed
   * on this callback, so a fresh function on every render would tear those
   * listeners down and re-attach them on every frame of a drag.
   */
  const onLauncherPositionChange = useCallback(
    (next: LauncherPosition) => {
      setLauncherPosition(next);
      writeLauncherPosition(config.storagePrefix, next);
    },
    [config],
  );

  // Which side the panel docks to, so it never covers the launcher the
  // reviewer just pressed. Derived, never stored: the launcher's edge is the
  // single source of truth, and a second copy could only ever disagree.
  const panelSide = panelSideForEdge(launcherPosition.edge);

  // ── the gate: one probe decides locked / unlocked / feature-off ───────────
  // Returns the list rather than committing it, so the one caller — the
  // effect below, which already knows whether its navigation is still the
  // current one — decides whether the result is still wanted. A `setThreads`
  // buried in here could not make that judgement and used to write
  // unconditionally.
  const probe = useCallback(
    async (key: string): Promise<{ gate: Gate; threads?: ReviewThreadView[] }> => {
      try {
        const threads = await config.adapter.listThreads({
          urlKey: key,
          project: config.project,
          status: "all",
        });
        return { gate: "unlocked", threads };
      } catch (err) {
        if (isFeatureDisabled(err)) return { gate: "disabled" };
        if (isLocked(err)) return { gate: "locked" };
        // Fail soft: a transient network failure must not lock a reviewer
        // out of a tool that is already behind its own gate. Writes will
        // surface the real error.
        if (config.debug) console.warn("[web-review] thread probe failed", err);
        return { gate: "unlocked" };
      }
    },
    [config],
  );

  // Both async paths that fetch a thread list — this one and `reload` below —
  // commit through `commitThreads`, and that is the ONE thing standing
  // between a late response and the wrong page's pins. Not an effect-local
  // `cancelled` flag: `reload` is also called from a poll tick, a focus
  // event, and an inline unlock, none of which are inside an effect that
  // could own such a flag, and a guard that only some callers can reach is
  // not a guard. The `cancelled` flag below is doing a different job — it
  // withholds `setGate`, which is not page-scoped state and so is not
  // something `commitThreads` can speak for.
  useEffect(() => {
    if (!urlKey) return;
    let cancelled = false;
    void (async () => {
      const next = await probe(urlKey);
      if (cancelled) return;
      setGate(next.gate);
      if (next.threads) commitThreads(urlKey, next.threads);
    })();
    return () => {
      cancelled = true;
    };
  }, [urlKey, probe, commitThreads]);

  // ── load + poll threads for the current page ──────────────────────────────
  // `key` is passed in rather than read from the closure so the commit is
  // checked against the page the request was actually FOR. The two differ
  // exactly when it matters: a poll fired on the old page, resolving after a
  // navigation.
  const reload = useCallback(async () => {
    const key = urlKey;
    if (!key) return;
    try {
      const list = await config.adapter.listThreads({
        urlKey: key,
        project: config.project,
        status: "all",
      });
      commitThreads(key, list);
    } catch (err) {
      if (isLocked(err)) {
        setGate("locked");
        return;
      }
      // A failed poll is non-fatal: keep the last list.
    }
  }, [urlKey, config, commitThreads]);

  /**
   * Whether a `refetch` is still out, so the two events one alt-tab fires
   * cost one request rather than two.
   *
   * The timestamp above cannot do this job on its own any more, and that is a
   * direct consequence of moving the stamp to where the data lands: focus and
   * visibilitychange arrive in the SAME task, long before the request either
   * of them starts can come back and stamp anything, so both would sail
   * through a check that only knows about completed fetches. This closes that
   * window from the other end — while one is in flight there is nothing a
   * second one could learn — and it covers the poll interval too, which on a
   * slow connection could otherwise stack requests it will never use.
   */
  const refetchInFlight = useRef(false);

  const refetch = useCallback(() => {
    if (refetchInFlight.current) return;
    refetchInFlight.current = true;
    void reload().finally(() => {
      refetchInFlight.current = false;
    });
  }, [reload]);

  useEffect(() => {
    if (gate !== "unlocked" || !urlKey) return;
    // `<= 0` disables the interval and only the interval — the focus and
    // visibility listeners below stay attached, because that is the case a
    // poll mostly exists to cover. See `ReviewConfig.pollMs`.
    if (config.pollMs <= 0) return;
    const t = window.setInterval(refetch, config.pollMs);
    return () => window.clearInterval(t);
  }, [gate, urlKey, refetch, config]);

  // Coming back to the page is the moment a reviewer most expects to be
  // current: they switched away, someone else commented, they switched back.
  // An interval alone serves that badly — it fires while the tab is hidden
  // (wasting requests on a page nobody is looking at) and then makes them
  // wait out the remainder of a tick once they return.
  useEffect(() => {
    if (gate !== "unlocked" || !urlKey) return;
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefetchAt.current < REFETCH_THROTTLE_MS) return;
      refetch();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [gate, urlKey, refetch]);

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
  // Deliberately does NOT open the panel. Arming picking and reading the
  // feedback already on the page are two different intentions, and binding
  // them together meant neither could be expressed alone: a reviewer who
  // pressed the launcher to look at the thread list got a crosshair cursor
  // and a capture scrim over the page as well. The launcher now opens the
  // panel; this only arms picking. `setSelectedId(null)` stays because the
  // detail view of some older thread is not what a reviewer about to pin
  // something new is looking at.
  const enterPinDropMode = useCallback(() => {
    setPinDropMode(true);
    setSelectedId(null);
    announce("Pin-drop mode on. Select text or click an element to drop a pin. Press Escape to cancel.");
  }, [announce]);

  const exitPinDropMode = useCallback(() => {
    setPinDropMode(false);
    pendingSelection.current = null;
    announce("Pin-drop mode off.");
  }, [announce]);

  /** The explicit arm/disarm the panel's own control and the `c` shortcut share. */
  const togglePinDropMode = useCallback(() => {
    if (pinDropMode) exitPinDropMode();
    else enterPinDropMode();
  }, [pinDropMode, enterPinDropMode, exitPinDropMode]);

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
          // A resolved `null` is a documented, supported outcome — capture
          // succeeded but nothing was stored (no storage configured, or
          // storage failed). Only a real key means "attached"; anything
          // else must say so, never claim success.
          setShotState(key ? "done" : "unavailable");
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
      // The shortcut arms and disarms picking, and does nothing else — in
      // particular it does not open the panel, exactly as the launcher does
      // not arm picking.
      togglePinDropMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gate, pinDropMode, draft, panelOpen, unlockOpen, togglePinDropMode, exitPinDropMode, cancelDraft]);

  /**
   * The pass-through key, held: the pin layer stops catching clicks for
   * exactly as long as the key is down (see {@link PASS_THROUGH_KEY} for
   * which key and why that one).
   *
   * Three things this handler does NOT do, each of them load-bearing.
   *
   * It never calls `preventDefault`. The key is being OBSERVED, not consumed:
   * the host page keeps whatever it does with it, and the reviewer's own
   * browser keeps whatever it does with it. Swallowing a bare key to power an
   * overlay feature is how a review tool breaks the site it is reviewing.
   *
   * It never announces. This is a held modifier rather than an action, and a
   * live-region message per keydown would be a stream, not a message — key
   * repeat alone would see to that. The feedback is visual and continuous
   * instead: the layer goes faint for as long as the key is down (see
   * `overlay.css`'s `[data-passthrough]` rule).
   *
   * And it never lets the state get stranded. `keyup` is not guaranteed to
   * arrive — hold the key, alt-tab away, and the release happens in a window
   * that is no longer listening — which would leave the layer permanently
   * click-through with no visible cause and no way back except a reload.
   * Every event that can mean "this window stopped receiving keys" therefore
   * releases it: `blur`, a tab going hidden, and the effect's own teardown.
   * There is no symmetric risk in releasing too eagerly — the worst case is
   * that a reviewer still holding the key presses it again.
   *
   * Typing is guarded on the way IN only. A reviewer typing an "h" into the
   * composer, or into a form field on the host page, must not have the page
   * silently change behaviour under them. The release path is deliberately
   * unguarded: focus can move while the key is down, and a release must
   * always be honoured no matter where it arrives.
   */
  useEffect(() => {
    if (gate !== "unlocked") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isPassThroughKey(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(document.activeElement)) return;
      setPassThrough(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isPassThroughKey(e)) return;
      setPassThrough(false);
    };
    const release = () => setPassThrough(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
      release();
    };
  }, [gate]);

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
  // the latter is a requirement the reference implementation didn't need: a
  // reviewer must never have a pin dropped under them while typing into a
  // host-page form field.
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

      updateThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
      cancelDraft();
      setSelectedId(thread.id);
      setPanelOpen(true);
      setFilter((f) => (f === "resolved" ? "open" : f));
      announce("Feedback saved.");
    },
    [draft, identity, config, cancelDraft, announce, updateThreads],
  );

  const onSelectThread = useCallback(
    (id: string) => {
      setSelectedId(id);
      setPanelOpen(true);
      void (async () => {
        try {
          const full = await config.adapter.getThread(id);
          updateThreads((prev) => prev.map((t) => (t.id === id ? full : t)));
        } catch {
          // Keep the list-row projection; the detail view degrades to its snippet.
        }
      })();
    },
    [config, updateThreads],
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
      updateThreads((prev) =>
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
    [identity, config, announce, updateThreads],
  );

  const toggleStatus = useCallback(
    async (thread: ReviewThreadView) => {
      const next: ReviewStatus = thread.status === "open" ? "resolved" : "open";
      const who = identity ?? getIdentity(config.storagePrefix);
      const updated = await config.adapter.setStatus(thread.id, next, who?.name ?? null);
      updateThreads((prev) => prev.map((t) => (t.id === thread.id ? updated : t)));
      announce(next === "resolved" ? "Thread resolved." : "Thread reopened.");
    },
    [identity, config, announce, updateThreads],
  );

  // ── render ──────────────────────────────────────────────────────────────

  // The `document` guard is belt-and-braces — this component only ever
  // mounts client-side (see `./review-overlay.tsx`) — but `createPortal`
  // would throw rather than degrade if that ever stopped being true.
  // `gate === "disabled"` means the adapter reported the feature switched
  // off server-side (404 `feature_disabled`): there is nothing to unlock and no
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
              void (async () => {
                const next = await probe(urlKey);
                setGate(next.gate);
                // The unlock re-probe is also the first successful fetch for
                // this page, so it seeds the list rather than leaving the
                // reviewer to wait out a poll for pins the server just
                // started returning.
                if (next.threads) commitThreads(urlKey, next.threads);
              })();
            },
          })}
        <div className="r3wr-interactive" {...TAG}>
          <Launcher
            variant={gate === "checking" ? "checking" : "locked"}
            expanded={unlockOpen}
            onActivate={() => setUnlockOpen((open) => !open)}
            label={
              gate === "checking"
                ? "Checking review access"
                : "Review is locked — enter the review password"
            }
            position={launcherPosition}
            onPositionChange={onLauncherPositionChange}
            tag={TAG}
          />
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

  /**
   * How many of the pins being drawn could not be placed on this page.
   *
   * Counted off the same `resolvedByThread` the pins themselves render from,
   * so the summary and the markers can never disagree — a count derived from
   * a second, independent resolve pass would drift from what is on screen the
   * moment the two ran against different DOM.
   *
   * `unplaceable` ONLY. `drifted` pins are not counted and must not be: they
   * are a different fact (the resolver matched something, weakly) with
   * different copy attached, and folding them together here would undo the
   * separation `anchorPlacement` exists to draw.
   */
  const unplaceableCount = visibleThreads.reduce(
    (n, t) => n + (anchorPlacement(resolvedByThread.get(t.id)).state === "unplaceable" ? 1 : 0),
    0,
  );

  return createPortal(
    <>
      {/* Document-anchored layer: pins + highlights in page coordinates.
          `data-passthrough` is the momentary hold-key state: while it is on,
          the stylesheet stops EVERY descendant of this layer from catching a
          pointer, so a reviewer can click the page through the pins without
          giving up seeing them. */}
      <div className="r3wr-pin-layer" data-passthrough={passThrough} {...TAG}>
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

        {/* Pins off means no pin in the document at all, not a pin made
            invisible: there is nothing left to intercept a click, because
            there is nothing left. (The layer itself is `pointer-events:
            none`, so an empty layer is inert by construction.) */}
        {showPins &&
          visibleThreads.map((t, i) => (
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

        {/* Outside the `showPins` guard on purpose. The draft marker is not
            one of the pins a reviewer chose to hide — it is the live feedback
            for the pin they are dropping RIGHT NOW, and hiding it would leave
            them typing into a composer with no idea what it is attached to. */}
        {draft && (
          <DraftPin
            x={draft.anchor.rect.x + draft.anchor.offsetPct.x * draft.anchor.rect.w}
            y={draft.anchor.rect.y + draft.anchor.offsetPct.y * draft.anchor.rect.h}
          />
        )}
      </div>

      {/* Viewport-fixed chrome. */}
      <div className="r3wr-root" data-panel-open={panelOpen} data-panel-side={panelSide} {...TAG}>
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
            panelOpen,
            panelSide,
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
            panelSide,
            showHighlights,
            onToggleHighlights: toggleShowHighlights,
            showPins,
            onToggleShowPins: toggleShowPins,
            unplaceableCount,
            pinDropMode,
            onTogglePinDrop: togglePinDropMode,
            onClose: () => setPanelOpen(false),
            onSelect: onSelectThread,
            onBack: () => setSelectedId(null),
            onReply: submitReply,
            onToggleStatus: toggleStatus,
            onUnlocked,
          })}

        <div className="r3wr-interactive" {...TAG}>
          <Launcher
            variant="unlocked"
            count={openCount}
            expanded={panelOpen}
            onActivate={() => setPanelOpen((open) => !open)}
            // The name describes what pressing this does — open or close the
            // panel — and nothing else. It used to advertise the `c` shortcut
            // because it also armed pin-drop mode; that job has moved to the
            // panel's own control, and so has the shortcut's advertisement.
            label={launcherLabel(panelOpen, openCount)}
            position={launcherPosition}
            onPositionChange={onLauncherPositionChange}
            // The panel is an obstacle only while it is up, so this is the
            // dock or nothing — `Launcher` reads `undefined` as "no column to
            // avoid" rather than needing a second `panelOpen` prop that could
            // disagree with it. `panelSide` is the same value the panel and
            // the composer are handed, and the same one `data-panel-side`
            // above carries for the stylesheet's half of this fix.
            dock={panelOpen ? { side: panelSide } : undefined}
            tag={TAG}
          />
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * The unlocked launcher's accessible name.
 *
 * Three cases rather than two because the open-thread count is worth saying
 * only when there is something to open and something in it — appending
 * "0 open on this page" to an invitation reads as a discouragement, and once
 * the panel is open the reviewer can see the count for themselves.
 */
function launcherLabel(panelOpen: boolean, openCount: number): string {
  if (panelOpen) return "Close the review panel";
  if (openCount > 0) return `Open the review panel. ${openCount} open on this page`;
  return "Open the review panel";
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
