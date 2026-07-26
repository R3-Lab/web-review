/**
 * `ReviewStore` implementation over Drizzle + Postgres — the storage
 * contract documented in `@r3lab/web-review/next`'s `routes.ts`. This is the
 * only place in the demo that knows about SQL; the route handlers
 * (`app/api/review/**`) never touch the database directly.
 *
 * `screenshotKey`/`putScreenshot`/`screenshotUrl` are intentionally NOT
 * implemented: the package documents both as optional, with the route
 * factory answering a clean 404 on `POST /screenshot` and `screenshotUrl`
 * always `null` when omitted — exactly the "no object storage configured"
 * case this demo is in. A real deployment would implement `putScreenshot`
 * against R2/S3/etc.
 */

import { and, count, desc, eq } from "drizzle-orm";
import type {
  Anchor,
  AnchorViewport,
  NewCommentInput,
  ReviewStatus,
} from "@r3lab/web-review";
import type {
  ReviewStore,
  ReviewStoreCreateThreadInput,
  ReviewStoreListThreadsParams,
} from "@r3lab/web-review/next";
import type { ReviewCommentRow, ReviewThreadRow } from "@r3lab/web-review/server";
import { db } from "../drizzle/client";
import { reviewComment, reviewThread } from "../drizzle/schema";

export const store: ReviewStore = {
  async listThreads(params: ReviewStoreListThreadsParams) {
    const conditions = [eq(reviewThread.project, params.project)];
    if (params.urlKey) conditions.push(eq(reviewThread.urlKey, params.urlKey));
    if (params.status !== "all") conditions.push(eq(reviewThread.status, params.status));

    // Comment counts come from a grouped LEFT JOIN + count(*), never from
    // loading every comment row — see the ReviewStore.listThreads doc
    // comment in routes.ts.
    const rows = await db
      .select({ thread: reviewThread, commentCount: count(reviewComment.id) })
      .from(reviewThread)
      .leftJoin(reviewComment, eq(reviewComment.threadId, reviewThread.id))
      .where(and(...conditions))
      .groupBy(reviewThread.id)
      .orderBy(desc(reviewThread.createdAt))
      .limit(params.limit);

    return rows.map((row) => ({
      thread: row.thread satisfies ReviewThreadRow,
      commentCount: Number(row.commentCount),
    }));
  },

  async getThread(id: string) {
    const [thread] = await db.select().from(reviewThread).where(eq(reviewThread.id, id)).limit(1);
    if (!thread) return null;

    const comments = await db
      .select()
      .from(reviewComment)
      .where(eq(reviewComment.threadId, id))
      .orderBy(reviewComment.createdAt);

    return { thread, comments };
  },

  async createThread(input: ReviewStoreCreateThreadInput) {
    // Interactive transaction: both inserts commit together or neither
    // does, per the ReviewStore.createThread contract — node-postgres's
    // Pool supports a real BEGIN/COMMIT session, unlike an HTTP-only driver.
    return db.transaction(async (tx) => {
      const [thread] = await tx
        .insert(reviewThread)
        .values({
          project: input.project,
          url: input.url,
          urlKey: input.urlKey,
          locale: input.locale,
          route: input.route,
          title: input.title,
          category: input.category,
          // anchor/viewport are opaque client-owned JSON (see core/types.ts) —
          // cast, never introspected, and stored verbatim.
          anchor: input.anchor as Anchor,
          viewport: input.viewport as AnchorViewport | null,
          authorId: input.authorId,
          authorName: input.authorName,
          screenshotKey: input.screenshotKey,
        })
        .returning();
      if (!thread) throw new Error("review_thread insert returned no row");

      const [comment] = await tx
        .insert(reviewComment)
        .values({
          threadId: thread.id,
          body: input.firstComment,
          authorId: input.authorId,
          authorName: input.authorName,
        })
        .returning();
      if (!comment) throw new Error("review_comment insert returned no row");

      return { thread, comment };
    });
  },

  async addComment(threadId: string, input: NewCommentInput): Promise<ReviewCommentRow | null> {
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: reviewThread.id })
        .from(reviewThread)
        .where(eq(reviewThread.id, threadId))
        .limit(1);
      if (!existing) return null;

      const [comment] = await tx
        .insert(reviewComment)
        .values({
          threadId,
          body: input.body,
          authorId: input.authorId,
          authorName: input.authorName,
        })
        .returning();
      if (!comment) throw new Error("review_comment insert returned no row");

      // Bump the parent thread's updatedAt so a "last activity" sort stays
      // meaningful — see the ReviewStore.addComment doc comment.
      await tx.update(reviewThread).set({ updatedAt: new Date() }).where(eq(reviewThread.id, threadId));

      return comment;
    });
  },

  async setStatus(threadId: string, status: ReviewStatus, resolvedBy: string | null) {
    const now = new Date();
    const [thread] = await db
      .update(reviewThread)
      .set(
        status === "resolved"
          ? { status, resolvedAt: now, resolvedBy, updatedAt: now }
          // Reopening clears resolution metadata regardless of what
          // resolvedBy was passed — see the ReviewStore.setStatus doc
          // comment in routes.ts.
          : { status, resolvedAt: null, resolvedBy: null, updatedAt: now },
      )
      .where(eq(reviewThread.id, threadId))
      .returning();
    if (!thread) return null;

    const comments = await db
      .select()
      .from(reviewComment)
      .where(eq(reviewComment.threadId, threadId))
      .orderBy(reviewComment.createdAt);

    return { thread, comments };
  },
};
