// Drizzle ORM entry point: table factories for the review overlay schema
// (threads, comments) so consumers can compose them into their own Drizzle
// schema, for both PostgreSQL and MySQL. See ../../sql/postgres.sql and
// ../../sql/mysql.sql for the hand-written DDL these mirror, and
// ./schema.test.ts for the drift check that keeps them in sync.
//
// `drizzle-orm` is an OPTIONAL peer dependency (see package.json) — a
// consumer who never imports `@r3lab/web-review/drizzle` should never need
// it installed. That guarantee doesn't come from anything in this file; it
// comes from tsup.config.ts building this module as its own bundle entry
// ("drizzle/index"), separate from the package's main ("."), "./next", and
// "./server" entries, with splitting disabled and `drizzle-orm` marked
// `external`. None of those other entries import from this directory (grep
// confirms it), so `drizzle-orm`'s `import "drizzle-orm/pg-core"` below is
// only ever reached by code that explicitly imports
// `@r3lab/web-review/drizzle` in the first place — importing the package's
// main entry never pulls this file, or `drizzle-orm`, in at all.

export { reviewThreadPg, reviewCommentPg } from "./postgres";
export type {
  ReviewThreadPgRow,
  NewReviewThreadPgRow,
  ReviewCommentPgRow,
  NewReviewCommentPgRow,
} from "./postgres";

export { reviewThreadMysql, reviewCommentMysql } from "./mysql";
export type {
  ReviewThreadMysqlRow,
  NewReviewThreadMysqlRow,
  ReviewCommentMysqlRow,
  NewReviewCommentMysqlRow,
} from "./mysql";

export const VERSION = "0.1.0";
