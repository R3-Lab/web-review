/**
 * Drizzle ORM table factories for MySQL, mirroring `sql/mysql.sql`
 * column-for-column, constraint-for-constraint — including its column-size
 * and default-value choices, which are NOT arbitrary; see that file's
 * comments (id type, index key length, `CURRENT_TIMESTAMP(3)` vs Drizzle's
 * own `.defaultNow()`) before changing anything here. `schema.test.ts`
 * asserts the column sets stay in sync with the SQL file, but it can only
 * catch drift it's told to look for.
 *
 * Factory functions, not fixed table objects — see postgres.ts for why.
 */

import {
  char,
  check,
  datetime,
  foreignKey,
  index,
  json,
  mysqlTable,
  text,
  varchar,
} from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import type { Anchor, AnchorViewport } from "../core/types";

/**
 * `review_thread` table factory. `name` lets a consumer rename the table;
 * everything else matches sql/mysql.sql.
 */
export function reviewThreadMysql(name = "review_thread") {
  return mysqlTable(
    name,
    {
      // CHAR(36), not VARCHAR — matches sql/mysql.sql's fixed-length id
      // column exactly. `(uuid())` is a parenthesized expression default
      // (MySQL 8.0.13+), not Drizzle's `.default(...)` sugar — see
      // sql/mysql.sql for why CHAR(36) + UUID() over BINARY(16), verified
      // against a live MySQL 8 container.
      id: char("id", { length: 36 }).primaryKey().default(sql`(uuid())`),
      // Bounded — see sql/mysql.sql's `project`/`url_key` note: this column
      // takes part in `review_thread_page_idx`, and MySQL's composite index
      // byte budget forces every participating column to be bounded.
      project: varchar("project", { length: 64 }).notNull().default("web"),
      url: text("url").notNull(),
      // Bounded to 512 chars — see sql/mysql.sql for the full byte-budget
      // accounting behind this exact number.
      urlKey: varchar("url_key", { length: 512 }).notNull(),
      locale: text("locale"),
      route: text("route"),
      title: text("title"),
      // Bounded because it carries a literal DEFAULT — MySQL disallows
      // literal defaults on TEXT before 8.0.13. See sql/mysql.sql.
      category: varchar("category", { length: 64 }).notNull().default("other"),
      // Opaque, client-owned — see sql/mysql.sql design note 2 and the
      // `json` vs `jsonb` divergence note. Typed the same way as the
      // Postgres factory so consumers get one typed shape regardless of
      // engine.
      anchor: json("anchor").$type<Anchor>().notNull(),
      viewport: json("viewport").$type<AnchorViewport>(),
      // Bounded + part of the composite index, same reasoning as
      // `url_key`. Still CHECK-constrained below: genuinely binary.
      status: varchar("status", { length: 20, enum: ["open", "resolved"] })
        .notNull()
        .default("open"),
      authorId: text("author_id").notNull(),
      authorName: text("author_name").notNull(),
      screenshotKey: text("screenshot_key"),
      // `CURRENT_TIMESTAMP(3)`, spelled out explicitly rather than via
      // Drizzle's `.defaultNow()`: that helper emits `(now())` with no
      // fsp argument, which MySQL evaluates at whole-second precision
      // regardless of the column's `datetime(3)` precision — a silent
      // mismatch with the millisecond precision this schema promises (see
      // sql/mysql.sql's `datetime` note). `CURRENT_TIMESTAMP(3)` is also
      // the exact text sql/mysql.sql uses, which is what
      // `schema.test.ts`'s drift check compares against.
      createdAt: datetime("created_at", { fsp: 3 })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP(3)`),
      updatedAt: datetime("updated_at", { fsp: 3 })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP(3)`),
      resolvedAt: datetime("resolved_at", { fsp: 3 }),
      resolvedBy: text("resolved_by"),
    },
    (t) => [
      index("review_thread_page_idx").on(t.project, t.urlKey, t.status),
      index("review_thread_created_at_idx").on(t.createdAt),
      check(
        "review_thread_status_check",
        sql`${t.status} in ('open', 'resolved')`,
      ),
    ],
  );
}

/**
 * `review_comment` table factory. `threadTable` must be the same table
 * object passed to (or returned by) `reviewThreadMysql` that this table's
 * `thread_id` should reference — default wiring assumes the default-named
 * `review_thread` table, matching `reviewThreadMysql()`'s own default.
 */
export function reviewCommentMysql(
  name = "review_comment",
  threadTable: ReturnType<typeof reviewThreadMysql> = reviewThreadMysql(),
) {
  return mysqlTable(
    name,
    {
      id: char("id", { length: 36 }).primaryKey().default(sql`(uuid())`),
      // Must match `review_thread.id`'s type exactly — MySQL requires that
      // for a foreign key to be creatable at all. See sql/mysql.sql.
      threadId: char("thread_id", { length: 36 }).notNull(),
      body: text("body").notNull(),
      authorId: text("author_id").notNull(),
      authorName: text("author_name").notNull(),
      createdAt: datetime("created_at", { fsp: 3 })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP(3)`),
    },
    (t) => [
      foreignKey({
        name: "review_comment_thread_id_fkey",
        columns: [t.threadId],
        foreignColumns: [threadTable.id],
      }).onDelete("cascade"),
      index("review_comment_thread_idx").on(t.threadId, t.createdAt),
    ],
  );
}

export type ReviewThreadMysqlRow = ReturnType<
  typeof reviewThreadMysql
>["$inferSelect"];
export type NewReviewThreadMysqlRow = ReturnType<
  typeof reviewThreadMysql
>["$inferInsert"];
export type ReviewCommentMysqlRow = ReturnType<
  typeof reviewCommentMysql
>["$inferSelect"];
export type NewReviewCommentMysqlRow = ReturnType<
  typeof reviewCommentMysql
>["$inferInsert"];
