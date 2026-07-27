# @r3lab/web-review

An in-page review overlay for React and Next.js apps: pin comments to any
DOM element of a preview deployment — bring your own database.

[![npm version](https://img.shields.io/npm/v/@r3lab/web-review.svg)](https://www.npmjs.com/package/@r3lab/web-review)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/R3-Lab/web-review/actions/workflows/ci.yml/badge.svg)](https://github.com/R3-Lab/web-review/actions/workflows/ci.yml)

<img src="https://raw.githubusercontent.com/R3-Lab/web-review/main/docs/images/hero.png" width="1370" alt="Pins on a hero image, a feature card, and a testimonial highlight, with the triage panel open showing four threads across Design, Bug, and Copy, both open and resolved.">

**It ships no server and no database.** The client reaches your storage
through a `ReviewAdapter`; the optional Next.js route-handler factory reaches
it through a `ReviewStore` you implement — you own the schema, the queries,
and where the data lives. A reviewer on a preview deployment drops a pin on
any DOM element (or a text selection) and leaves a threaded comment; your
team triages from a side panel, no reviewer account required.

## Features

- **Text-selection anchoring** — select a run of text, not just an element,
  and the pin follows the exact words (see [How anchoring
  works](#how-anchoring-works)).
- **Anchors that survive re-renders** — a layered anchor (selector, text
  hint, class fingerprint, ancestor path, geometry) rebinds after a markup
  change or a copy edit; when it can't rebind confidently, the pin still
  renders at its last known position, badged **drifted**, instead of
  disappearing.
- **No reviewer accounts** — a shared-password gate and a browser-minted
  identity stand in for a login; nothing to provision in your users table.
- **Postgres and MySQL, both** — idempotent SQL files for each dialect, plus
  Drizzle table factories if you'd rather compose than hand-write.
- **~6 KB main entry** — the overlay UI is a separate chunk, lazily loaded
  only once the feature is enabled (see [Bundle cost](#bundle-cost) for the
  full measurement, including a Turbopack caveat worth knowing about).

See it wired to a real Postgres database in
[`examples/next-demo`](examples/next-demo), a full Next.js App Router app
you can run yourself.

## Contents

- [Install](#install)
- [Quickstart: Next.js](#quickstart-nextjs)
- [Quickstart: plain React](#quickstart-plain-react)
- [Customizing a surface](#customizing-a-surface)
- [Bring your own storage](#bring-your-own-storage)
- [REST API](#rest-api)
- [Database schema](#database-schema)
- [Configuration reference](#configuration-reference)
- [Auth model](#auth-model)
- [How anchoring works](#how-anchoring-works)
- [Bundle cost](#bundle-cost)
- [Keyboard and accessibility](#keyboard-and-accessibility)
- [Example app, testing, CI](#example-app-testing-ci)

## Install

```sh
npm install @r3lab/web-review
```

`react` and `react-dom` (>=18) are required peer dependencies. Three more are
optional peers — install only the ones you use:

| Package | Unlocks | Omit it and… |
|---|---|---|
| `next` (>=14) | `@r3lab/web-review/next` and `@r3lab/web-review/next/client` | those two subpaths are simply unused; nothing else is affected |
| `drizzle-orm` (>=0.30) | `@r3lab/web-review/drizzle` table factories | write your `ReviewStore` against raw SQL, Prisma, or anything else instead |
| `@zumer/snapdom` (>=2.12) | client-side screenshot capture on new threads | threads are still created, just without a screenshot — capture is loaded via a runtime `import()` only when a thread is actually submitted, and a failed import (not installed) is caught and treated the same as any other capture failure, so there's no build-time or hard runtime error either way |

## Quickstart: Next.js

**1. Create the tables.** Run [`sql/postgres.sql`](packages/web-review/sql/postgres.sql)
(or [`sql/mysql.sql`](packages/web-review/sql/mysql.sql)) against your
database — every statement is idempotent, so it's safe to run as part of a
migration you already have.

**2. Implement a `ReviewStore`.** This example uses the package's own Drizzle
table factories over `node-postgres`; see [Bring your own storage](#bring-your-own-storage)
for the interface if you'd rather hand-write the queries.

```ts
// lib/review-store.ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { reviewThreadPg, reviewCommentPg } from "@r3lab/web-review/drizzle";
import type { ReviewStore } from "@r3lab/web-review/next";
import type { Anchor, AnchorViewport } from "@r3lab/web-review/server";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const threads = reviewThreadPg();
const comments = reviewCommentPg(undefined, threads);

export const store: ReviewStore = {
  async listThreads({ project, urlKey, status, limit }) {
    const conditions = [eq(threads.project, project)];
    if (urlKey) conditions.push(eq(threads.urlKey, urlKey));
    if (status !== "all") conditions.push(eq(threads.status, status));

    return db
      .select({
        thread: threads,
        commentCount: sql<number>`count(${comments.id})`.mapWith(Number),
      })
      .from(threads)
      .leftJoin(comments, eq(comments.threadId, threads.id))
      .where(and(...conditions))
      .groupBy(threads.id)
      .orderBy(desc(threads.createdAt))
      .limit(limit);
  },

  async getThread(id) {
    const [thread] = await db.select().from(threads).where(eq(threads.id, id));
    if (!thread) return null;
    const rows = await db
      .select()
      .from(comments)
      .where(eq(comments.threadId, id))
      .orderBy(asc(comments.createdAt));
    return { thread, comments: rows };
  },

  async createThread(input) {
    return db.transaction(async (tx) => {
      const [thread] = await tx
        .insert(threads)
        .values({
          project: input.project,
          url: input.url,
          urlKey: input.urlKey,
          locale: input.locale,
          route: input.route,
          title: input.title,
          category: input.category,
          // Opaque, client-owned JSON — cast, never introspected.
          anchor: input.anchor as Anchor,
          viewport: input.viewport as AnchorViewport | null,
          authorId: input.authorId,
          authorName: input.authorName,
          screenshotKey: input.screenshotKey,
        })
        .returning();
      const [comment] = await tx
        .insert(comments)
        .values({
          threadId: thread!.id,
          body: input.firstComment,
          authorId: input.authorId,
          authorName: input.authorName,
        })
        .returning();
      return { thread: thread!, comment: comment! };
    });
  },

  async addComment(threadId, input) {
    const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
    if (!thread) return null;
    const [comment] = await db.insert(comments).values({ threadId, ...input }).returning();
    await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
    return comment ?? null;
  },

  async setStatus(threadId, status, resolvedBy) {
    const [thread] = await db
      .update(threads)
      .set({
        status,
        resolvedAt: status === "resolved" ? new Date() : null,
        resolvedBy: status === "resolved" ? resolvedBy : null,
        updatedAt: new Date(),
      })
      .where(eq(threads.id, threadId))
      .returning();
    if (!thread) return null;
    const rows = await db
      .select()
      .from(comments)
      .where(eq(comments.threadId, threadId))
      .orderBy(asc(comments.createdAt));
    return { thread, comments: rows };
  },
};
```

**3. Mount the route handlers.**

```ts
// lib/review.ts
import { createReviewRouteHandlers } from "@r3lab/web-review/next";
import { store } from "./review-store";

export const review = createReviewRouteHandlers({
  store,
  access: {
    password: process.env.REVIEW_PASSWORD,
    secret: process.env.REVIEW_SECRET,
  },
});
```

```ts
// app/api/review/unlock/route.ts
export const { POST } = review.unlock;

// app/api/review/threads/route.ts
export const { GET, POST } = review.threads;

// app/api/review/threads/[id]/route.ts
export const { GET, PATCH } = review.thread;

// app/api/review/threads/[id]/comments/route.ts
export const { POST } = review.comments;

// app/api/review/screenshot/route.ts
export const { POST } = review.screenshot;
```

**4. Mount the overlay and import the stylesheet.**

```tsx
// app/review-mount.tsx
"use client";
import { createHttpAdapter } from "@r3lab/web-review";
import { ReviewOverlay } from "@r3lab/web-review/next/client";

export function ReviewMount() {
  return <ReviewOverlay config={{ adapter: createHttpAdapter() }} />;
}
```

```tsx
// app/layout.tsx
import type { ReactNode } from "react";
import "@r3lab/web-review/styles.css";
import { ReviewMount } from "./review-mount";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ReviewMount />
      </body>
    </html>
  );
}
```

**5. Set the env vars** (see [Auth model](#auth-model) for what they do):

```sh
REVIEW_PASSWORD=something-your-reviewers-share
REVIEW_SECRET=a-long-random-string
NEXT_PUBLIC_REVIEW_ENABLED=1
```

With `NEXT_PUBLIC_REVIEW_ENABLED` unset (e.g. in production), none of this
code runs — see [Bundle cost](#bundle-cost).

## Quickstart: plain React

Not on Next.js? Use the framework-agnostic `ReviewOverlay` from the package's
main entry with the built-in `createHttpAdapter`, pointed at whatever REST
routes you wire up yourself (see [REST API](#rest-api) for the contract a
route factory or a hand-rolled backend must satisfy):

```tsx
// src/App.tsx
import { createHttpAdapter, ReviewOverlay } from "@r3lab/web-review";
import "@r3lab/web-review/styles.css";

export function App() {
  return (
    <>
      {/* ...the rest of your app... */}
      <ReviewOverlay
        config={{
          adapter: createHttpAdapter({ baseUrl: "/api/review" }),
          enabled: true,
        }}
      />
    </>
  );
}
```

## Customizing a surface

`ReviewOverlay` is the only mount point this package exports as a value.
`OverlayRoot` (its internal shell) is exported as **types only**
(`OverlayRootProps`, `ComposerRenderProps`, `PanelRenderProps`,
`UnlockRenderProps`, `ShotState`) — `import { OverlayRoot }` will not
compile, deliberately: `ReviewOverlay` owns the mount gate and the lazy-load
boundary (see [Bundle cost](#bundle-cost)), and there's no supported way to
render the shell outside of it.

The four default UI surfaces — `Composer`, `Panel`, `ThreadDetail`,
`UnlockDialog` — **are** exported as values, so you can replace just one and
keep the rest stock via `renderComposer`/`renderPanel`/`renderUnlockDialog`:

<img src="https://raw.githubusercontent.com/R3-Lab/web-review/main/docs/images/composer.png" width="493" alt="The default Composer surface: a category picker for Design, Copy, Bug, and Other, plus title, comment, and name fields.">

*The stock `Composer` — one of the four default surfaces you can replace
individually via a `render*` prop.*

```tsx
import { createHttpAdapter, ReviewOverlay } from "@r3lab/web-review";
import { MyBrandedComposer } from "./my-branded-composer";

<ReviewOverlay
  config={{ adapter: createHttpAdapter() }}
  renderComposer={(props) => <MyBrandedComposer {...props} />}
/>;
```

`props` is typed `ComposerRenderProps` (or `PanelRenderProps` /
`UnlockRenderProps` for the other two) — import the type to build a
component against the exact contract `OverlayRoot` calls it with. A
replaced surface receives the **same** props `OverlayRoot` passes the stock
one — the same `onSubmit`/`onCancel` for the composer, `onReply`/
`onToggleStatus`/`onSelect`/`onClose` for the panel, `onUnlocked`/`onClose`
for the unlock dialog. A custom surface has to call those to actually drive
the overlay's state machine; skip them and you get a form that looks right
and does nothing — creating a thread, replying, or resolving only happens
because the render prop was invoked, not because the surface merely rendered.

## Bring your own storage

This is the constraint the whole package is built around: implement one of
these two interfaces (both built on the wire contract in `core/types.ts`)
and everything else — the overlay UI, anchoring, threading — works against
your database.

### Client side: `ReviewAdapter`

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

### Server side: `ReviewStore`

What `createReviewRouteHandlers` (`@r3lab/web-review/next`) calls. This is
the interface to implement against Prisma, raw `pg`/`mysql2`, or anything
else — the Drizzle example in the [Next.js quickstart](#quickstart-nextjs)
above is one concrete implementation of it.

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
| `screenshotUrl` | optional | `(key: string) => string \| null` | Compose a public URL (R2, S3, a CDN, a signed-URL minter) from a `putScreenshot` key. Omit to always report `screenshotUrl: null`. |

`ReviewThreadRow`/`ReviewCommentRow` are **structural** interfaces (from
`@r3lab/web-review/server`'s `./serialize` re-export) — any ORM's row
satisfies them by shape; no concrete row type from this package is required.
`anchor`/`viewport` are typed `unknown` on both rows: they are opaque,
client-owned JSON (see [Database schema](#database-schema)) that a store
must persist and return **verbatim**, never introspect.

## REST API

The contract `createHttpAdapter` (client) and `createReviewRouteHandlers`
(server) agree on — cross-checked directly against
[`src/client/http-adapter.ts`](packages/web-review/src/client/http-adapter.ts)
and [`src/next/routes.ts`](packages/web-review/src/next/routes.ts). `{base}`
defaults to `/api/review`.

| Method | Path | Body | Success | Error codes |
|---|---|---|---|---|
| `POST` | `{base}/unlock` | `{ password }` | 200 `{ ok: true }`, sets the access cookie | 400 `bad_request` · 401 `invalid_password` · 429 `too_many_attempts` (with `Retry-After`) · 404 `feature_disabled` if the feature is off |
| `GET` | `{base}/threads?urlKey=&status=&project=&limit=` | — | 200 `{ threads }` | 400 `bad_request` · 400 `url_key_required` (non-admin caller omitted `urlKey`) · 401 `locked` · 404 `feature_disabled` |
| `POST` | `{base}/threads` | `NewThreadInput` | 201 `{ thread }` | 400 `bad_request` · 401 `locked` · 404 `feature_disabled` |
| `GET` | `{base}/threads/:id` | — | 200 `{ thread }` | 401 `locked` · 404 `feature_disabled` (kill switch) · 404 `not_found` (`id` doesn't exist, or fails UUID validation) |
| `PATCH` | `{base}/threads/:id` | `{ status, resolvedBy? }` | 200 `{ thread }` | 400 `bad_request` · 401 `locked` · 404 `feature_disabled` (kill switch) · 404 `not_found` (`id` doesn't exist, or fails UUID validation) |
| `POST` | `{base}/threads/:id/comments` | `NewCommentInput` | 201 `{ comment }` | 400 `bad_request` · 401 `locked` · 404 `feature_disabled` (kill switch) · 404 `not_found` (`id` doesn't exist, or fails UUID validation) |
| `POST` | `{base}/screenshot` | `FormData` (field `file`) | 201 `{ key }` | 400 `invalid_form`/`no_file`/`not_a_png`/`too_large`/`too_small` · 401 `locked` · 404 `feature_disabled` (kill switch) · 404 `screenshots_unsupported` (`putScreenshot` isn't implemented) |

Every response carries `Cache-Control: no-store` and
`X-Robots-Tag: noindex, nofollow, noarchive`.

Every 404 this API returns carries one of three codes, each meaning a
different thing:

- **`feature_disabled`** — the kill switch is off (no password/secret
  configured). Every route 404s this way, including for an admin
  `isAdmin` would otherwise let in — there is deliberately no open
  fallback. This is the ONLY code `isFeatureDisabled()` (status 404 + code
  `feature_disabled`) recognizes; it's what tells the overlay there is
  nothing to unlock and to render nothing at all.
- **`not_found`** — the request named a thread that doesn't exist, or an
  `id` that fails UUID validation (deliberately answered 404 rather than
  400, so a malformed id and a missing row look the same to a caller). A
  perfectly ordinary condition, not a sign the feature is off.
- **`screenshots_unsupported`** — `POST /screenshot` was called but the
  `ReviewStore` never implemented `putScreenshot`.

Because these are distinguishable, a custom `ReviewAdapter` (or a caller
building its own client against this API) can safely call `getThread(badId)`
and check `isFeatureDisabled()` on the result — it correctly returns
`false`, since that 404 carries `not_found`, not `feature_disabled`.

## Database schema

Both dialects live under [`sql/`](packages/web-review/sql) — paste one into
a migration and run it top-to-bottom; every statement is idempotent. Two
tables: `review_thread` (one row per pinned comment thread) and
`review_comment` (one row per reply, including the thread's opening
comment).

| Column | Postgres | MySQL | Notes |
|---|---|---|---|
| `id` | `uuid default gen_random_uuid()` | `char(36) default (uuid())` | MySQL has no native UUID type. |
| `project` | `text default 'web'` | `varchar(64) default 'web'` | Bounded on MySQL — see `url_key` below. |
| `url` | `text` | `text` | Raw href at drop time. |
| `url_key` | `text` | `varchar(512)` | See the byte-budget note below. |
| `locale`, `route`, `title` | `text` | `text` | Free-form; `NULL` allowed. |
| `category` | `text default 'other'` | `varchar(64) default 'other'` | Bounded on MySQL because it carries a literal `DEFAULT` (disallowed on `TEXT` before MySQL 8.0.13). |
| `anchor` | `jsonb not null` | `json not null` | Opaque — see below. |
| `viewport` | `jsonb` | `json` | Opaque — see below. |
| `status` | `text default 'open'` + `CHECK` | `varchar(20) default 'open'` + `CHECK` | Genuinely binary (`open`/`resolved`), unlike `category`. |
| `author_id`, `author_name` | `text` | `text` | Not a foreign key — see below. |
| `screenshot_key` | `text` | `text` | `NULL` when no screenshot. |
| `created_at`, `updated_at` | `timestamptz default now()` | `datetime(3) default current_timestamp(3)` | See the UTC note below. |
| `resolved_at` | `timestamptz` | `datetime(3)` | |
| `resolved_by` | `text` | `text` | |

Indexes: `review_thread_page_idx (project, url_key, status)` (the overlay's
per-page query), `review_thread_created_at_idx (created_at)` (the triage
inbox's default sort), and `review_comment_thread_idx (thread_id, created_at)`.
`review_comment.thread_id` is a foreign key to `review_thread.id` with
`on delete cascade`.

**Two deliberate design decisions:**

1. **Author identity is not a foreign key.** `author_id`/`author_name` hold a
   browser-minted id (localStorage), not a row in your users table.
   Reviewers on a preview deployment are stakeholders leaving feedback, not
   accounts on your product — requiring a login is how internal review tools
   die from friction. Access is gated at the API edge instead (see
   [Auth model](#auth-model)).
2. **`anchor`/`viewport` are opaque.** Their shape is owned by the client
   (`Anchor`/`AnchorViewport` in `core/types.ts`), not by this schema, so the
   anchoring strategy can evolve — a new selector heuristic, a new highlight
   kind — with no migration. Application code must store and return these
   columns verbatim and must never introspect their contents.

**MySQL divergences**, each forced by a real constraint (not a mechanical
translation of the Postgres file):

- **`char(36)` ids**, not `uuid` — MySQL has no native UUID column type, and
  the alternative (`binary(16)`) would need `UUID_TO_BIN()`/`BIN_TO_UUID()`
  at every boundary for a storage saving that doesn't matter at review-tool
  scale.
- **`json`, not `jsonb`** — MySQL has one JSON type. It normalizes stored
  values (key order/whitespace not preserved byte-for-byte) the same way
  Postgres's `jsonb` does; the opacity invariant above is about never
  interpreting the value, so this holds identically under either type.
- **`datetime(3)` with a UTC session requirement**, not `timestamptz` —
  MySQL's `timestamp` type silently converts to/from the session `time_zone`
  on every read and write (and stops working in 2038, even on MySQL 8).
  `datetime` does neither, but it also doesn't *enforce* UTC — it stores
  whatever it's handed. Run the schema, and every application write, with
  `time_zone` set to UTC.
- **`url_key varchar(512)`**, not unbounded `text` — `url_key` takes part in
  the composite index `review_thread_page_idx`, and MySQL can't index a
  `TEXT` column without a lossy prefix length. InnoDB's default row format
  allows 3072 index bytes total, and `utf8mb4` spends up to 4 bytes/char:
  `(64 + url_key_chars + 20) * 4 <= 3072` puts the ceiling at 684 characters
  for `url_key`; 512 is chosen with headroom under that ceiling. This is
  also why `MAX_URL_KEY` in the request validator (`src/server/validation.ts`)
  is 512 and not larger — a key that validates and inserts on one supported
  database while failing on the other would be worse than one tighter bound
  enforced everywhere. A test (`schema-limits.test.ts`) parses `sql/mysql.sql`
  to keep that constant and the column width from drifting apart.

`@r3lab/web-review/drizzle` exports factory functions —
`reviewThreadPg`/`reviewCommentPg` and `reviewThreadMysql`/`reviewCommentMysql`
— that mirror these tables column-for-column, so you can compose them into
your own Drizzle schema instead of hand-writing it. `drizzle-orm` is an
optional peer: importing this subpath is the only thing that pulls it in.

## Configuration reference

`adapter` is the only required field on `ReviewConfig`. Everything else is
filled in by `resolveConfig` — defaults below are read directly from its
source (`src/core/config.ts`):

| Field | Default | Source |
|---|---|---|
| `project` | `"web"` | `config.project ?? "web"` |
| `categories` | `DEFAULT_CATEGORIES` (`design`, `copy`, `bug`, `other`) | `config.categories ?? DEFAULT_CATEGORIES` |
| `storagePrefix` | `"r3wr"` | `config.storagePrefix ?? "r3wr"` |
| `screenshots` | `true`, **unless** `adapter.uploadScreenshot` is absent | `(config.screenshots ?? true) && config.adapter.uploadScreenshot != null` — an explicit `false` always wins, even if the adapter can upload |
| `localeFromHref` | `() => null` | `config.localeFromHref ?? (() => null)` |
| `urlKeyFromHref` | the package's own `normalizeUrl` | `config.urlKeyFromHref ?? normalizeUrl` |
| `requireUnlock` | `true` iff `adapter.unlock` is present | `config.requireUnlock ?? config.adapter.unlock != null` |
| `enabled` | `undefined` (left to the mount gate) | `config.enabled` — passthrough, not defaulted |
| `debug` | `false` | `config.debug ?? false` |

## Auth model

<img src="https://raw.githubusercontent.com/R3-Lab/web-review/main/docs/images/unlock.png" width="378" alt="The shared-password unlock dialog, with the locked Review launcher behind it.">

*A reviewer unlocks with the shared password — there's no account to
create.*

A shared-password gate, not per-reviewer accounts — see the [database
schema](#database-schema) note on why. A successful `POST /unlock` mints a
signed, `httpOnly` cookie (`sameSite: "lax"`, `secure` on by default when
`NODE_ENV=production`, 7-day expiry baked into the signature so a reviewer
can't extend it by editing the cookie).

- **Fail-closed kill switch.** The feature is off unless *both*
  `REVIEW_PASSWORD` and a signing secret are set — missing either takes
  every route (including for a caller your own `isAdmin` predicate would
  otherwise admit) to 404. There is deliberately no open fallback.
- **Domain-separated, password-bound signing key.** The cookie isn't signed
  with the raw secret; the HMAC key is derived from the secret plus a
  fixed, package-specific domain string plus a hash of the current password.
  Domain separation means a signing oracle here can't forge other session
  data you sign with the same secret. Password binding means rotating
  `REVIEW_PASSWORD` invalidates every outstanding cookie.
- **Optional admin bypass.** Pass `isAdmin` to `createReviewRouteHandlers`
  to let your own authenticated admins in without the shared password. It's
  checked only after the signed cookie fails (so the common reviewer path
  costs zero extra lookups), and a predicate that throws is treated as "not
  admin" rather than a 500.
- **Rate limiting is per-process.** The built-in unlock limiter (10 attempts
  per 10 minutes per IP, by default) is a plain in-memory `Map` — there's no
  shared store (no Redis, no KV). On serverless/edge, a distributed attacker
  hitting several warm instances gets the full attempt budget on *each*, and
  the counter resets on cold start. It stops a naive single-client brute
  force, which is the realistic threat for a shared password on a preview
  deployment; if this guards anything more valuable, swap in a shared store.

## How anchoring works

<img src="https://raw.githubusercontent.com/R3-Lab/web-review/main/docs/images/text-anchor.png" width="892" alt="The word 'unlimited' highlighted with its pin — the anchor follows an exact text selection, not just an element.">

*Text-selection anchoring: the pin follows the exact words, not just the
element that contains them.*

Capture, at pin-drop, records a **layered** anchor, not just a selector: a
CSS selector (id or `data-testid` preferred, else a `:nth-of-type` path from
the nearest stable ancestor), a text hint (first 120 characters of
`innerText`), a stable subset of class names (hashed/utility/Tailwind-ish
classes filtered out), an 8-hop ancestor tag path, a document-coordinate
rect, and a viewport snapshot.

Resolve, on every render, tries the exact selector first — a unique match is
confidence `1`. Otherwise a weighted fuzzy scorer runs over same-tag
candidates (text-hint similarity 0.4, class overlap 0.2, ancestor-path
overlap 0.25, scaled rect proximity 0.15) and picks the best score. At or
above a confidence threshold of `0.5` it's a confident bind; below that, the
pin still renders — at its last known rect, badged **drifted** — rather than
being dropped or silently misplaced.

Drift happens: a copy edit, a markup refactor, a class-name change can all
push a pin below the threshold. The badge is the signal, not a bug — there's
no anchoring strategy that survives an arbitrary rewrite of the page.

`normalizeUrl` (the default `urlKeyFromHref`) deliberately does **not** strip
a locale path prefix — `/about` and `/tr/hakkimizda` are different pages
with independently-written copy, and a pin on one locale's wording should
never surface on another's.

## Bundle cost

Measured from a clean `pnpm -F @r3lab/web-review build` (tsup 8.5.1,
esbuild), ESM output, uncompressed:

```
ESM dist/index.js                  6.32 KB
ESM dist/next/client.js             1.86 KB
ESM dist/overlay-root-AKHEQ576.js  22.19 KB   (a separate chunk)
```

`dist/index.js` (the main entry) and `dist/next/client.js` (the Next mount)
each import a small shared loader (`loadWiredOverlayRoot`, ~1.75 KB, its own
chunk) that wires the default composer/panel/unlock-dialog surfaces onto
`OverlayRoot`. That loader's *own* imports of the ~22.7 KB overlay
implementation — `overlay-root-AKHEQ576.js` plus the small composer/panel/
unlock-dialog chunks — sit inside the loader's async function body, reached
through `React.lazy` (main entry) or `next/dynamic` (Next entry). Confirmed
directly against the build output: neither `dist/index.js` nor
`dist/next/client.js` contains a static `import(...)` call or any reference
to the overlay chunk's filename — grep for both comes back empty.

What that means in practice: `<ReviewOverlay config={...} enabled={false} />`
(or the gate closed any other way — see [Configuration reference](#configuration-reference))
renders `null` before the lazy component is ever reached, so its `import()`
never fires and the overlay's module code never executes — no DOM, no
request to `/api/review/*`, no event handlers. Only the entry's own few KB
(which includes `resolveConfig` and the gate logic) ever runs.

**Caveat, measured on Next.js + Turbopack:** that is a guarantee about
*execution*, not about *download*. Next.js's Turbopack production builds
(the default for plain `next build`, no flag needed, as of Next 16) pre-fetch
a route's entire async-import chunk graph as unconditional `<script async>`
tags in the initial HTML — including `next/dynamic`/`React.lazy` boundaries
whose runtime gate is closed, since Turbopack decides this at build time
from static reachability, with no visibility into the gate. Measured
directly: building [`examples/next-demo`](examples/next-demo) with
`NEXT_PUBLIC_REVIEW_ENABLED` unset, the overlay's ~36 KB chunk still appears
in the page's initial `<script async>` list under Turbopack, but is absent
from it under `next build --webpack`. This is not an artifact of this
package's own build — the same result reproduces importing the package
straight from source instead of its built `dist/`, and setting
`transpilePackages` on the consumer's `next.config` makes no difference
either. There is no documented Turbopack option to exempt one boundary from
this; the only confirmed way to avoid the extra download today is `next
build --webpack` for the consuming app.

What stays true either way — confirmed against a real Turbopack build by
this package's own E2E suite — is that the module never *runs*: no overlay
DOM node ever appears, and no request to `/api/review/*` is ever made (which
`OverlayRoot` would trigger from a `useEffect` on mount, immediately, if its
code ever actually executed). The chunk's bytes can be downloaded without
its code ever being called.

**Caveat, main-entry importers (webpack, measured — not tested under
Turbopack):** what actually ends up in a *disabled* build's always-loaded
JS breaks into three pieces, with three different deferral stories:

1. **The anchoring engine (`captureAnchor`/`resolveAnchor`/`buildSelector`/
   `scoreCandidate`/…, ~22 KB)** — genuinely deferred under `next build
   --webpack`; downloaded-but-not-executed under Turbopack (the caveat
   above).
2. **The default UI surfaces (`Composer`/`Panel`/`ThreadDetail`/
   `UnlockDialog`, ~10–16 KB combined)** — deferred *only* for a consumer who
   imports exclusively from `@r3lab/web-review/next/client`. Measured
   directly: a diagnostic build importing `ReviewOverlay` from
   `@r3lab/web-review/next/client` alone, with `createHttpAdapter` swapped
   for an inline stub (so nothing else touches the main `.` entry), produces
   a 5,906-byte disabled-variant layout chunk with zero occurrences of
   `data-r3-review`. As soon as anything else is imported from the main `.`
   entry alongside `ReviewOverlay` — and this package's own [demo
   app](examples/next-demo) does exactly that, importing `createHttpAdapter`
   from it — these four surfaces are pulled in eagerly too, because each one
   imports `OVERLAY_ATTR` directly to mark its own DOM, and they're exported
   as values from that same main entry on purpose (see [Customizing a
   surface](#customizing-a-surface)). This was only measured under webpack;
   don't assume the Turbopack story is the same.
3. **`resolveConfig` and `normalizeUrl` (~900 bytes)** — always eager, by
   design: the mount gate itself calls `resolveConfig` before it knows
   whether it's on, so this much has to run regardless. `normalizeUrl` used
   to drag the entire anchoring engine in with it (piece 1) because it lived
   inside `anchor.ts`; it now lives in its own `src/normalize-url.ts`,
   re-exported from `anchor.ts` so the public API is unchanged. Verified
   directly: `dist/next/client.js`'s own static import graph (`next/dynamic`
   excluded) is 3 files, ~4.6 KB total, zero occurrences of `data-r3-review`.

Net effect measured on the demo app's disabled variant, `next build
--webpack`: the `resolveConfig` fix (piece 3) is real and independently
verified, but the demo's own `app/layout-*.js` didn't shrink from it —
15,977 bytes before, 15,987 bytes after, `data-r3-review` present both
times — because piece 2 dominates and isn't touched by that fix. If
minimizing the disabled-state cost matters to you: import `ReviewOverlay`
*only* from `@r3lab/web-review/next/client`, and construct your adapter
(`createHttpAdapter` or your own) from a module that doesn't also import
anything else off the main `.` entry. Piece 2 is tracked as a follow-up,
not fixed here.

## Keyboard and accessibility

- **`c`** toggles pin-drop mode (ignored while a form field has focus, and
  ignored with any modifier key held).
- **Escape** unwinds one layer at a time, in this order: an open unlock
  dialog, then pin-drop mode, then an open draft composer, then the thread
  panel.
- The composer, thread panel, and unlock dialog each run a **focus trap**
  (`useFocusTrap`) — Tab cycles within the open surface, and focus returns
  to whatever had it before on close (only if that element is still in the
  document). It's a *soft* trap: the keydown listener lives on the
  container, not `document`, so a mouse click elsewhere on the page still
  frees the reviewer — the right shape for a side panel read alongside the
  host page.
- A polite ARIA live region (`role="status" aria-live="polite"`) announces
  pin-drop mode changes, pin drops, saved feedback, replies, and
  resolve/reopen actions.

## Example app, testing, CI

[`examples/next-demo`](examples/next-demo) is a full Next.js App Router app
wired to a real Postgres database through `@r3lab/web-review/drizzle` — it
resolves the package through its actual `exports` map, survives a production
build, and round-trips a thread through a genuine `ReviewStore`. See its own
README for how to run it.

From the repo root: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`
run the package's build, its Vitest suite, `tsc --noEmit`, and ESLint,
respectively.

A GitHub Actions workflow (`.github/workflows/ci.yml`) is configured to run
typecheck, lint, build, and the test suite on Node 20 and 22, plus two
further jobs that apply `sql/postgres.sql` and `sql/mysql.sql` twice each
against real Postgres 16 / MySQL 8 service containers, asserting both tables
exist after each run — the second run is what actually proves the DDL is
idempotent rather than just documenting the claim. That workflow has not yet
been exercised on GitHub's own runners.
