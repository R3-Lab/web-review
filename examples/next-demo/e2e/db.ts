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
