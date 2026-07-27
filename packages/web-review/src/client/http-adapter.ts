"use client";

/**
 * `createHttpAdapter` — a `ReviewAdapter` factory over same-origin REST
 * routes.
 *
 * Rewritten (not ported) from a working single-app review tool's typed
 * fetch client (`feedback/api.ts`): that client hard-coded its routes and
 * error types. Here the method set is exactly `ReviewAdapter`, and the wire
 * shape below is the CONTRACT a consumer's server-side route factory
 * (`../next/routes.ts`'s `createReviewRouteHandlers`) must implement — this
 * file is the source of truth for it, so read it before writing that
 * factory.
 *
 *   POST   {base}/unlock                        { password }          -> { ok }
 *   GET    {base}/threads?urlKey=&status=&project=&limit=             -> { threads }
 *   POST   {base}/threads                       NewThreadInput        -> { thread }
 *   GET    {base}/threads/:id                                        -> { thread }
 *   PATCH  {base}/threads/:id                   { status, resolvedBy } -> { thread }
 *   POST   {base}/threads/:id/comments          NewCommentInput       -> { comment }
 *   POST   {base}/screenshot                    FormData(file)        -> { key }
 *
 * `base` defaults to `/api/review` (override via `HttpAdapterOptions.baseUrl`).
 *
 * Error handling matches the reference exactly: every non-2xx response
 * throws {@link ReviewApiError} (from `../core/adapter`) carrying the HTTP
 * status, the parsed `error` code from the JSON body (when present), and a
 * parsed `Retry-After` header (when present and a positive number). The
 * 401-`locked` / 404-`feature_disabled` / 404-`not_found` / 429 distinction
 * this produces is what drives real overlay behaviour — see `isLocked`,
 * `isFeatureDisabled`, `unlockErrorMessage` in `../core/adapter`. In
 * particular a 404 carrying code `feature_disabled` means the review
 * feature is switched off server-side, so the overlay hides entirely rather
 * than offering a password prompt that can never succeed — a 404 carrying
 * `not_found` (an unknown thread id) or `screenshots_unsupported` (no
 * `putScreenshot` on the store) is a different, unrelated condition and
 * must NOT trip `isFeatureDisabled`.
 *
 * `uploadScreenshot` is the one method that deliberately does NOT rethrow:
 * per the `ReviewAdapter.uploadScreenshot` contract, a storage failure
 * (network error, non-2xx, malformed body) resolves to `null` rather than
 * throwing, so a broken screenshot endpoint never blocks thread creation —
 * the same "never block submission" guarantee `../client/screenshot.ts`
 * gives capture itself.
 *
 * Every request sends `credentials: "same-origin"` and `cache: "no-store"`,
 * and sets a JSON content-type ONLY for JSON bodies — a `FormData` body
 * (the screenshot upload) is sent with no explicit content-type so the
 * browser sets its own multipart boundary. A 204 or non-JSON response body
 * is tolerated (resolves to `undefined` rather than throwing on `.json()`).
 */

import { ReviewApiError } from "../core/adapter";
import type { ListThreadsParams, ReviewAdapter } from "../core/adapter";
import type {
  NewCommentInput,
  NewThreadInput,
  ReviewCommentView,
  ReviewStatus,
  ReviewThreadView,
} from "../core/types";

/** The multipart field name `POST {base}/screenshot` reads. */
const SCREENSHOT_FIELD = "file";

/** Options for {@link createHttpAdapter}. */
export interface HttpAdapterOptions {
  /** Base path/URL prefixed to every route. Default `"/api/review"`. */
  baseUrl?: string;
  /**
   * Override for the global `fetch` — inject a fake in tests, or a
   * server-scoped `fetch` (e.g. `next/headers`-aware) for SSR use.
   */
  fetch?: typeof fetch;
  /**
   * Extra headers merged into every request (e.g. an auth token). Either a
   * static `HeadersInit` or a function evaluated per request, for values
   * that can change over the adapter's lifetime.
   */
  headers?: HeadersInit | (() => HeadersInit);
}

/** Create a {@link ReviewAdapter} backed by same-origin REST routes. */
export function createHttpAdapter(
  options: HttpAdapterOptions = {},
): ReviewAdapter {
  const baseUrl = options.baseUrl ?? "/api/review";
  const fetchImpl = options.fetch ?? fetch;
  const extraHeaders = options.headers;

  /**
   * Shared fetch. Sends `credentials: "same-origin"` and `cache: "no-store"`,
   * a JSON content-type for JSON bodies only, and throws
   * {@link ReviewApiError} with the parsed `error` code on any non-2xx.
   */
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    // FormData must keep the browser-generated multipart content-type.
    if (init.body != null && !(init.body instanceof FormData)) {
      headers.set("content-type", "application/json");
    }
    const extra =
      typeof extraHeaders === "function" ? extraHeaders() : extraHeaders;
    if (extra) {
      new Headers(extra).forEach((value, key) => headers.set(key, value));
    }

    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let code: string | undefined;
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (typeof parsed.error === "string") code = parsed.error;
        } catch {
          // Non-JSON error body (a proxy/HTML error page); status still surfaces.
        }
      }
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfter = retryAfterHeader != null ? Number(retryAfterHeader) : NaN;
      throw new ReviewApiError(
        res.status,
        code || text || `${res.status} ${res.statusText}`,
        code,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }

    // 204/empty-body tolerant: parse only when there is a JSON body.
    const ct = res.headers.get("content-type") ?? "";
    if (res.status === 204 || !ct.includes("application/json")) {
      return undefined as unknown as T;
    }
    return (await res.json()) as T;
  }

  return {
    async listThreads(params: ListThreadsParams): Promise<ReviewThreadView[]> {
      const qs = new URLSearchParams();
      if (params.urlKey) qs.set("urlKey", params.urlKey);
      if (params.project) qs.set("project", params.project);
      if (params.status) qs.set("status", params.status);
      if (params.limit != null) qs.set("limit", String(params.limit));
      const suffix = qs.toString();
      const res = await request<{ threads: ReviewThreadView[] }>(
        `/threads${suffix ? `?${suffix}` : ""}`,
      );
      return res.threads;
    },

    async getThread(id: string): Promise<ReviewThreadView> {
      const res = await request<{ thread: ReviewThreadView }>(
        `/threads/${encodeURIComponent(id)}`,
      );
      return res.thread;
    },

    async createThread(input: NewThreadInput): Promise<ReviewThreadView> {
      const res = await request<{ thread: ReviewThreadView }>("/threads", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return res.thread;
    },

    async addComment(
      threadId: string,
      input: NewCommentInput,
    ): Promise<ReviewCommentView> {
      const res = await request<{ comment: ReviewCommentView }>(
        `/threads/${encodeURIComponent(threadId)}/comments`,
        { method: "POST", body: JSON.stringify(input) },
      );
      return res.comment;
    },

    async setStatus(
      threadId: string,
      status: ReviewStatus,
      resolvedBy?: string | null,
    ): Promise<ReviewThreadView> {
      const res = await request<{ thread: ReviewThreadView }>(
        `/threads/${encodeURIComponent(threadId)}`,
        { method: "PATCH", body: JSON.stringify({ status, resolvedBy }) },
      );
      return res.thread;
    },

    async uploadScreenshot(blob: Blob): Promise<string | null> {
      try {
        const form = new FormData();
        form.append(SCREENSHOT_FIELD, blob, "screenshot.png");
        const res = await request<{ key: string }>("/screenshot", {
          method: "POST",
          body: form,
        });
        return res.key;
      } catch {
        // Storage failure: the caller proceeds with thread creation minus
        // the screenshot rather than blocking on it — see the file header.
        return null;
      }
    },

    async unlock(password: string): Promise<void> {
      await request<{ ok: true }>("/unlock", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
    },
  };
}
