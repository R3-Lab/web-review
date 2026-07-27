/**
 * Wire contract for `@r3lab/web-review` — the shapes every other module in
 * this package (and every consumer's `ReviewAdapter` implementation) build
 * on.
 *
 * Generalized from a working single-app "feedback" tool: the `Feedback*`
 * prefix becomes `Review*`, and a few shapes are loosened so this package
 * isn't stuck with one app's assumptions — see the doc comments on
 * `locale`, `category`, and `ReviewCategoryDef` below for what changed and
 * why.
 *
 * Pure types: no DOM, no React, no imports. Safe on the server and in tests.
 *
 * The consumer's database stores `anchor` and `viewport` as opaque
 * `jsonb`/`json`. Their schema is owned HERE, by the client, so the
 * anchoring strategy can evolve (a new signal, a new confidence heuristic)
 * without a database migration. Server code must round-trip them verbatim
 * and never introspect their contents.
 */

/**
 * A thread's lifecycle state. Kept as a closed union (unlike `category`
 * below) because it's genuinely binary and drives DB indexes and query
 * filters (`status = 'open'`).
 */
export type ReviewStatus = "open" | "resolved";

/**
 * What the reviewer actually selected when they dropped a pin.
 *  - `point`   — a bare click (no highlight).
 *  - `element` — the whole element under the cursor.
 *  - `text`    — a non-collapsed text selection. The important one for copy
 *                review: it records the exact words being questioned.
 */
export type AnchorKind = "point" | "element" | "text";

/**
 * A highlight box expressed as fractions (0..1) of the anchored element's
 * rect, so it rescales when the element resizes or the viewport changes.
 */
export interface HighlightRectPct {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One hop of the captured ancestor chain, used by the fuzzy resolver. */
export interface AncestorStep {
  /** Lowercased tag name. */
  tag: string;
  /** 1-based index among same-tag siblings (`:nth-of-type`). */
  idxOfType: number;
}

/** Document-coordinate rect captured at pin-drop. */
export interface AnchorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Viewport snapshot at pin-drop. Stored as opaque jsonb alongside `anchor`. */
export interface AnchorViewport {
  w: number;
  h: number;
  dpr: number;
  scrollW: number;
  scrollH: number;
}

/**
 * A layered DOM anchor: a primary CSS selector plus enough redundant signal
 * (text, classes, ancestor path, geometry) that the resolver can re-bind the
 * pin after a reload, a re-render, or a copy edit.
 *
 * `textHint` carries the most weight when re-matching, which is deliberate:
 * on a review tool the words are the most stable identifier an element has.
 * It is also what makes a pin survive a class-name refactor.
 *
 * This whole shape is opaque to server code — see the file header. A
 * consumer's route handler stores it as `jsonb` and hands it back verbatim;
 * it never needs to understand a single field here.
 */
export interface Anchor {
  /** Unique CSS path (id / data-testid preferred, else nth-of-type chain). */
  selector: string;
  /** `el.innerText.trim().slice(0, 120)`. */
  textHint: string;
  /** Lowercased tag name. */
  tagName: string;
  role?: string;
  ariaLabel?: string;
  /** Stable subset of the class list (hashed/utility classes filtered out). */
  classes: string[];
  ancestorPath: AncestorStep[];
  rect: AnchorRect;
  /** Where in the element the click landed, as 0..1 fractions. */
  offsetPct: { x: number; y: number };
  viewport: AnchorViewport;
  /** Normalized page key. Locale prefix is NOT stripped — see schema note. */
  urlKey: string;
  href: string;
  /** Absent ⇒ legacy `point`. */
  kind?: AnchorKind;
  /** `element` ⇒ one full box; `text` ⇒ one box per selection rect. */
  highlightRectsPct?: HighlightRectPct[];
  /** The selected words, for `text` anchors. */
  selectedText?: string;
}

/** The browser-minted reviewer identity, persisted in localStorage. */
export interface ReviewerIdentity {
  id: string;
  name: string;
}

/** A comment on a thread. */
export interface ReviewCommentView {
  id: string;
  threadId: string;
  body: string;
  authorId: string;
  authorName: string;
  /** ISO-8601. Comments sort on this, oldest first. */
  createdAt: string;
}

/** A thread as returned by a {@link ReviewAdapter}. */
export interface ReviewThreadView {
  id: string;
  project: string;
  url: string;
  urlKey: string;
  /**
   * Locale of the page the reviewer was reading, or `null` when the
   * consumer's site isn't localized (or has no notion of locale at all).
   *
   * The reference this was generalized from used a closed
   * `"en" | "tr"` union — that's one app's locale set. Every consumer of
   * this package has its own locales, or none, so this is a free-form
   * string instead. `ReviewConfig.localeFromHref` is how a consumer
   * populates it.
   */
  locale: string | null;
  route: string | null;
  title: string | null;
  /**
   * The thread's category id (e.g. `"design"`, `"bug"`). Free-form string
   * rather than a closed union: the reference implementation hard-coded
   * four categories, but categories are configurable per consumer via
   * `ReviewConfig.categories`. See {@link DEFAULT_CATEGORIES} for the
   * built-in set every consumer gets unless they override it.
   */
  category: string;
  anchor: Anchor;
  viewport: AnchorViewport | null;
  status: ReviewStatus;
  authorId: string;
  authorName: string;
  /** Composed public URL, or null when no screenshot was captured. */
  screenshotUrl: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** Oldest-first. Empty on list rows — use `commentCount` there instead. */
  comments: ReviewCommentView[];
  commentCount: number;
}

/** Input for `ReviewAdapter.createThread` — opens a thread with its first comment. */
export interface NewThreadInput {
  project?: string;
  url: string;
  urlKey: string;
  locale: string | null;
  route?: string | null;
  title?: string | null;
  category: string;
  anchor: Anchor;
  viewport?: AnchorViewport | null;
  authorId: string;
  authorName: string;
  /** Opens the thread with its first comment. Required. */
  firstComment: string;
  /** Storage key returned by `ReviewAdapter.uploadScreenshot`, when capture succeeded. */
  screenshotKey?: string | null;
}

/** Input for `ReviewAdapter.addComment` — a reply on an existing thread. */
export interface NewCommentInput {
  body: string;
  authorId: string;
  authorName: string;
}

/** The result of resolving an anchor against the live DOM. */
export interface ResolveResult {
  el?: Element;
  rect?: DOMRect;
  /** 0..1. At or above the threshold ⇒ confident bind. */
  confidence: number;
}

/**
 * One selectable review category. `id` is what gets stored on
 * `ReviewThreadView.category` / `NewThreadInput.category`; `label` is what
 * the overlay displays; `color` is an optional accent for the pin/badge.
 *
 * Deliberately has no icon field, and this package takes no icon-library
 * dependency: the overlay (`../overlay/icons.tsx`) ships inline SVGs keyed
 * off the four {@link DEFAULT_CATEGORIES} ids, falling back to a generic
 * mark for custom ids a consumer defines.
 */
export interface ReviewCategoryDef {
  id: string;
  label: string;
  color?: string;
}

/**
 * The built-in category set. Used unless `ReviewConfig.categories`
 * overrides it — see `resolveConfig` in `./config`.
 */
export const DEFAULT_CATEGORIES: ReviewCategoryDef[] = [
  { id: "design", label: "Design" },
  { id: "copy", label: "Copy" },
  { id: "bug", label: "Bug" },
  { id: "other", label: "Other" },
];
