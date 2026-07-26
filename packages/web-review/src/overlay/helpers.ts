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
 * caller's CSS margins pull the marker up and left of this point, so half a
 * pin's width of headroom is enough.
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

/** True when the resolver could not re-bind the anchor with confidence. */
export function isDrifted(resolved: ResolveResult | undefined): boolean {
  return !resolved || resolved.confidence < CONFIDENCE_THRESHOLD;
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

/** The localStorage key holding the persisted "show highlights" choice. */
export function showHighlightsStorageKey(prefix: string): string {
  return `${prefix}.showHighlights`;
}

/** The persisted "Show highlights" choice; on by default. */
export function readShowHighlights(prefix: string): boolean {
  try {
    return window.localStorage.getItem(showHighlightsStorageKey(prefix)) !== "0";
  } catch {
    return true;
  }
}

/** Persist the "Show highlights" choice. Silently no-ops when storage throws. */
export function writeShowHighlights(prefix: string, value: boolean): void {
  try {
    window.localStorage.setItem(showHighlightsStorageKey(prefix), value ? "1" : "0");
  } catch {
    // Storage unavailable; the choice stays in memory for this session.
  }
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
