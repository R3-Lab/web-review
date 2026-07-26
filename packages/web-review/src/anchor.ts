/**
 * The DOM anchoring engine.
 *
 * Ported from a working single-app review tool's `feedback/anchor.ts` into
 * this general-purpose package. Pure DOM, framework-agnostic (no React, no
 * next/*, no node builtins) so it runs identically in the browser and in
 * jsdom unit tests.
 *
 *   captureAnchor(x, y)    → Anchor        // layered, redundant anchor at a click
 *   resolveAnchor(anchor)  → ResolveResult // re-bind after reload / re-render / nav
 *   normalizeUrl(href)     → string        // origin/hash-stripped page key
 *   localeFromPathPrefix(href, locales) → string | null
 *
 * Resolve is layered: an exact selector match is the high-confidence primary
 * anchor; otherwise a weighted fuzzy scorer (textHint + class overlap +
 * ancestor-path overlap + scaled rect proximity) picks the best candidate. Below
 * {@link CONFIDENCE_THRESHOLD} the caller renders an "anchor drifted" pin —
 * never silently misplaced, never dropped.
 *
 * TWO deliberate divergences from the reference implementation:
 *  1. The overlay attribute is `data-r3-review` (the reference uses
 *     `data-feedback`) — this package's own name for the attribute that
 *     marks every node its overlay owns.
 *  2. The reference hardcodes locale detection to a closed `"en" | "tr"`
 *     union (`localeFromHref`). This package has no fixed locale set — every
 *     consumer has their own, or none at all — so that function is replaced
 *     with `localeFromPathPrefix(href, locales)`, which a consumer wires
 *     into `ReviewConfig.localeFromHref` with their own locale list.
 *
 * `normalizeUrl` keeps the reference's behaviour exactly, INCLUDING that it
 * does NOT strip locale prefixes — see the doc comment on `normalizeUrl`
 * below for why.
 */

import type {
  Anchor,
  AncestorStep,
  AnchorKind,
  AnchorRect,
  AnchorViewport,
  HighlightRectPct,
  ResolveResult,
} from "./core/types";

/** Attribute marking our own overlay DOM, skipped during capture/scoring. */
export const OVERLAY_ATTR = "data-r3-review";

/** Confidence at/above which a resolve is treated as a confident bind. */
export const CONFIDENCE_THRESHOLD = 0.5;

/** Cap on stored `selectedText` (kept opaque jsonb-friendly, not unbounded). */
const MAX_SELECTED_TEXT = 2000;

/**
 * Fuzzy-scorer weights (sum = 1). textHint dominates — it is the strongest
 * cross-render signal for copy/UI; geometry is the weakest (layout shifts).
 */
const WEIGHTS = {
  textHint: 0.4,
  classes: 0.2,
  ancestorPath: 0.25,
  rect: 0.15,
} as const;

/** A live text selection snapshot: the range plus its trimmed text. */
export interface SelectionSnapshot {
  range: Range;
  text: string;
}

// ───────────────────────────── class filtering ──────────────────────────────

/**
 * Drop hashed CSS-module / utility / state classes that are unstable across
 * builds & renders: hashed module classes (`Button_root__a1b2c`), Tailwind
 * utilities (`px-4`, `md:flex`, `hover:bg-…`), and anything with digits/colons.
 * Keeps human-authored semantic classes (`card`, `nav-item`).
 */
export function isStableClass(cls: string): boolean {
  if (!cls) return false;
  // CSS-module / hashed: trailing __hash or 5+ char base36 token.
  if (/__[A-Za-z0-9]{4,}$/.test(cls)) return false;
  if (/[a-z0-9]{6,}/i.test(cls) && /\d/.test(cls)) return false;
  // Tailwind-ish: contains a colon (variant) or a slash (arbitrary/opacity).
  if (cls.includes(":") || cls.includes("/") || cls.includes("[")) return false;
  // Utility-ish: token with a digit (px-4, gap-2, w-1/2 already excluded above).
  if (/\d/.test(cls)) return false;
  return true;
}

/** A stable, de-duplicated, sorted class subset (deterministic). */
function stableClasses(el: Element): string[] {
  const out = new Set<string>();
  el.classList.forEach((c) => {
    if (isStableClass(c)) out.add(c);
  });
  return [...out].sort();
}

// ───────────────────────────── selector builder ─────────────────────────────

/** True for an element that is part of our own overlay (must be skipped). */
export function isOverlayNode(el: Element | null): boolean {
  return !!el && !!el.closest(`[${OVERLAY_ATTR}]`);
}

/**
 * A CSS-escaped identifier (id / testid value). Falls back to a manual escape
 * when `CSS.escape` is unavailable (older jsdom).
 */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/** `:nth-of-type(n)` index (1-based) among same-tag siblings. */
function nthOfType(el: Element): number {
  let i = 1;
  let sib = el.previousElementSibling;
  const tag = el.tagName;
  while (sib) {
    if (sib.tagName === tag) i += 1;
    sib = sib.previousElementSibling;
  }
  return i;
}

/** A single path segment: tag + nth-of-type (testid/id handled by the caller). */
function segmentFor(el: Element): string {
  const tag = el.tagName.toLowerCase();
  return `${tag}:nth-of-type(${nthOfType(el)})`;
}

/** True when a selector matches exactly one element in `doc`. */
function isUnique(doc: Document, selector: string): boolean {
  try {
    return doc.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/**
 * Build a robust unique CSS selector for `el`:
 *  1. a unique `id` → `#id`;
 *  2. a unique `[data-testid]` → `[data-testid="…"]`;
 *  3. otherwise walk up to the nearest ancestor carrying a unique id/testid and
 *     build `<anchor> > tag:nth-of-type(n) > …` down to `el`. Stops at <body>.
 */
export function buildSelector(el: Element): string {
  const doc = el.ownerDocument;

  const id = el.getAttribute("id");
  if (id && isUnique(doc, `#${cssEscape(id)}`)) return `#${cssEscape(id)}`;

  const testid = el.getAttribute("data-testid");
  if (testid) {
    const sel = `[data-testid="${cssEscape(testid)}"]`;
    if (isUnique(doc, sel)) return sel;
  }

  // Walk up, prefixing each segment, until we either reach a stably-identified
  // ancestor (id/testid) or the document body.
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
    const curId = cur.getAttribute("id");
    if (curId && isUnique(doc, `#${cssEscape(curId)}`)) {
      parts.unshift(`#${cssEscape(curId)}`);
      return parts.join(" > ");
    }
    const curTestid = cur.getAttribute("data-testid");
    if (curTestid && isUnique(doc, `[data-testid="${cssEscape(curTestid)}"]`)) {
      parts.unshift(`[data-testid="${cssEscape(curTestid)}"]`);
      return parts.join(" > ");
    }
    parts.unshift(segmentFor(cur));
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

/**
 * The captured ancestor path from a stable ancestor down to `el` (excl. el).
 *
 * NOTE: the shared `AncestorStep` type (`./core/types`) carries only
 * `{ tag, idxOfType }` — no `testid` — so the path is tag-shape only and
 * `ancestorPathOverlap` compares tags alone. Selector building still prefers
 * `data-testid`; this is purely about the redundant fuzzy signal.
 */
function ancestorPath(el: Element): AncestorStep[] {
  const path: AncestorStep[] = [];
  let cur = el.parentElement;
  let depth = 0;
  while (cur && cur.tagName !== "BODY" && cur.tagName !== "HTML" && depth < 8) {
    path.push({ tag: cur.tagName.toLowerCase(), idxOfType: nthOfType(cur) });
    cur = cur.parentElement;
    depth += 1;
  }
  return path;
}

// ───────────────────────────────── capture ──────────────────────────────────

/**
 * The topmost PAGE element at a viewport point — our own overlay chrome is
 * looked straight through, so a pin can never anchor to the widget.
 *
 * A naive `el.closest(':not([data-r3-review])')` skip does NOT work here:
 * `closest` starts matching at the element itself, and it is the ANCESTOR
 * that carries the overlay attribute, not the hit element — so that skip
 * would silently never fire. `elementsFromPoint` gives the real hit-test
 * stack, which is what is actually needed. Where it is unavailable (jsdom)
 * we return null and the caller degrades to `<body>`.
 */
function pageElementFromPoint(clientX: number, clientY: number): Element | null {
  const top = document.elementFromPoint(clientX, clientY);
  if (!isOverlayNode(top)) return top;
  if (typeof document.elementsFromPoint === "function") {
    for (const candidate of document.elementsFromPoint(clientX, clientY)) {
      if (!isOverlayNode(candidate)) return candidate;
    }
  }
  return null;
}

/** The current viewport snapshot (absolute scroll dims + dpr). */
export function captureViewport(): AnchorViewport {
  const docEl = document.documentElement;
  return {
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    scrollW: docEl.scrollWidth,
    scrollH: docEl.scrollHeight,
  };
}

/**
 * Capture a layered anchor at a viewport point. Walks past our own overlay nodes
 * so a pin never anchors to the widget. Returns `null` only when there is no
 * element at the point (e.g. outside the document).
 *
 * `selectionOverride` lets the caller supply a snapshot taken at *mousedown*.
 * The browser collapses the live selection as part of its default mousedown
 * handling, so by `click` time a pre-existing highlight is already gone — see
 * the overlay's mousedown listener. When omitted, the live selection is read
 * (the reference's behaviour, and what the drag-select-then-release flow
 * needs).
 */
export function captureAnchor(
  clientX: number,
  clientY: number,
  selectionOverride?: SelectionSnapshot | null,
): Anchor | null {
  let el = pageElementFromPoint(clientX, clientY);
  if (!el || el === document.documentElement) el = document.body;
  if (!el) return null;

  // A live (or snapshotted) non-collapsed text selection anchors the pin to the
  // selection's common-ancestor element instead of the bare hit, and remembers
  // the highlighted words + rects (a "highlighter" that survives reload). This
  // is the primary gesture for copy review on a review tool like this one.
  const selection =
    selectionOverride !== undefined ? selectionOverride : getTextSelection();
  let kind: AnchorKind = "element";
  if (selection) {
    const ancestor = selectionAncestorElement(selection.range);
    if (ancestor && !isOverlayNode(ancestor)) {
      el = ancestor;
      kind = "text";
    }
  }

  const rectDom = el.getBoundingClientRect();
  const rect: AnchorRect = {
    x: rectDom.left + window.scrollX,
    y: rectDom.top + window.scrollY,
    w: rectDom.width,
    h: rectDom.height,
  };

  const offsetPct = {
    x: rectDom.width > 0 ? clamp01((clientX - rectDom.left) / rectDom.width) : 0.5,
    y: rectDom.height > 0 ? clamp01((clientY - rectDom.top) / rectDom.height) : 0.5,
  };

  // Highlight boxes relative to the anchored element's rect. Text selections get
  // one box per client-rect; everything else gets the full element box.
  const highlightRectsPct: HighlightRectPct[] =
    kind === "text" && selection
      ? rectsToPct(selection.range.getClientRects(), rectDom)
      : [{ x: 0, y: 0, w: 1, h: 1 }];
  // A text selection whose rects all collapsed (no layout, e.g. jsdom) degrades
  // gracefully to a full-element box so there is always something to draw.
  if (kind === "text" && highlightRectsPct.length === 0) {
    highlightRectsPct.push({ x: 0, y: 0, w: 1, h: 1 });
  }
  const selectedText =
    kind === "text" && selection
      ? selection.text.slice(0, MAX_SELECTED_TEXT)
      : undefined;

  const role = el.getAttribute("role") ?? undefined;
  const ariaLabel = el.getAttribute("aria-label") ?? undefined;
  const textHint = ("innerText" in el
    ? (el as HTMLElement).innerText
    : (el.textContent ?? "")
  )
    .trim()
    .slice(0, 120);

  return {
    selector: buildSelector(el),
    textHint,
    tagName: el.tagName.toLowerCase(),
    role,
    ariaLabel,
    classes: stableClasses(el),
    ancestorPath: ancestorPath(el),
    rect,
    offsetPct,
    viewport: captureViewport(),
    urlKey: normalizeUrl(window.location.href),
    href: window.location.href,
    kind,
    highlightRectsPct,
    selectedText,
  };
}

// ───────────────────────────── selection capture ────────────────────────────

/** A live, non-collapsed text selection (its range + trimmed text), or null. */
export function getTextSelection(): SelectionSnapshot | null {
  const sel =
    typeof window.getSelection === "function" ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  return { range: sel.getRangeAt(0), text };
}

/**
 * The nearest Element that wholly contains a selection range (its common
 * ancestor; the parent element when that ancestor is a text node).
 */
function selectionAncestorElement(range: Range): Element | null {
  const node = range.commonAncestorContainer;
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  return node.parentElement;
}

/**
 * Whether a viewport point lands inside (or within `pad` px of) any of a
 * selection's client rects. Guards the mousedown snapshot: a reviewer who
 * highlights a sentence and then clicks somewhere else entirely wants an
 * element pin there, not the stale highlight.
 */
export function pointInSelection(
  selection: SelectionSnapshot,
  clientX: number,
  clientY: number,
  pad = 6,
): boolean {
  const rects = selection.range.getClientRects();
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i];
    if (!r) continue;
    if (
      clientX >= r.left - pad &&
      clientX <= r.right + pad &&
      clientY >= r.top - pad &&
      clientY <= r.bottom + pad
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Convert client-rects (viewport coords) to percentages of an element's rect.
 * Zero-size element rects (e.g. jsdom, which has no layout) yield no boxes
 * rather than dividing by zero.
 */
function rectsToPct(rects: DOMRectList, base: DOMRect): HighlightRectPct[] {
  if (base.width <= 0 || base.height <= 0) return [];
  const out: HighlightRectPct[] = [];
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i];
    if (!r || r.width <= 0 || r.height <= 0) continue;
    out.push({
      x: clamp01((r.left - base.left) / base.width),
      y: clamp01((r.top - base.top) / base.height),
      w: clamp01(r.width / base.width),
      h: clamp01(r.height / base.height),
    });
  }
  return out;
}

// ───────────────────────────────── resolve ──────────────────────────────────

/**
 * Resolve a captured anchor against the live DOM.
 *  1. Exact selector → unique match ⇒ confidence 1 (primary anchor).
 *  2. Else fuzzy scorer over same-tag candidates ⇒ best score.
 *  3. Best ≥ {@link CONFIDENCE_THRESHOLD} ⇒ confident bind, else degrade
 *     (caller renders at absolute `rect`, badged "drifted").
 */
export function resolveAnchor(a: Anchor): ResolveResult {
  // 1) Exact selector, unique match.
  try {
    const matches = document.querySelectorAll(a.selector);
    const exact = matches.length === 1 ? matches[0] : undefined;
    if (exact && !isOverlayNode(exact)) {
      return { el: exact, rect: exact.getBoundingClientRect(), confidence: 1 };
    }
  } catch {
    // Malformed selector after a markup change — fall through to fuzzy.
  }

  // 2) Fuzzy scorer over same-tag candidates.
  const candidates = Array.from(document.getElementsByTagName(a.tagName)).filter(
    (el) => !isOverlayNode(el),
  );
  let best: Element | undefined;
  let bestScore = 0;
  for (const el of candidates) {
    const score = scoreCandidate(a, el);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (best && bestScore >= CONFIDENCE_THRESHOLD) {
    return { el: best, rect: best.getBoundingClientRect(), confidence: bestScore };
  }
  // 3) Degrade: no confident hit. Return the best (if any) but low confidence so
  //    the caller draws the "drifted" badge at the absolute captured rect.
  return { el: best, rect: best?.getBoundingClientRect(), confidence: bestScore };
}

/** Weighted similarity of a candidate to the captured anchor (0..1). */
export function scoreCandidate(a: Anchor, el: Element): number {
  const text = ("innerText" in el
    ? (el as HTMLElement).innerText
    : (el.textContent ?? "")
  )
    .trim()
    .slice(0, 120);
  const textSim = similarity(a.textHint, text);
  const classSim = jaccard(a.classes, stableClasses(el));
  const pathSim = ancestorPathOverlap(a.ancestorPath, ancestorPath(el));
  const rectSim = rectProximity(a, el);

  return (
    WEIGHTS.textHint * textSim +
    WEIGHTS.classes * classSim +
    WEIGHTS.ancestorPath * pathSim +
    WEIGHTS.rect * rectSim
  );
}

// ─────────────────────────────── scoring parts ──────────────────────────────

/**
 * Token-set similarity for short strings (Jaccard over whitespace tokens),
 * with an exact-match short-circuit. Empty/empty ⇒ 0 (no signal).
 */
function similarity(a: string, b: string): number {
  if (!a && !b) return 0;
  if (a === b) return 1;
  return jaccard(tokenize(a), tokenize(b));
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Jaccard index of two string sets (0..1). Empty/empty ⇒ 0. */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Positional overlap of two ancestor paths: fraction of leading hops whose tag
 * matches.
 */
function ancestorPathOverlap(a: AncestorStep[], b: AncestorStep[]): number {
  const n = Math.max(a.length, b.length);
  if (n === 0) return 0;
  let match = 0;
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i += 1) {
    if (a[i]?.tag !== b[i]?.tag) break;
    match += 1;
  }
  return match / n;
}

/**
 * Scaled rect proximity: 1 when the candidate's document-coord top-left and
 * size match the captured rect, decaying with distance + size mismatch. Scales
 * by the captured viewport so it survives different window sizes.
 */
function rectProximity(a: Anchor, el: Element): number {
  const r = el.getBoundingClientRect();
  const x = r.left + window.scrollX;
  const y = r.top + window.scrollY;
  const vw = a.viewport.w || window.innerWidth || 1;
  const vh = a.viewport.h || window.innerHeight || 1;
  const dx = Math.abs(x - a.rect.x) / vw;
  const dy = Math.abs(y - a.rect.y) / vh;
  const dw = a.rect.w > 0 ? Math.abs(r.width - a.rect.w) / a.rect.w : 0;
  const dh = a.rect.h > 0 ? Math.abs(r.height - a.rect.h) / a.rect.h : 0;
  const dist = dx + dy + dw * 0.5 + dh * 0.5;
  return Math.max(0, 1 - dist);
}

// ────────────────────────────────── url ─────────────────────────────────────

/**
 * Normalize an href into a stable page key: strip the origin and hash, keep
 * the path — INCLUDING any locale prefix — plus a deterministic, sorted set
 * of significant query params (tracking/ephemeral params dropped).
 *
 * Keeping the prefix is deliberate: `/about` and `/tr/hakkimizda` (or
 * whatever segments a consumer's locales use) are different pages with
 * independently-written copy, and a pin left on one locale's wording must
 * never surface on another locale's page. This package has no notion of
 * what a consumer's locale segments are — see `localeFromPathPrefix` below,
 * which takes the locale list as a parameter rather than this module
 * hard-coding one — so `normalizeUrl` has no way to special-case them even
 * if it wanted to, and stripping blindly would risk merging pages that
 * happen to share a first path segment that isn't a locale at all.
 */
export function normalizeUrl(href: string): string {
  let url: URL;
  try {
    url = new URL(href, "http://x");
  } catch {
    return href;
  }
  const segs = url.pathname.split("/").filter(Boolean);
  const path = "/" + segs.join("/");

  const keep: [string, string][] = [];
  url.searchParams.forEach((v, k) => {
    if (isSignificantParam(k)) keep.push([k, v]);
  });
  keep.sort(([a], [b]) => a.localeCompare(b));
  const query = keep.length
    ? "?" + keep.map(([k, v]) => `${k}=${v}`).join("&")
    : "";

  return (path === "/" ? "/" : path.replace(/\/$/, "")) + query;
}

/**
 * Which locale (if any) the reviewer was reading, derived from the href's
 * first path segment. Returns that segment verbatim when it matches one of
 * `locales` exactly, else `null` — so `/traditional-baklava` is never
 * mistaken for a `/tr` locale prefix just because it starts with the same
 * two letters.
 *
 * The general-purpose replacement for the reference's `localeFromHref`,
 * which hard-coded a closed `"en" | "tr"` union. A consumer wires this into
 * `ReviewConfig.localeFromHref` with their own locale list, e.g.:
 *
 *   localeFromHref: (href) => localeFromPathPrefix(href, ["en", "tr"])
 */
export function localeFromPathPrefix(
  href: string,
  locales: readonly string[],
): string | null {
  let pathname: string;
  try {
    pathname = new URL(href, "http://x").pathname;
  } catch {
    pathname = href;
  }
  const first = pathname.split("/").filter(Boolean)[0];
  return first && locales.includes(first) ? first : null;
}

/**
 * Drop tracking / ephemeral params from the page key (utm_*, fbclid, session
 * tokens, …); keep functional ones (tab, page, id, …).
 */
function isSignificantParam(key: string): boolean {
  const k = key.toLowerCase();
  if (k.startsWith("utm_")) return false;
  const drop = new Set([
    "fbclid",
    "gclid",
    "gbraid",
    "wbraid",
    "msclkid",
    "ref",
    "ref_src",
    "session",
    "token",
    "_ga",
  ]);
  return !drop.has(k);
}

// ───────────────────────────────── helpers ──────────────────────────────────

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
