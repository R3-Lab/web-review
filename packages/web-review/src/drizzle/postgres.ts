/**
 * Drizzle ORM table factories for PostgreSQL, mirroring `sql/postgres.sql`
 * column-for-column, constraint-for-constraint. If you change one, change
 * the other — `schema.test.ts` asserts the column sets stay in sync, but it
 * can only catch drift it's told to look for.
 *
 * Factory functions, not fixed table objects, so a consumer composing this
 * into their own Drizzle schema can choose the table name (and avoid a
 * collision with an existing `review_thread`/`review_comment` table of
 * their own) without forking this file. `reviewCommentPg`'s foreign key
 * needs to point at whichever `review_thread` table the caller actually
 * used, so it takes that table (or accepts the default) as its second
 * argument rather than re-deriving a name.
 *
 * See sql/postgres.sql for the column-by-column rationale (in particular
 * why `author_id`/`author_name` are plain text, not a foreign key, and why
 * `anchor`/`viewport` are opaque jsonb) — it isn't repeated here.
 */

import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { Anchor, AnchorViewport } from "../core/types";

/**
 * `review_thread` table factory. `name` lets a consumer rename the table
 * (e.g. to dodge a collision); everything else matches sql/postgres.sql.
 */
export function reviewThreadPg(name = "review_thread") {
  return pgTable(
    name,
    {
      id: uuid("id").primaryKey().defaultRandom(),
      project: text("project").notNull().default("web"),
      url: text("url").notNull(),
      urlKey: text("url_key").notNull(),
      locale: text("locale"),
      route: text("route"),
      title: text("title"),
      category: text("category").notNull().default("other"),
      // Opaque, client-owned — see sql/postgres.sql design note 2. Typed as
      // `Anchor`/`AnchorViewport` (imported from ../core/types, the single
      // source of truth for that shape) so callers get a typed row without
      // ever having to cast, while server code still has no reason to look
      // inside the value — the type only documents the shape, it doesn't
      // invite introspection.
      anchor: jsonb("anchor").$type<Anchor>().notNull(),
      viewport: jsonb("viewport").$type<AnchorViewport>(),
      status: text("status", { enum: ["open", "resolved"] })
        .notNull()
        .default("open"),
      authorId: text("author_id").notNull(),
      authorName: text("author_name").notNull(),
      screenshotKey: text("screenshot_key"),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      resolvedAt: timestamp("resolved_at", { withTimezone: true }),
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
 * object passed to (or returned by) `reviewThreadPg` that this table's
 * `thread_id` should reference — default wiring assumes the default-named
 * `review_thread` table, matching `reviewThreadPg()`'s own default.
 */
export function reviewCommentPg(
  name = "review_comment",
  threadTable: ReturnType<typeof reviewThreadPg> = reviewThreadPg(),
) {
  return pgTable(
    name,
    {
      id: uuid("id").primaryKey().defaultRandom(),
      threadId: uuid("thread_id").notNull(),
      body: text("body").notNull(),
      authorId: text("author_id").notNull(),
      authorName: text("author_name").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
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

export type ReviewThreadPgRow = ReturnType<typeof reviewThreadPg>["$inferSelect"];
export type NewReviewThreadPgRow = ReturnType<typeof reviewThreadPg>["$inferInsert"];
export type ReviewCommentPgRow = ReturnType<typeof reviewCommentPg>["$inferSelect"];
export type NewReviewCommentPgRow = ReturnType<typeof reviewCommentPg>["$inferInsert"];
