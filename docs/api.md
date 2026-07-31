# REST API and database schema

**Part of [`@r3lab/web-review`](https://github.com/R3-Lab/web-review/blob/main/README.md)** — an
in-page review overlay for React and Next.js apps that ships no server and no
database. This page is the wire and the storage layer: the HTTP contract the
built-in client and the built-in Next.js route factory agree on, and the two
tables that hold the data. You need the first half if you're hand-rolling a
backend (or a client), and the second half whichever way you go. If you landed
here from a search engine, the
[README](https://github.com/R3-Lab/web-review/blob/main/README.md) is where the
package is introduced and mounted.

**On this page:** [REST API](#rest-api) · [Request bodies](#request-bodies) ·
[Error codes](#the-three-404s) · [Database schema](#database-schema)

---

## REST API

The contract `createHttpAdapter` (client) and `createReviewRouteHandlers`
(server) agree on — cross-checked directly against
[`src/client/http-adapter.ts`](https://github.com/R3-Lab/web-review/blob/main/packages/web-review/src/client/http-adapter.ts)
and [`src/next/routes.ts`](https://github.com/R3-Lab/web-review/blob/main/packages/web-review/src/next/routes.ts). `{base}`
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

### Request bodies

Validated by the Zod schemas in
[`src/server/validation.ts`](https://github.com/R3-Lab/web-review/blob/main/packages/web-review/src/server/validation.ts);
a failure is a 400 `bad_request`. Every string field is length-bounded, and
the ones marked *non-blank* are trimmed and then rejected if nothing is left.

**`NewThreadInput`** (`POST {base}/threads`):

| Field | Required | Shape |
|---|---|---|
| `project` | optional | 1–64 chars. Falls back to the route factory's `project` option (default `"default"`). |
| `url` | yes | Non-blank, ≤ 2048 chars. The raw `href` at drop time. |
| `urlKey` | yes | Non-blank, ≤ 512 chars — `MAX_URL_KEY`, the tightest bound across both supported engines (see [MySQL divergences](#mysql-divergences)). |
| `locale` | optional | 1–32 chars, or `null`, **or absent entirely**. |
| `route` | optional | ≤ 512 chars, or `null`, or absent. |
| `title` | optional | ≤ 200 chars, or `null`, or absent. |
| `category` | yes | 1–64 chars. Free-form, because categories are consumer-configurable via `ReviewConfig.categories` — not a closed enum. |
| `anchor` | yes | A JSON object, passed through untouched. Opaque — see [below](#two-deliberate-design-decisions). |
| `viewport` | optional | A JSON object, or `null`, or absent. Opaque, same as `anchor`. |
| `authorId` | yes | Non-blank, ≤ 128 chars. Browser-minted, **not verified** — see [below](#two-deliberate-design-decisions). |
| `authorName` | yes | Non-blank, ≤ 120 chars. |
| `firstComment` | yes | Non-blank, ≤ 10,000 chars (`MAX_COMMENT_BODY`). |
| `screenshotKey` | optional | `` `${keyPrefix}/<safe-chars>.png` ``, ≤ 256 chars, or `null`, or absent. Anything else is a 400 — that check is what stops a reviewer pointing this at an arbitrary object in your bucket. |

`locale` being omissible is **new in 0.3.0**. It used to be `.nullable()`,
which accepts `null` but still *requires the key to be present*, so a consumer
whose site has no notion of locale had to send `locale: null` on every create
— while `route`, `title` and `screenshotKey`, equally optional, could simply
be left out. That asymmetry was an oversight rather than a rule: nothing
downstream distinguishes "absent" from "explicitly null". The column is
nullable on both supported engines and `ReviewThreadView.locale` is
`string | null`, so both spellings describe the same thread. An omitted key
parses to `undefined`, not `null`, and the two are collapsed at the storage
boundary (`locale: input.locale ?? null` in `POST /threads`), so `undefined`
never reaches a store, a row, or the wire. Existing clients that send
`locale: null` are unaffected.

**`NewCommentInput`** (`POST {base}/threads/:id/comments`): `body` (non-blank,
≤ 10,000), `authorId` (non-blank, ≤ 128), `authorName` (non-blank, ≤ 120).

**`PATCH {base}/threads/:id`**: `status` (`"open"` or `"resolved"` — a closed
enum, unlike `category`) and an optional `resolvedBy` (≤ 120 chars, `null`, or
absent). `resolvedBy` is trimmed to `null` by the route handler when blank, or
whenever `status` is `"open"`.

### The three 404s

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

Both dialects live under [`sql/`](https://github.com/R3-Lab/web-review/tree/main/packages/web-review/sql) — paste one into
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

### Two deliberate design decisions

1. **Author identity is not a foreign key.** `author_id`/`author_name` hold a
   browser-minted id (localStorage), not a row in your users table.
   Reviewers on a preview deployment are stakeholders leaving feedback, not
   accounts on your product — requiring a login is how internal review tools
   die from friction. Access is gated at the API edge instead (see
   [Auth model](https://github.com/R3-Lab/web-review/blob/main/docs/auth.md)).
2. **`anchor`/`viewport` are opaque.** Their shape is owned by the client
   (`Anchor`/`AnchorViewport` in `core/types.ts`), not by this schema, so the
   anchoring strategy can evolve — a new selector heuristic, a new highlight
   kind — with no migration. Application code must store and return these
   columns verbatim and must never introspect their contents.

### MySQL divergences

Each forced by a real constraint (not a mechanical translation of the
Postgres file):

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

Rather than hand-write these tables in your ORM, you can compose the package's
own [Drizzle table factories](https://github.com/R3-Lab/web-review/blob/main/docs/storage.md#drizzle-table-factories),
which mirror them column-for-column.
