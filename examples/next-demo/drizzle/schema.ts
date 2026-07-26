/**
 * Drizzle schema for the demo, built entirely from
 * `@r3lab/web-review/drizzle`'s table factories — this file does NOT
 * hand-write columns. The actual migration is the package's own
 * `sql/postgres.sql` (applied via `pnpm db:apply`); this schema exists only
 * so `lib/review-store.ts` gets typed query builders over the same tables.
 */

import { reviewCommentPg, reviewThreadPg } from "@r3lab/web-review/drizzle";

export const reviewThread = reviewThreadPg();
export const reviewComment = reviewCommentPg("review_comment", reviewThread);
