/**
 * Row → wire mappers for a review-route factory built on this package.
 *
 * `anchor` and `viewport` are opaque JSON (see `../core/types.ts`): they are
 * cast to their declared types and returned verbatim. Nothing here
 * introspects or reshapes them.
 *
 * Generalized from a single-app reference implementation that imported
 * concrete Drizzle row types and composed screenshot URLs from a hardcoded
 * public-bucket-base import:
 *  - Row shapes here are STRUCTURAL interfaces ({@link ReviewThreadRow},
 *    {@link ReviewCommentRow}) describing only the columns these mappers
 *    read. Any ORM's row (Drizzle, Prisma, raw `pg`, …) satisfies them
 *    structurally — no concrete row type from this package is required.
 *  - Screenshot URL composition is an INJECTED function
 *    (`opts.screenshotUrl`), defaulting to `() => null`. Consumers point it
 *    at R2, S3, a CDN, or a signed-URL minter.
 */

import type {
  Anchor,
  AnchorViewport,
  ReviewCommentView,
  ReviewStatus,
  ReviewThreadView,
} from "../core/types";

/** Structural shape of a comment row. Any ORM's row satisfies this. */
export interface ReviewCommentRow {
  id: string;
  threadId: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: Date;
}

/**
 * Structural shape of a thread row. `anchor`/`viewport` are `unknown`
 * because they are opaque, client-owned JSON — see the file header.
 */
export interface ReviewThreadRow {
  id: string;
  project: string;
  url: string;
  urlKey: string;
  locale: string | null;
  route: string | null;
  title: string | null;
  category: string;
  anchor: unknown;
  viewport: unknown;
  status: ReviewStatus;
  authorId: string;
  authorName: string;
  screenshotKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

export function toCommentView(row: ReviewCommentRow): ReviewCommentView {
  return {
    id: row.id,
    threadId: row.threadId,
    body: row.body,
    authorId: row.authorId,
    authorName: row.authorName,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ToThreadViewOptions {
  /** Compose a public URL from a non-null `screenshotKey`. Default: `() => null`. */
  screenshotUrl?: (key: string) => string | null;
  comments?: ReviewCommentRow[];
  commentCount?: number;
}

export function toThreadView(
  row: ReviewThreadRow,
  opts: ToThreadViewOptions = {},
): ReviewThreadView {
  const screenshotUrl = opts.screenshotUrl ?? (() => null);
  const comments = (opts.comments ?? []).map(toCommentView);
  return {
    id: row.id,
    project: row.project,
    url: row.url,
    urlKey: row.urlKey,
    locale: row.locale,
    route: row.route,
    title: row.title,
    category: row.category,
    anchor: row.anchor as Anchor,
    viewport: (row.viewport ?? null) as AnchorViewport | null,
    status: row.status,
    authorId: row.authorId,
    authorName: row.authorName,
    screenshotUrl: row.screenshotKey ? screenshotUrl(row.screenshotKey) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    comments,
    commentCount: opts.commentCount ?? comments.length,
  };
}

/**
 * Fallback thread title, derived from the first comment: whitespace collapsed
 * to a single line, capped at 80 characters. Returns `null` for an empty body
 * so the column stays NULL rather than holding `""`.
 */
export function deriveTitle(firstComment: string): string | null {
  const oneLine = firstComment.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  return oneLine.length > 80 ? `${oneLine.slice(0, 79).trimEnd()}…` : oneLine;
}
