/**
 * Direct Postgres access for the E2E suite's assertions — deliberately
 * bypassing the app entirely (no `fetch`, no `ReviewStore`, no Drizzle
 * schema import) so a test that checks "did this actually land in the
 * database" is provably independent of whatever the app claims happened.
 * Uses the `pg` driver directly; `pg` is already a dependency of this
 * example (see `drizzle/client.ts`), so no new package is added for this.
 */

import { Client } from "pg";
import { DATABASE_URL } from "./constants";

export interface ReviewThreadRow {
  id: string;
  project: string;
  url: string;
  url_key: string;
  locale: string | null;
  route: string | null;
  title: string | null;
  category: string;
  anchor: Record<string, unknown>;
  viewport: Record<string, unknown> | null;
  status: string;
  author_id: string;
  author_name: string;
  screenshot_key: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
}

export interface ReviewCommentRow {
  id: string;
  thread_id: string;
  body: string;
  author_id: string;
  author_name: string;
  created_at: Date;
}

/** One-shot query against the E2E database. Opens and closes its own connection — these are test assertions, not a connection pool. */
async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows as T[];
  } finally {
    await client.end();
  }
}

/** Threads whose opening (or any) comment body contains `marker` — every spec embeds a unique marker in the comment it types, so tests never see each other's rows even though they share one database. */
export async function findThreadsByCommentMarker(marker: string): Promise<ReviewThreadRow[]> {
  return query<ReviewThreadRow>(
    `select distinct t.*
       from review_thread t
       join review_comment c on c.thread_id = t.id
      where c.body like $1
      order by t.created_at desc`,
    [`%${marker}%`],
  );
}

/**
 * Deletes the threads `findThreadsByCommentMarker` would return, and reports
 * how many went. Comments go with them — `sql/postgres.sql` declares
 * `review_comment.thread_id` `on delete cascade`.
 *
 * For specs whose rows would otherwise interfere with the specs that run
 * AFTER them, which is a narrow case: the suite shares one database and does
 * not reset it, and every other spec's pins are anchored to real elements of
 * the demo page, so they simply re-bind on the next load and sit where they
 * always sat. `pin-passthrough.spec.ts` is the exception — it pins an element
 * it injects itself, which is gone on the next load, leaving a pin that
 * cannot be placed and is therefore drawn at its captured document position
 * on every subsequent test. That position is in the CTA section other specs
 * click in.
 *
 * Scoped by the caller's own unique marker, never by table or by page: this
 * removes the rows one test made and nothing else. It is deliberately not a
 * blanket `afterEach` for the whole suite — the specs that assert persistence
 * are asserting that these rows SURVIVE.
 */
export async function deleteThreadsByCommentMarker(marker: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `delete from review_thread t
      where exists (
        select 1 from review_comment c where c.thread_id = t.id and c.body like $1
      )
      returning t.id`,
    [`%${marker}%`],
  );
  return rows.length;
}

export async function commentsForThread(threadId: string): Promise<ReviewCommentRow[]> {
  return query<ReviewCommentRow>(
    `select * from review_comment where thread_id = $1 order by created_at asc`,
    [threadId],
  );
}

export async function getThread(threadId: string): Promise<ReviewThreadRow | null> {
  const rows = await query<ReviewThreadRow>(`select * from review_thread where id = $1`, [threadId]);
  return rows[0] ?? null;
}
