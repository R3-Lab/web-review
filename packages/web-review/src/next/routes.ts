/**
 * A factory that turns a consumer-supplied {@link ReviewStore} into ready-made
 * Next.js App Router route handlers for the review overlay's REST API.
 *
 * This package ships no server and no database — that constraint is the
 * whole point of `@r3lab/web-review`. This module is the piece that makes it
 * pleasant rather than punishing: the consumer writes seven small data
 * functions against their own database (Drizzle, Prisma, raw `pg`, MySQL,
 * anything — see {@link ReviewStore}) and gets back a fully wired,
 * authenticated, validated API. No HTTP plumbing of their own.
 *
 * Server-only. This module imports `../server/access` (which imports
 * `node:crypto`) and other server-only kit — it must never be reachable
 * from a `"use client"` file. See `./index.ts` and `./client.ts` for how the
 * client/server split is enforced at the package's export boundary.
 *
 * ## Wiring
 *
 * Call {@link createReviewRouteHandlers} once (e.g. in a shared
 * `lib/review.ts`) and re-export its handlers from the App Router files
 * below:
 *
 * ```ts
 * // lib/review.ts
 * import { createReviewRouteHandlers } from "@r3lab/web-review/next";
 * import { store } from "./review-store"; // your ReviewStore implementation
 *
 * export const review = createReviewRouteHandlers({
 *   store,
 *   access: {
 *     password: process.env.REVIEW_PASSWORD,
 *     secret: process.env.REVIEW_SECRET,
 *   },
 *   isAdmin: async () => Boolean((await getSession())?.user?.isAdmin),
 * });
 * ```
 *
 * ```ts
 * // app/api/review/unlock/route.ts
 * export const { POST } = review.unlock;
 *
 * // app/api/review/threads/route.ts
 * export const { GET, POST } = review.threads;
 *
 * // app/api/review/threads/[id]/route.ts
 * export const { GET, PATCH } = review.thread;
 *
 * // app/api/review/threads/[id]/comments/route.ts
 * export const { POST } = review.comments;
 *
 * // app/api/review/screenshot/route.ts
 * export const { POST } = review.screenshot;
 * ```
 *
 * Route paths are the consumer's choice — the client HTTP adapter
 * (`createHttpAdapter`, `../client/http-adapter`) is configured with
 * whatever base path is used here.
 *
 * For routes this factory does NOT provide — a screenshot redirector, a CSV
 * export, an admin-only sweep — `review.requireAccess(req)` applies the same
 * gate with the same configuration; see
 * {@link ReviewRouteHandlers.requireAccess}. Nothing about protecting an
 * auxiliary route should require re-deriving the check from primitives.
 *
 * Generalized from a single-app reference (Drizzle + Neon + R2 + Better
 * Auth): the HTTP semantics, status codes, and security checks are ported
 * faithfully; every storage-specific line becomes a call into
 * {@link ReviewStore}.
 */

import type { NewCommentInput, ReviewStatus } from "../core/types";
import {
  DEFAULT_ACCESS_COOKIE_PREFIX,
  clientIp,
  getAccessConfig,
  passwordMatches,
  requireReviewAccess,
  serializeAccessCookie,
  toSetCookieHeader,
} from "../server/access";
import type {
  AccessConfig,
  AdminPredicate,
  RequestAccessVerdict,
  ReviewAccessOptions,
} from "../server/access";
import { validatePng } from "../server/png";
import { createUnlockRateLimiter } from "../server/rate-limit";
import type { UnlockRateLimiterOptions } from "../server/rate-limit";
import { deriveTitle, toCommentView, toThreadView } from "../server/serialize";
import type { ReviewCommentRow, ReviewThreadRow } from "../server/serialize";
import {
  listThreadsQuerySchema,
  newCommentSchema,
  newThreadSchema,
  patchThreadSchema,
  screenshotKeySchema,
  threadIdSchema,
  unlockSchema,
} from "../server/validation";
import { z } from "zod";

// Re-exported so everything in this module's public signatures is nameable
// from the `./next` entry alone — `access` and the verdict handed back by
// `ReviewRouteHandlers.requireAccess` are both defined in `../server/access`
// (which is where the cookie and HMAC concerns live), and a consumer typing
// their own wrapper around either should not have to import from a second
// subpath to do it.
export type { RequestAccessVerdict, ReviewAccessOptions } from "../server/access";

/** Every response's fallback project namespace when neither the request body
 *  nor {@link CreateReviewRouteHandlersOptions.project} names one. */
const DEFAULT_PROJECT = "default";
/** Default screenshot ceiling: 5 MiB. */
const DEFAULT_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
/** Default screenshot floor: below this on either axis, a capture is
 *  discarded as worse than none — see `png.ts`'s `minDimension` doc. */
const DEFAULT_MIN_SCREENSHOT_DIMENSION = 200;
/** Default prefix `POST /threads`'s `screenshotKey` must match — see
 *  `screenshotKeySchema` in `../server/validation`. */
const DEFAULT_SCREENSHOT_KEY_PREFIX = "review";

// ---------------------------------------------------------------------------
// ReviewStore — the consumer's storage contract
// ---------------------------------------------------------------------------

/**
 * Filter params passed to {@link ReviewStore.listThreads} — `GET /threads`'s
 * query string after validation (`listThreadsQuerySchema` in
 * `../server/validation`), with `project` always resolved to a concrete
 * string (the query param, or else
 * {@link CreateReviewRouteHandlersOptions.project}, or else `"default"`).
 *
 * Mirrors `ListThreadsParams` in `../core/adapter.ts` — the client-facing
 * shape — but every field here is final: no further defaulting is needed by
 * the store.
 */
export interface ReviewStoreListThreadsParams {
  /** Never omitted here, unlike the client-facing `ListThreadsParams`. */
  project: string;
  /**
   * Restrict to one page. Omitted ONLY for the admin "triage inbox" query —
   * the route handler already enforces that a non-admin caller can never
   * reach this method without a `urlKey` (see `GET /threads`'s 400
   * `url_key_required`), so a store implementation never needs to re-check
   * that itself.
   */
  urlKey?: string;
  /** `"all"` means no status filter — every row regardless of status. */
  status: ReviewStatus | "all";
  /** Row cap, already validated to be within `[1, 500]` by the route. */
  limit: number;
}

/**
 * Validated input to {@link ReviewStore.createThread} — `POST /threads`'s
 * body after zod parsing (`newThreadSchema`), with `project` resolved the
 * same way as {@link ReviewStoreListThreadsParams.project} and `title`
 * defaulted via `deriveTitle(firstComment)` when the caller left it blank.
 *
 * `anchor`/`viewport` are opaque, client-owned JSON — see the file header of
 * `../core/types.ts`. A store MUST persist and return them verbatim (e.g. as
 * `jsonb`/`json` columns) and never introspect their contents.
 */
export interface ReviewStoreCreateThreadInput {
  project: string;
  url: string;
  urlKey: string;
  /**
   * `null` both when the caller sent `locale: null` and when they omitted
   * the key entirely — `newThreadSchema` accepts either (see that field's
   * doc comment), and the route collapses them here so a store only ever
   * sees `string | null`.
   */
  locale: string | null;
  route: string | null;
  /** Never blank — either the caller's trimmed `title`, or `deriveTitle(firstComment)`. */
  title: string | null;
  category: string;
  anchor: unknown;
  /** `null` when the caller omitted a viewport snapshot. */
  viewport: unknown;
  authorId: string;
  authorName: string;
  /** Opens the thread. Persist as the thread's first (and only, at insert time) comment. */
  firstComment: string;
  /**
   * Already validated against the configured screenshot-key prefix (see
   * `screenshotKeySchema`) — a store never needs to re-check its shape, only
   * persist it.
   */
  screenshotKey: string | null;
}

/**
 * The storage contract a consumer implements to back the review overlay's
 * API with their own database — Drizzle, Prisma, raw `pg`, MySQL, SQLite,
 * anything. This interface is the implementation guide: every method's
 * arguments, return shape, and the meaning of a `null` return are documented
 * here precisely enough to write a correct store from these doc comments
 * alone, without reading this package's route-handler source.
 *
 * Row shapes are the STRUCTURAL interfaces {@link ReviewThreadRow} and
 * {@link ReviewCommentRow} from `../server/serialize` — any ORM's row
 * satisfies them; no concrete row type from this package is required.
 */
export interface ReviewStore {
  /**
   * List threads matching `params`, newest first (by `createdAt`).
   *
   * Comment counts must come from the database (e.g. a `count(*)` / grouped
   * join), not from loading every comment row — this is the list endpoint;
   * full comment bodies are fetched per-thread via {@link getThread}.
   */
  listThreads(
    params: ReviewStoreListThreadsParams,
  ): Promise<{ thread: ReviewThreadRow; commentCount: number }[]>;

  /**
   * Fetch one thread WITH its comments, oldest first (by `createdAt`).
   *
   * Returns `null` when `id` does not match any thread — the route handler
   * turns that into a 404, never a 500.
   */
  getThread(id: string): Promise<{ thread: ReviewThreadRow; comments: ReviewCommentRow[] } | null>;

  /**
   * Insert a thread together with its opening comment, ATOMICALLY: both
   * inserts must commit together or neither does.
   *
   * Why this matters: `firstComment` is required on every `POST /threads`
   * body — the overlay always opens a thread with text, and every
   * `ReviewThreadView` the client renders assumes at least one comment (or a
   * `commentCount` ≥ 1). A thread row that exists without its first comment
   * is a broken row the UI cannot render; a partial write here is worse than
   * no write at all.
   *
   * How to get atomicity without necessarily having interactive
   * transactions: the reference implementation this factory was generalized
   * from runs on Neon's HTTP driver, which has no `db.transaction` (no
   * persistent session to run BEGIN/COMMIT over). It used `db.batch([...])`
   * instead, which Neon's HTTP endpoint executes as a single server-side
   * transaction in one round trip — the thread insert and the comment
   * insert commit together or not at all, with no interactive transaction
   * involved. Most other drivers (node-postgres, a real Postgres
   * connection, Prisma's `$transaction`, SQLite) support a normal
   * interactive transaction and can simply wrap both inserts in one. The
   * requirement is the outcome — both rows exist or neither does — not any
   * particular mechanism.
   */
  createThread(
    input: ReviewStoreCreateThreadInput,
  ): Promise<{ thread: ReviewThreadRow; comment: ReviewCommentRow }>;

  /**
   * Reply on an existing thread. Should also bump the parent thread's
   * `updatedAt` (so a "last activity" sort stays meaningful) — that's an
   * internal detail of this call, not reflected in its return value.
   *
   * Returns `null` when `threadId` does not match any thread — the route
   * handler turns that into a 404. (An id that fails UUID validation never
   * reaches this method at all — the route handler answers 404 before
   * calling the store.)
   */
  addComment(threadId: string, input: NewCommentInput): Promise<ReviewCommentRow | null>;

  /**
   * Resolve or reopen a thread and return it together with its comments
   * (oldest first), for the same reason {@link getThread} returns comments —
   * the response to `PATCH /threads/:id` is a full thread view.
   *
   * Resolving (`status: "resolved"`) should stamp `resolvedAt`/`resolvedBy`;
   * reopening (`status: "open"`) should clear both, regardless of what
   * `resolvedBy` was passed — a thread's resolution metadata must never
   * survive it going back to `open`. `resolvedBy` is already trimmed to
   * `null` by the route handler when blank or when `status` is `"open"`.
   *
   * Returns `null` when `threadId` does not match any thread.
   */
  setStatus(
    threadId: string,
    status: ReviewStatus,
    resolvedBy: string | null,
  ): Promise<{ thread: ReviewThreadRow; comments: ReviewCommentRow[] } | null>;

  /**
   * Store a validated screenshot upload (`bytes` is a real PNG — signature,
   * dimensions, and size already checked by the route handler via
   * `validatePng`) and return an OPAQUE storage key.
   *
   * IMPORTANT: the returned key MUST match
   * `screenshotKeySchema(keyPrefix)` — see
   * {@link CreateReviewRouteHandlersOptions.screenshot}'s `keyPrefix`
   * (default `"review"`) — i.e. `` `${keyPrefix}/<safe-chars>.png` ``. A key
   * in any other shape will be silently REJECTED by `POST /threads`'s
   * `screenshotKey` validation later (400 `bad_request`), because that
   * validation exists specifically so a reviewer cannot point
   * `screenshotKey` at an arbitrary object in the consumer's bucket.
   *
   * Optional. Omit entirely to disable the screenshot endpoint: the route
   * handler checks for this method's presence and answers 404
   * `screenshots_unsupported` rather than calling it when absent — it never
   * crashes on a missing implementation.
   */
  putScreenshot?(bytes: Uint8Array, contentType: string): Promise<string>;

  /**
   * Compose a URL from a `putScreenshot` key (e.g. point it at R2, S3, a
   * CDN, or a signed-URL minter). Returning `null` means "no URL available
   * for this key" — the thread view's `screenshotUrl` becomes `null` rather
   * than throwing.
   *
   * MAY BE ASYNC, and that half of the union is the important one. A public
   * CDN can be served by string concatenation, but a PRIVATE bucket cannot:
   * it needs a presigned, expiring URL, and every SDK that mints one
   * (`@aws-sdk/s3-request-presigner`, R2, GCS) is asynchronous. A
   * sync-only signature is quietly incompatible with the safer and more
   * common setup, and pushes every consumer with a private bucket into the
   * same workaround — a redirector route that mints the presigned URL per
   * request and 302s to it. Returning the promise straight from here
   * deletes that whole category of indirection.
   *
   * Widening this was deliberately NOT a breaking change. `screenshotUrl`
   * is a method consumers IMPLEMENT and this package CALLS, so variance
   * runs the helpful way: an existing synchronous implementation returning
   * `string | null` still satisfies `string | null | Promise<string | null>`
   * and keeps compiling untouched. Only this package's own call sites had
   * to change.
   *
   * Throwing or rejecting is survivable, never fatal: the route handler
   * catches it, that one thread serializes with `screenshotUrl: null`, and
   * every other thread in the response is unaffected — see
   * `resolveScreenshotUrls`. A screenshot is an aid to a review comment,
   * never worth failing a whole list of them over.
   *
   * Optional. Omit to always report `screenshotUrl: null` on every thread
   * (e.g. while screenshots are disabled, or during local development
   * before a bucket is configured).
   */
  screenshotUrl?(key: string): string | null | Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Factory options and the handler shapes it returns
// ---------------------------------------------------------------------------

export interface CreateReviewRouteHandlersOptions {
  /** The consumer's storage implementation. */
  store: ReviewStore;
  /**
   * The shared-password gate. Both `password` and `secret` must be
   * non-empty for the feature to turn on — see `getAccessConfig` in
   * `../server/access`. Leaving either unset takes every route in this
   * factory's output to 404 `feature_disabled`, including for a caller
   * `isAdmin` would otherwise admit. There is deliberately no open fallback.
   *
   * The field's type ({@link ReviewAccessOptions}) is shared with the
   * standalone `requireReviewAccess` guard, so the identical object protects
   * a consumer's own auxiliary routes — see
   * {@link ReviewRouteHandlers.requireAccess}.
   */
  access: ReviewAccessOptions;
  /**
   * Lets a consumer's own admins in on every route without the shared
   * password (checked only after the signed cookie fails — see
   * `resolveAccess`). A predicate that throws is treated as "not admin",
   * never as a 500.
   */
  isAdmin?: AdminPredicate;
  /** Default project namespace when a caller omits one. Default `"default"`. */
  project?: string;
  /** Tune the unlock endpoint's per-IP attempt limiter. Each factory call
   *  gets its own independent limiter instance. */
  rateLimit?: UnlockRateLimiterOptions;
  /** Screenshot upload constraints for `POST /screenshot`. */
  screenshot?: {
    /** Reject uploads over this size. Default 5 MiB. */
    maxBytes?: number;
    /** Reject images narrower/shorter than this, in pixels. Default 200. */
    minDimension?: number;
    /** Storage-key prefix `POST /threads`'s `screenshotKey` must match.
     *  Default `"review"` — must agree with whatever prefix the store's
     *  `putScreenshot` mints keys under. */
    keyPrefix?: string;
  };
}

/** Route-segment params for a dynamic Next.js App Router file — matches
 *  Next 15+'s async-params convention (`params` is a `Promise`). */
export interface ReviewRouteContext<P> {
  params: Promise<P>;
}

/** A handler for a static route file, e.g. `app/api/review/unlock/route.ts`. */
export type ReviewRouteHandler = (req: Request) => Promise<Response>;

/** A handler for a dynamic `[id]` route file. */
export type ReviewRouteHandlerWithParams<P> = (
  req: Request,
  ctx: ReviewRouteContext<P>,
) => Promise<Response>;

/**
 * Handlers grouped by the App Router file each belongs in — see the file
 * header for the exact wiring — plus {@link ReviewRouteHandlers.requireAccess},
 * which belongs in no file of its own.
 */
export interface ReviewRouteHandlers {
  unlock: { POST: ReviewRouteHandler };
  threads: { GET: ReviewRouteHandler; POST: ReviewRouteHandler };
  thread: {
    GET: ReviewRouteHandlerWithParams<{ id: string }>;
    PATCH: ReviewRouteHandlerWithParams<{ id: string }>;
  };
  comments: { POST: ReviewRouteHandlerWithParams<{ id: string }> };
  screenshot: { POST: ReviewRouteHandler };
  /**
   * The access gate every handler above runs, already bound to this
   * factory's `access` config and `isAdmin` predicate — for protecting
   * routes this factory does NOT provide.
   *
   * Consumers do add such routes: a redirector that presigns a private
   * bucket URL, a CSV export, an admin-only sweep. Without this they would
   * re-derive the check from the primitives and parse the `Cookie` header by
   * hand, which is how an auxiliary route ends up subtly more permissive
   * than the ones it sits beside. Bound here rather than merely available
   * standalone so there is no second copy of the password, secret, cookie
   * prefix and admin predicate to keep in sync.
   *
   * ```ts
   * // app/api/review/shot/route.ts
   * import { review } from "@/lib/review";
   *
   * export async function GET(req: Request) {
   *   const access = await review.requireAccess(req);
   *   if (!access.ok) return Response.json({ error: access.reason }, { status: access.status });
   *   // …serve the screenshot.
   * }
   * ```
   *
   * Returns a verdict, never a `Response`: the status codes are supplied
   * (404 `feature_disabled`, 401 `locked`) but the body, headers and
   * redirect behaviour stay the consumer's to choose. Identical in every
   * respect to calling `requireReviewAccess` (`../server/access`) with this
   * factory's options — it IS that call.
   */
  requireAccess: (req: Request) => Promise<RequestAccessVerdict>;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Every review-route response is noindex and never CDN-cached — this
 *  surface is reviewer-scoped and must never leak into search or a shared
 *  cache. */
const ROBOTS_TAG = "noindex, nofollow, noarchive";

function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("X-Robots-Tag", ROBOTS_TAG);
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

/**
 * 404 for a missing/malformed thread id — the resource genuinely doesn't
 * exist. Distinct from {@link featureDisabled} and
 * {@link screenshotsUnsupported}: this code means "keep looking with a
 * different id," not "there is nothing here at all."
 */
function notFound(): Response {
  return json({ error: "not_found" }, { status: 404 });
}

/**
 * 404 for the kill switch being off (no password/secret configured — see
 * `getAccessConfig` in `../server/access`). Every route answers this, even
 * for a caller `isAdmin` would otherwise admit; see `requireAccess` and the
 * `unlock` handler, its only two call sites. This is the ONLY code
 * `isFeatureDisabled` (`../core/adapter`) recognizes.
 */
function featureDisabled(): Response {
  return json({ error: "feature_disabled" }, { status: 404 });
}

/**
 * 404 for `POST /screenshot` when the store never implemented
 * `putScreenshot` — screenshot uploads are simply unsupported by this
 * consumer, which is not the same thing as the whole feature being off.
 */
function screenshotsUnsupported(): Response {
  return json({ error: "screenshots_unsupported" }, { status: 404 });
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

export function createReviewRouteHandlers(
  options: CreateReviewRouteHandlersOptions,
): ReviewRouteHandlers {
  const { store } = options;
  const defaultProject = options.project ?? DEFAULT_PROJECT;
  const cookiePrefix = options.access.cookiePrefix ?? DEFAULT_ACCESS_COOKIE_PREFIX;
  const limiter = createUnlockRateLimiter(options.rateLimit);
  const maxBytes = options.screenshot?.maxBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES;
  const minDimension = options.screenshot?.minDimension ?? DEFAULT_MIN_SCREENSHOT_DIMENSION;
  const keyPrefix = options.screenshot?.keyPrefix ?? DEFAULT_SCREENSHOT_KEY_PREFIX;
  const threadSchema = newThreadSchema.extend({
    screenshotKey: screenshotKeySchema(keyPrefix).nullish(),
  });
  /**
   * Resolve every screenshot key in `rows` to its URL BEFORE serialization,
   * and hand back the synchronous lookup `toThreadView` consults. Every
   * `toThreadView` call below composes `screenshotUrl` through this one
   * helper, whether or not the store implements the method.
   *
   * Why a pre-pass rather than resolving inside the serializer:
   * {@link ReviewStore.screenshotUrl} may be async (a presigned-URL
   * minter), but `toThreadView` (`../server/serialize`) is a pure,
   * synchronous row→wire mapper called from several places, and it is worth
   * keeping free of I/O. So the awaiting happens here, once per response,
   * and the serializer only ever reads an already-resolved value out of a
   * map.
   *
   * Three properties this deliberately guarantees:
   *
   *  - PARALLEL, never serial. `GET /threads` returns up to 500 rows;
   *    awaiting each presigned URL in turn would turn one round trip into N
   *    sequential ones and make a real list unusable. `Promise.all` keeps
   *    the cost one round trip deep no matter how many rows come back.
   *  - DEDUPLICATED. Keys go through a `Set` first, so two threads sharing
   *    one screenshot cost one call rather than two. This is not a special
   *    case bolted on: a key→URL map is what the lookup needs anyway, and
   *    distinct keys are what fills it.
   *  - FAILURE-ISOLATED. A key whose resolution throws or rejects becomes
   *    `null` for that thread alone; its siblings and the response as a
   *    whole are untouched. That matches the posture the write path already
   *    takes (a failed capture must never cost a reviewer their comment —
   *    see `ShotState` in `../overlay/overlay-root.tsx`): a misconfigured
   *    bucket should cost a thumbnail, not 500 the reviewer's inbox. The
   *    `try` covers a synchronous `throw` as well as a rejected promise,
   *    since a sync implementation is still legal here.
   *
   * Threads with no `screenshotKey` never reach `store.screenshotUrl` at
   * all — they are filtered out before the key set is built, so a store
   * that would charge for a lookup is never asked about a thread that has
   * no screenshot.
   *
   * `store.screenshotUrl` is invoked as a METHOD on `store` (never
   * extracted into a bare reference) so a class-based store implementation
   * that reads `this` keeps working.
   */
  async function resolveScreenshotUrls(
    rows: readonly ReviewThreadRow[],
  ): Promise<(key: string) => string | null> {
    if (!store.screenshotUrl) return () => null;

    const keys = [
      ...new Set(rows.flatMap((row) => (row.screenshotKey ? [row.screenshotKey] : []))),
    ];
    const entries = await Promise.all(
      keys.map(async (key): Promise<[string, string | null]> => {
        try {
          return [key, (await store.screenshotUrl?.(key)) ?? null];
        } catch {
          return [key, null];
        }
      }),
    );

    const resolved = new Map(entries);
    return (key) => resolved.get(key) ?? null;
  }

  function accessConfig(): AccessConfig | null {
    return getAccessConfig({ password: options.access.password, secret: options.access.secret });
  }

  /**
   * The gate every route except `/unlock` runs first, and the exact function
   * handed back as {@link ReviewRouteHandlers.requireAccess} for a
   * consumer's own auxiliary routes. Feature disabled (kill switch off) ⇒
   * 404 `feature_disabled`, even for a caller `isAdmin` would otherwise
   * admit — there is deliberately no open fallback. Otherwise: a valid
   * signed cookie, or a successful `isAdmin` check, admits; anything else is
   * a 401 `locked`.
   */
  const requireAccessVerdict = (req: Request): Promise<RequestAccessVerdict> =>
    requireReviewAccess(req, { access: options.access, isAdmin: options.isAdmin });

  /**
   * {@link requireAccessVerdict} with the refusals already rendered as this
   * package's own JSON responses, which is all the handlers below want. The
   * verdict → response mapping lives here rather than in `../server/access`
   * because the body shape and the `X-Robots-Tag`/`Cache-Control` headers
   * are this route factory's contract, not the access module's.
   */
  async function requireAccess(
    req: Request,
  ): Promise<{ ok: true; isAdmin: boolean } | { ok: false; response: Response }> {
    const verdict = await requireAccessVerdict(req);
    if (verdict.ok) return { ok: true, isAdmin: verdict.isAdmin };
    return {
      ok: false,
      response:
        verdict.reason === "feature_disabled"
          ? featureDisabled()
          : json({ error: verdict.reason }, { status: verdict.status }),
    };
  }

  const unlock: ReviewRouteHandler = async (req) => {
    const config = accessConfig();
    if (!config) return featureDisabled();

    const ip = clientIp((name) => req.headers.get(name));
    const attempt = limiter.consumeUnlockAttempt(ip);
    if (!attempt.allowed) {
      return json(
        { error: "too_many_attempts" },
        { status: 429, headers: { "Retry-After": String(attempt.retryAfterSec) } },
      );
    }

    const raw: unknown = await req.json().catch(() => null);
    const parsed = unlockSchema.safeParse(raw);
    if (!parsed.success) {
      // No zod details here: the only field is the password, and its
      // issues (length, type) are the sort of thing an attacker can probe.
      return json({ error: "bad_request" }, { status: 400 });
    }

    if (!passwordMatches(parsed.data.password, config.password)) {
      return json({ error: "invalid_password" }, { status: 401 });
    }

    limiter.clearUnlockAttempts(ip);
    const descriptor = serializeAccessCookie(config, {
      cookiePrefix,
      secure: options.access.secureCookie,
    });
    return json({ ok: true }, { headers: { "Set-Cookie": toSetCookieHeader(descriptor) } });
  };

  const threadsGet: ReviewRouteHandler = async (req) => {
    const access = await requireAccess(req);
    if (!access.ok) return access.response;

    const url = new URL(req.url);
    const parsed = listThreadsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return json({ error: "bad_request", details: z.flattenError(parsed.error) }, { status: 400 });
    }
    const { urlKey, status, limit, project: queryProject } = parsed.data;

    // Reviewers may only list one page at a time; the unscoped listing (the
    // admin triage inbox's query) is restricted to a real admin.
    if (!urlKey && !access.isAdmin) {
      return json({ error: "url_key_required" }, { status: 400 });
    }

    const rows = await store.listThreads({
      project: queryProject ?? defaultProject,
      urlKey,
      status,
      limit,
    });

    // One resolution pass for the whole page, so N rows cost one round trip
    // rather than N sequential ones — see `resolveScreenshotUrls`.
    const screenshotUrl = await resolveScreenshotUrls(rows.map((row) => row.thread));

    return json({
      threads: rows.map((row) =>
        toThreadView(row.thread, { comments: [], commentCount: row.commentCount, screenshotUrl }),
      ),
    });
  };

  const threadsPost: ReviewRouteHandler = async (req) => {
    const access = await requireAccess(req);
    if (!access.ok) return access.response;

    const raw: unknown = await req.json().catch(() => null);
    const parsed = threadSchema.safeParse(raw);
    if (!parsed.success) {
      return json({ error: "bad_request", details: z.flattenError(parsed.error) }, { status: 400 });
    }
    const input = parsed.data;
    const title = input.title?.trim() || deriveTitle(input.firstComment);

    // This call is the boundary where validated input becomes a stored row,
    // so it is where `?? null` belongs. Every nullish field in
    // `newThreadSchema` may be sent as `null` OR left out altogether, and an
    // omitted key parses to `undefined` — but every column these land in,
    // and the `ReviewThreadRow`/`ReviewThreadView` shapes read back out of
    // them, are `T | null`. Collapsing here means a store never has to
    // handle `undefined`, and `undefined` can never reach the wire (where it
    // would drop the key from the JSON body rather than serialize as null).
    const { thread, comment } = await store.createThread({
      project: input.project ?? defaultProject,
      url: input.url,
      urlKey: input.urlKey,
      locale: input.locale ?? null,
      route: input.route ?? null,
      title,
      category: input.category,
      anchor: input.anchor,
      viewport: input.viewport ?? null,
      authorId: input.authorId,
      authorName: input.authorName,
      firstComment: input.firstComment,
      screenshotKey: input.screenshotKey ?? null,
    });

    const screenshotUrl = await resolveScreenshotUrls([thread]);

    return json(
      { thread: toThreadView(thread, { comments: [comment], commentCount: 1, screenshotUrl }) },
      { status: 201 },
    );
  };

  const threadGet: ReviewRouteHandlerWithParams<{ id: string }> = async (req, ctx) => {
    const access = await requireAccess(req);
    if (!access.ok) return access.response;

    // A malformed id is answered 404 rather than 400: an unparseable uuid
    // and a missing row are the same thing to a caller, and it keeps a bad
    // id from ever reaching the store as (e.g.) a Postgres cast error.
    const id = threadIdSchema.safeParse((await ctx.params).id);
    if (!id.success) return notFound();

    const result = await store.getThread(id.data);
    if (!result) return notFound();

    const screenshotUrl = await resolveScreenshotUrls([result.thread]);

    return json({
      thread: toThreadView(result.thread, {
        comments: result.comments,
        commentCount: result.comments.length,
        screenshotUrl,
      }),
    });
  };

  const threadPatch: ReviewRouteHandlerWithParams<{ id: string }> = async (req, ctx) => {
    const access = await requireAccess(req);
    if (!access.ok) return access.response;

    const id = threadIdSchema.safeParse((await ctx.params).id);
    if (!id.success) return notFound();

    const raw: unknown = await req.json().catch(() => null);
    const parsed = patchThreadSchema.safeParse(raw);
    if (!parsed.success) {
      return json({ error: "bad_request", details: z.flattenError(parsed.error) }, { status: 400 });
    }
    const { status, resolvedBy } = parsed.data;

    // Resolving stamps who/when; reopening clears both, so a thread's
    // resolution metadata never survives it going back to "open".
    const result = await store.setStatus(
      id.data,
      status,
      status === "resolved" ? resolvedBy?.trim() || null : null,
    );
    if (!result) return notFound();

    const screenshotUrl = await resolveScreenshotUrls([result.thread]);

    return json({
      thread: toThreadView(result.thread, {
        comments: result.comments,
        commentCount: result.comments.length,
        screenshotUrl,
      }),
    });
  };

  const commentsPost: ReviewRouteHandlerWithParams<{ id: string }> = async (req, ctx) => {
    const access = await requireAccess(req);
    if (!access.ok) return access.response;

    const id = threadIdSchema.safeParse((await ctx.params).id);
    if (!id.success) return notFound();

    const raw: unknown = await req.json().catch(() => null);
    const parsed = newCommentSchema.safeParse(raw);
    if (!parsed.success) {
      return json({ error: "bad_request", details: z.flattenError(parsed.error) }, { status: 400 });
    }

    // Existence check happens inside the store (returns null on a missing
    // thread) rather than here, so a bad id surfaces as a clean 404 instead
    // of a raw foreign-key violation.
    const comment = await store.addComment(id.data, parsed.data);
    if (!comment) return notFound();

    return json({ comment: toCommentView(comment) }, { status: 201 });
  };

  const screenshotPost: ReviewRouteHandler = async (req) => {
    const access = await requireAccess(req);
    if (!access.ok) return access.response;

    // Omitting `putScreenshot` cleanly disables the endpoint rather than
    // crashing when it's eventually called.
    if (!store.putScreenshot) return screenshotsUnsupported();

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "invalid_form" }, { status: 400 });
    }

    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "no_file" }, { status: 400 });

    const bytes = new Uint8Array(await file.arrayBuffer());
    // `file.type` (client-declared) is never trusted for "is this actually
    // a PNG" — `validatePng` checks the real signature, IHDR, and bounds.
    const result = validatePng(bytes, { maxBytes, minDimension });
    if (!result.ok) return json({ error: result.reason }, { status: 400 });

    const key = await store.putScreenshot(bytes, "image/png");
    return json({ key }, { status: 201 });
  };

  return {
    unlock: { POST: unlock },
    threads: { GET: threadsGet, POST: threadsPost },
    thread: { GET: threadGet, PATCH: threadPatch },
    comments: { POST: commentsPost },
    screenshot: { POST: screenshotPost },
    requireAccess: requireAccessVerdict,
  };
}
