/**
 * Small shared helpers for the overlay shell: document-coordinate math,
 * localStorage-backed UI preferences, DOM classification, and formatting.
 *
 * Ported from a working single-app review tool's `feedback-overlay-inner.tsx`
 * helper section (the file's own `// ── helpers ──` block), generalized to
 * take a `prefix`/`categories` argument instead of hard-coded storage keys
 * and a closed category union — see `config.ts` / `types.ts` for why.
 */

import { createElement } from "react";
import type { ReactElement } from "react";

import type { ResolveResult, ReviewCategoryDef } from "../core/types";
import { CONFIDENCE_THRESHOLD } from "../anchor";

/** A box in absolute DOCUMENT coordinates (px), ready for the pin layer. */
export interface DocRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Keep a document-coordinate point inside the document's existing scroll
 * box, returned as inline `left`/`top` style values.
 *
 * The pin layer is a zero-size absolutely-positioned box, so an
 * absolutely-positioned pin near the right or bottom edge contributes to the
 * document's scrollable overflow — an overlay that promises not to disturb
 * the page must not be the reason a horizontal scrollbar appears. The
 * caller's CSS margins put the marker's TIP (not its bounding-box center)
 * on this point, body above — see `.r3wr-pin`'s CSS comment for the exact
 * geometry — so the real headroom the marker needs is asymmetric: ~0px
 * below the point (the tip sits right on it), ~21px either side, and ~42px
 * above (the rotated body). `PIN` below is a flat compromise, not a true
 * per-edge bound — good enough in practice since a pin rarely sits within
 * a few px of the document's own edge, but a marker anchored deep in that
 * corner can still clip slightly at the top.
 */
export function clampToDocument(
  left: number,
  top: number,
): { left: number; top: number } {
  const doc = document.documentElement;
  const PIN = 16;
  return {
    left: Math.max(PIN, Math.min(left, doc.scrollWidth - PIN)),
    top: Math.max(PIN, Math.min(top, doc.scrollHeight - PIN)),
  };
}

/**
 * Where a thread's pin can honestly be drawn, and what the overlay is
 * entitled to SAY about it.
 *
 * This used to be one boolean (`isDrifted`: `!resolved || confidence <
 * CONFIDENCE_THRESHOLD`), which collapsed two genuinely different facts into
 * one badge. `resolveAnchor` (see `../anchor.ts`) has three outcomes, not
 * two:
 *
 *   - it matched an element at or above {@link CONFIDENCE_THRESHOLD}
 *     ⇒ `anchored`. The pin rides the live rect.
 *   - it found a best candidate but scored it BELOW the threshold
 *     ⇒ `drifted`. Something on this page still resembles what was pinned,
 *     but not enough to trust it, and the usual reason is that the content
 *     moved or changed under the anchor. Saying "the page changed" here is a
 *     claim the resolver actually supports.
 *   - it found nothing to score at all (`el`/`rect` both absent, or the
 *     caller has no resolution for this thread yet)
 *     ⇒ `unplaceable`. All we know is where the pin was dropped. We do NOT
 *     know that the page changed — the element may simply never have been
 *     on this page. Badging that as "drift" tells a reviewer their page
 *     changed when it may not have, and blames content for what can equally
 *     be a data-scoping or navigation mismatch. The copy for this state must
 *     therefore assert nothing beyond "we could not find it here".
 *
 * Returned as a discriminated union rather than two predicates for two
 * reasons: the states are mutually exclusive, so a shape that cannot express
 * "drifted AND unplaceable" is worth more than two booleans a call site has
 * to remember to combine correctly; and `anchored` is the only state that
 * carries a usable live rect, so hanging that rect off the variant removes
 * the `resolved?.rect &&` re-check every call site otherwise repeats (and
 * could get wrong) after asking about drift.
 *
 * NOTE the deliberate removal: `isDrifted` is gone rather than narrowed. It
 * was never part of the package's public surface (`./helpers` is not
 * re-exported from `../index.ts`, `../surfaces.ts`, `../server/index.ts` or
 * `../next/index.ts`), so nothing outside this directory can break — and
 * every in-package call site is forced by the compiler to re-decide which of
 * the two states it meant, instead of silently keeping the old conflation
 * under a name whose meaning quietly changed.
 */
export type AnchorPlacement =
  | { readonly state: "anchored"; readonly rect: DOMRect }
  | { readonly state: "drifted" }
  | { readonly state: "unplaceable" };

/**
 * Classify a thread's live anchor resolution — see {@link AnchorPlacement}
 * for what each state licenses the UI to claim.
 *
 * `undefined` means the caller has no resolution for this thread (it hasn't
 * resolved yet, or the thread isn't in its resolution map), which is
 * `unplaceable` for the same reason a zero-candidate resolve is: we have
 * nothing on THIS page to point at, and no evidence about why.
 *
 * A resolve that scored at/above the threshold but carries no `rect` cannot
 * be drawn against anything, so it degrades to `drifted` rather than
 * `anchored` — the resolver never produces that pair (it sets `el` and
 * `rect` together), but the type permits it, and drawing at the captured
 * rect is the safe reading of "we matched something we can't measure".
 */
export function anchorPlacement(resolved: ResolveResult | undefined): AnchorPlacement {
  if (!resolved || (!resolved.el && !resolved.rect)) return { state: "unplaceable" };
  if (resolved.confidence >= CONFIDENCE_THRESHOLD && resolved.rect) {
    return { state: "anchored", rect: resolved.rect };
  }
  return { state: "drifted" };
}

/**
 * A polite live region for state the overlay changes without moving focus
 * (comment-mode toggles, pin drops, resolves). Written with `createElement`
 * rather than JSX so this stays a plain `.ts` module alongside the rest of
 * the shared helpers.
 */
export function LiveRegion({
  message,
  className,
  tag,
}: {
  message: string;
  /** The `r3wr-sr-only` class name, passed in so this file never hard-codes it. */
  className: string;
  /** Spread onto the element — carries `OVERLAY_ATTR`. */
  tag: Record<string, string>;
}): ReactElement {
  return createElement(
    "p",
    { className, "aria-live": "polite", role: "status", ...tag },
    message,
  );
}

/**
 * The read/write pair every persisted on/off UI preference in this file goes
 * through — one implementation, not one per switch.
 *
 * Each of these preferences wants the identical posture: default ON, `"0"`
 * the only value that means off (so an absent key, a cleared store and a
 * value written by an older build all read as on), and any storage failure —
 * Safari's private mode, a blocked third-party context, a full quota —
 * swallowed rather than allowed to take the overlay down with it.
 *
 * Writing that out per switch is how two switches quietly diverge: the second
 * one gets a `catch` that returns `false`, or starts treating `null` as off,
 * and a reviewer who never touched it loses a layer for no reason they can
 * see. Sharing the body makes "exactly the same posture" structural instead
 * of a claim in a comment.
 *
 * Default-ON on failure specifically, not merely "some default": these keys
 * gate things a reviewer came here to look at. A storage error must never be
 * the reason feedback is invisible.
 */
function readVisibilityFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}

/** Persist an on/off preference. Silently no-ops when storage throws. */
function writeVisibilityFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Storage unavailable; the choice stays in memory for this session.
  }
}

/** The localStorage key holding the persisted "show highlights" choice. */
export function showHighlightsStorageKey(prefix: string): string {
  return `${prefix}.showHighlights`;
}

/** The persisted "Show highlights" choice; on by default. */
export function readShowHighlights(prefix: string): boolean {
  return readVisibilityFlag(showHighlightsStorageKey(prefix));
}

/** Persist the "Show highlights" choice. Silently no-ops when storage throws. */
export function writeShowHighlights(prefix: string, value: boolean): void {
  writeVisibilityFlag(showHighlightsStorageKey(prefix), value);
}

/**
 * The localStorage key holding the persisted "show pins" choice.
 *
 * A SEPARATE key from `showHighlights`, driving a separate switch, because
 * the two layers fail in different ways and a reviewer has to be able to
 * answer one without paying for the other.
 *
 * A highlight is `pointer-events: none` decoration — at worst it obscures
 * something visually. A pin is a real `<button>` laid over the page, and over
 * its own anchor at that: the marker's tip touches the anchored point and its
 * body rises from there, so it covers both the thing it points at and
 * whatever sits just above it. A pin dropped on a nav link takes that link's
 * clicks, and until this switch existed neither the reviewer nor the consumer
 * embedding the overlay had any way to get them back.
 *
 * Hence two keys. Hiding highlights to free a click would be a bargain nobody
 * asked to make, and hiding pins to unblock a page must not also cost the
 * quoted text a reviewer is reading.
 */
export function showPinsStorageKey(prefix: string): string {
  return `${prefix}.showPins`;
}

/** The persisted "Show pins" choice; on by default. */
export function readShowPins(prefix: string): boolean {
  return readVisibilityFlag(showPinsStorageKey(prefix));
}

/** Persist the "Show pins" choice. Silently no-ops when storage throws. */
export function writeShowPins(prefix: string, value: boolean): void {
  writeVisibilityFlag(showPinsStorageKey(prefix), value);
}

/**
 * True when the focused node is a text-entry surface, so neither the "c"
 * shortcut nor a pin-drop click should act on it (inputs, textareas,
 * selects, contenteditable hosts).
 */
export function isEditableTarget(node: Element | null): boolean {
  if (!node) return false;
  const tag = node.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (node as HTMLElement).isContentEditable === true;
}

/**
 * Convert viewport-coord client rects into DOCUMENT-coord boxes (adds
 * scroll), ready to render in the document-anchored pin layer.
 */
export function toDocRects(rects: DOMRectList | DOMRect[]): DocRect[] {
  const out: DocRect[] = [];
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i];
    if (!r) continue;
    out.push({
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      width: r.width,
      height: r.height,
    });
  }
  return out;
}

/** A compact timestamp for comment heads. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Look up a category definition by id, falling back to a synthetic
 * `{ id, label: id }` entry when a thread carries a category id that isn't
 * (or is no longer) in `config.categories` — a thread must always render
 * something rather than throw on a stale/renamed category.
 */
export function resolveCategory(
  categories: ReviewCategoryDef[],
  id: string,
): ReviewCategoryDef {
  return categories.find((c) => c.id === id) ?? { id, label: id };
}

/** The built-in hue for each {@link DEFAULT_CATEGORIES} id — see `icons.tsx`'s glyphs. */
const BUILTIN_CATEGORY_ACCENTS: Record<string, string> = {
  design: "var(--r3wr-cat-design)",
  copy: "var(--r3wr-cat-copy)",
  bug: "var(--r3wr-cat-bug)",
  other: "var(--r3wr-cat-other)",
};

/**
 * The CSS colour value a category renders with: `category.color` when the
 * consumer set one, else the built-in hue for one of the four default ids,
 * else a neutral fallback so a fully custom category (no color, unknown id)
 * still renders consistently rather than transparent/unset.
 */
export function categoryAccent(category: ReviewCategoryDef): string {
  return (
    category.color ?? BUILTIN_CATEGORY_ACCENTS[category.id] ?? "var(--r3wr-cat-other)"
  );
}
