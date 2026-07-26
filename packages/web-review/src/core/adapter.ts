/**
 * The transport boundary between the overlay and a consumer's storage.
 *
 * This package ships no server and no database: every method on
 * {@link ReviewAdapter} is implemented by the consumer, backed by whatever
 * they use (a Next.js route handler over Postgres, a serverless function
 * over SQLite, an in-memory store for a demo). The overlay only ever calls
 * through this interface — it never knows the transport, and this package
 * never assumes one.
 *
 * Generalized from a working single-app fetch client (`api.ts`): that
 * client hard-coded same-origin routes and a cookie-based session. Here the
 * method set becomes an interface an implementer fills in however they see
 * fit — an implementer reading only this file should be able to write a
 * correct adapter without looking at the overlay's source.
 */

import type {
  NewCommentInput,
  NewThreadInput,
  ReviewCommentView,
  ReviewStatus,
  ReviewThreadView,
} from "./types";

/** Filter params for {@link ReviewAdapter.listThreads}. */
export interface ListThreadsParams {
  /** Restrict to one page's threads. Omit to list across all pages. */
  urlKey?: string;
  /** Restrict to one project namespace. Omit to use the adapter's default. */
  project?: string;
  /**
   * Restrict by lifecycle state. `"all"` returns every thread regardless of
   * status — consumers commonly default their list UI to this so a
   * newly-created thread is never hidden by an implicit "open" filter.
   */
  status?: ReviewStatus | "all";
  /** Cap the number of rows returned. The adapter decides the default and the max. */
  limit?: number;
}

/**
 * Everything a consumer implements to back the review overlay with their
 * own storage. The overlay depends only on this interface.
 */
export interface ReviewAdapter {
  /**
   * List threads matching `params`, newest first.
   *
   * Each returned row's `comments` array must be empty — list rows carry
   * `commentCount` instead; callers fetch the full thread via `getThread`
   * to read its comments. May throw {@link ReviewApiError} (status 401 if
   * the caller is locked out — see `unlock` — or any other status for a
   * transport failure).
   */
  listThreads(params: ListThreadsParams): Promise<ReviewThreadView[]>;

  /**
   * Fetch one thread WITH its comments, oldest first.
   *
   * Must throw {@link ReviewApiError} with status 404 when `id` does not
   * exist.
   */
  getThread(id: string): Promise<ReviewThreadView>;

  /**
   * Create a thread, opened with its first comment (`input.firstComment`).
   *
   * Must return the created thread with `comments` containing exactly that
   * one comment and `commentCount: 1`.
   */
  createThread(input: NewThreadInput): Promise<ReviewThreadView>;

  /**
   * Reply on an existing thread. Returns the created comment — NOT the
   * whole thread, since the overlay appends it to a list it already holds.
   *
   * Must throw {@link ReviewApiError} with status 404 when `threadId` does
   * not exist.
   */
  addComment(
    threadId: string,
    input: NewCommentInput,
  ): Promise<ReviewCommentView>;

  /**
   * Resolve or reopen a thread. `resolvedBy` records who resolved it and is
   * only meaningful when `status` is `"resolved"`; setting `status` back to
   * `"open"` must clear `resolvedAt`/`resolvedBy` on the returned thread
   * regardless of what was passed for `resolvedBy`.
   *
   * Must throw {@link ReviewApiError} with status 404 when `threadId` does
   * not exist.
   */
  setStatus(
    threadId: string,
    status: ReviewStatus,
    resolvedBy?: string | null,
  ): Promise<ReviewThreadView>;

  /**
   * Upload a screenshot captured at pin-drop and return an opaque storage
   * key to attach to `NewThreadInput.screenshotKey`. Returning `null` means
   * "capture succeeded but storage failed" — the overlay proceeds with
   * thread creation minus the screenshot rather than blocking on it.
   *
   * Optional. Omit entirely to disable screenshot capture: the overlay
   * checks for this method's presence and never attempts a capture when
   * it's absent, regardless of `ReviewConfig.screenshots`.
   */
  uploadScreenshot?(blob: Blob): Promise<string | null>;

  /**
   * Exchange a shared password for whatever session the adapter's other
   * methods expect (e.g. setting an httpOnly cookie as a side effect of a
   * route handler). Must throw {@link ReviewApiError} with status 401 on an
   * incorrect password, and may throw with status 429 (optionally carrying
   * `retryAfterSec`) when rate-limited.
   *
   * Optional. Omit when the consumer gates access some other way (e.g. the
   * preview deployment itself sits behind auth) — the overlay then never
   * shows an unlock prompt and never calls this method.
   */
  unlock?(password: string): Promise<void>;
}

/**
 * A failed call to a {@link ReviewAdapter} method. Adapters SHOULD throw
 * this (rather than a bare `Error`) so the overlay can tell a locked
 * session apart from a disabled feature apart from a plain failure — see
 * `isLocked`, `isFeatureDisabled`, and `unlockErrorMessage` below.
 */
export class ReviewApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /** Present on a 429 from `unlock`. */
  readonly retryAfterSec?: number;

  constructor(
    status: number,
    message: string,
    code?: string,
    retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ReviewApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * True when a failure means "prompt for the shared password" — a 401 from
 * any {@link ReviewAdapter} method.
 */
export function isLocked(err: unknown): boolean {
  return err instanceof ReviewApiError && err.status === 401;
}

/**
 * True when the adapter says the review feature is switched off
 * server-side (404 with code `not_found`) — there is nothing to unlock, so
 * the overlay should render nothing at all rather than offer a prompt that
 * can never succeed.
 *
 * Both conditions matter: a plain 404 (e.g. an unknown thread id) is NOT a
 * disabled feature, only a 404 carrying this specific code is.
 */
export function isFeatureDisabled(err: unknown): boolean {
  return (
    err instanceof ReviewApiError &&
    err.status === 404 &&
    err.code === "not_found"
  );
}

/** Human-readable text for the inline unlock prompt. */
export function unlockErrorMessage(err: unknown): string {
  if (err instanceof ReviewApiError) {
    if (err.status === 429) {
      const wait = err.retryAfterSec;
      return wait
        ? `Too many attempts. Try again in ${wait}s.`
        : "Too many attempts. Try again shortly.";
    }
    if (err.status === 401) return "Incorrect password.";
    if (err.status === 404)
      return "Review is not enabled on this deployment.";
  }
  return "Could not unlock. Check your connection and try again.";
}
