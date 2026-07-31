# Bring your own storage

**Part of [`@r3lab/web-review`](https://github.com/R3-Lab/web-review/blob/main/README.md)** — an
in-page review overlay for React and Next.js apps that ships no server and no
database. This page is the contract that stands in for the two it doesn't ship:
the interfaces you implement, and the Drizzle table factories that save you
hand-writing one of them. If you landed here from a search engine and want to
know what the package is or how to mount it, start at the
[README](https://github.com/R3-Lab/web-review/blob/main/README.md).

**On this page:** [`ReviewAdapter`](#client-side-reviewadapter) ·
[`ReviewStore`](#server-side-reviewstore) ·
[Async `screenshotUrl`](#async-screenshoturl-private-buckets-and-presigned-links) ·
[Drizzle table factories](#drizzle-table-factories)

---

This is the constraint the whole package is built around: implement one of
these two interfaces (both built on the wire contract in `core/types.ts`)
and everything else — the overlay UI, anchoring, threading — works against
your database.

## Client side: `ReviewAdapter`

What the overlay calls. `createHttpAdapter()` (exported from the package's
main entry) implements this over REST and is what most consumers use
directly; implement it yourself only if you're not using REST at all (e.g.
calling server functions or a GraphQL API directly from the client).

| Method | Required | Signature | Notes |
|---|---|---|---|
| `listThreads` | yes | `(params: ListThreadsParams) => Promise<ReviewThreadView[]>` | Newest first. Each row's `comments` must be `[]` — list rows carry `commentCount` instead. |
| `getThread` | yes | `(id: string) => Promise<ReviewThreadView>` | Comments included, oldest first. Throw `ReviewApiError` status 404 if `id` doesn't exist. |
| `createThread` | yes | `(input: NewThreadInput) => Promise<ReviewThreadView>` | Returns the thread with exactly one comment (`input.firstComment`) and `commentCount: 1`. |
| `addComment` | yes | `(threadId, input: NewCommentInput) => Promise<ReviewCommentView>` | Returns the new comment only, not the thread. Throw 404 if `threadId` doesn't exist. |
| `setStatus` | yes | `(threadId, status, resolvedBy?) => Promise<ReviewThreadView>` | Reopening (`status: "open"`) must clear `resolvedAt`/`resolvedBy` regardless of what `resolvedBy` was passed. Throw 404 if missing. |
| `uploadScreenshot` | optional | `(blob: Blob) => Promise<string \| null>` | `null` means "capture succeeded, storage failed" — thread creation proceeds without an image. **Omit the method entirely** to disable capture outright; the overlay checks for its presence before ever calling `captureScreenshot`. |
| `unlock` | optional | `(password: string) => Promise<void>` | Throw 401 on a wrong password, optionally 429 with `retryAfterSec` when rate-limited. Omit if you gate access some other way (e.g. the preview deployment itself sits behind auth) — the overlay then never shows an unlock prompt. |

Failures are communicated by throwing `ReviewApiError(status, message, code?, retryAfterSec?)`
(exported from the main entry and from `./server`). `isLocked(err)` (status
401), `isFeatureDisabled(err)` (status 404 + code `feature_disabled`), and
`unlockErrorMessage(err)` are the helpers the overlay itself uses to react to
those errors — reuse them if you write a custom adapter.

## Server side: `ReviewStore`

What `createReviewRouteHandlers` (`@r3lab/web-review/next`) calls. This is
the interface to implement against Prisma, raw `pg`/`mysql2`, or anything
else — the Drizzle example in the [Next.js quickstart](https://github.com/R3-Lab/web-review/blob/main/README.md#quickstart-nextjs)
is one concrete implementation of it.

<img src="https://raw.githubusercontent.com/R3-Lab/web-review/main/docs/images/thread-detail.png" width="384" alt="A resolved thread with two comments and a Reopen control.">

*A resolved thread, rendered by the stock `ThreadDetail` surface — the
Reopen control is what calls `setStatus`.*

| Method | Required | Returns | Notes |
|---|---|---|---|
| `listThreads` | yes | `{ thread: ReviewThreadRow; commentCount: number }[]` | Comment counts must come from the database (a `count(*)`/grouped join), not by loading every comment. |
| `getThread` | yes | `{ thread; comments } \| null` | `null` ⇒ the route answers 404. |
| `createThread` | yes | `{ thread; comment }` | **Must insert the thread and its opening comment atomically** — both commit or neither does. A thread without its first comment is a row the UI can't render. Use an interactive transaction (`db.transaction`, Prisma's `$transaction`) where your driver supports one; on an HTTP-only driver with no session (e.g. Neon's HTTP driver), a batched multi-statement call that the backend executes as one transaction also satisfies this. |
| `addComment` | yes | `ReviewCommentRow \| null` | Should also bump the parent thread's `updatedAt`. `null` ⇒ 404 (an id that fails UUID validation never even reaches this method — the route answers 404 before calling it). |
| `setStatus` | yes | `{ thread; comments } \| null` | Reopening must clear `resolvedAt`/`resolvedBy` regardless of the `resolvedBy` argument. |
| `putScreenshot` | optional | `(bytes: Uint8Array, contentType: string) => Promise<string>` | The returned key **must** match `` `${keyPrefix}/<safe-chars>.png` `` (default prefix `"review"`, configurable via `screenshot.keyPrefix`) or the client's follow-up `POST /threads` will reject it with 400 `bad_request` — this check exists so a reviewer can't point `screenshotKey` at an arbitrary object in your bucket. Omit to answer a clean 404 `screenshots_unsupported` on `POST /screenshot`. |
| `screenshotUrl` | optional | `(key: string) => string \| null \| Promise<string \| null>` | Compose a URL for a `putScreenshot` key (R2, S3, a CDN, a presigned-URL minter). **May be async** — see [below](#async-screenshoturl-private-buckets-and-presigned-links). Omit to always report `screenshotUrl: null`. |

`ReviewThreadRow`/`ReviewCommentRow` are **structural** interfaces (from
`@r3lab/web-review/server`'s `./serialize` re-export) — any ORM's row
satisfies them by shape; no concrete row type from this package is required.
`anchor`/`viewport` are typed `unknown` on both rows: they are opaque,
client-owned JSON (see [Database schema](https://github.com/R3-Lab/web-review/blob/main/docs/api.md#database-schema))
that a store must persist and return **verbatim**, never introspect.

### Async `screenshotUrl`: private buckets and presigned links

*New in 0.3.0.* `screenshotUrl`'s return type widened to
`string | null | Promise<string | null>`:

```ts
screenshotUrl?(key: string): string | null | Promise<string | null>;
```

A public CDN can be served by string concatenation, but a **private bucket
cannot**: it needs a presigned, expiring URL, and every SDK that mints one
(`@aws-sdk/s3-request-presigner`, R2, GCS) is asynchronous. The old sync-only
signature was therefore quietly incompatible with the safer and more common
setup, and pushed every consumer with a private bucket into the same
workaround — a redirector route that mints the presigned URL per request and
302s to it. Returning the promise straight from here deletes that whole
category of indirection:

```ts
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";

export const store: ReviewStore = {
  // ...the required five...
  async screenshotUrl(key) {
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
      expiresIn: 300,
    });
  },
};
```

**This is not a breaking change for implementers.** `screenshotUrl` is a
method consumers *implement* and this package *calls*, so variance runs the
helpful way: an existing synchronous implementation returning `string | null`
still satisfies `string | null | Promise<string | null>` and keeps compiling
untouched. Only this package's own call sites had to change.

Resolution happens in a pre-pass, once per response, before serialization
(`resolveScreenshotUrls` in
[`src/next/routes.ts`](https://github.com/R3-Lab/web-review/blob/main/packages/web-review/src/next/routes.ts)),
because `toThreadView` is a pure, synchronous row→wire mapper and is worth
keeping free of I/O. Three properties that pre-pass deliberately guarantees:

- **Parallel, never serial.** `GET /threads` returns up to 500 rows; awaiting
  each presigned URL in turn would turn one round trip into N sequential ones
  and make a real list unusable. `Promise.all` keeps the cost one round trip
  deep no matter how many rows come back.
- **Deduplicated by key.** Keys go through a `Set` first, so two threads
  sharing one screenshot cost one call rather than two. Not a special case
  bolted on: a key→URL map is what the lookup needs anyway, and distinct keys
  are what fills it.
- **Failure-isolated.** A key whose resolution throws or rejects becomes
  `null` for that thread alone; its siblings and the response as a whole are
  untouched. That matches the posture the write path already takes — a failed
  capture must never cost a reviewer their comment — so a misconfigured bucket
  costs a thumbnail, not a 500 on the reviewer's inbox. The `try` covers a
  synchronous `throw` as well as a rejected promise, since a sync
  implementation is still legal here.

Threads with no `screenshotKey` never reach `store.screenshotUrl` at all —
they're filtered out before the key set is built, so a store that would charge
for a lookup is never asked about a thread that has no screenshot. And
`screenshotUrl` is invoked as a *method* on `store` (never extracted into a
bare reference), so a class-based store implementation that reads `this` keeps
working.

If your presigned URLs are short-lived, note that they are minted per response
and travel in a `Cache-Control: no-store` payload — see the
[REST API](https://github.com/R3-Lab/web-review/blob/main/docs/api.md#rest-api).

## Drizzle table factories

`@r3lab/web-review/drizzle` exports factory functions —
`reviewThreadPg`/`reviewCommentPg` and `reviewThreadMysql`/`reviewCommentMysql`
— that mirror [the two tables](https://github.com/R3-Lab/web-review/blob/main/docs/api.md#database-schema)
column-for-column, so you can compose them into your own Drizzle schema
instead of hand-writing it. `drizzle-orm` is an optional peer: importing this
subpath is the only thing that pulls it in.

A worked `ReviewStore` built on these factories over `node-postgres` is
[step 2 of the Next.js quickstart](https://github.com/R3-Lab/web-review/blob/main/README.md#quickstart-nextjs).
