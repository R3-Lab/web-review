-- @r3lab/web-review — MySQL schema (MySQL 8.0+)
--
-- Same logical schema as sql/postgres.sql: `review_thread` (one row per
-- pinned comment thread) and `review_comment` (one row per reply, including
-- the thread's opening comment). This is NOT a mechanical translation of
-- the Postgres file — every divergence below is a real MySQL constraint or
-- behavioral difference, called out where it happens. Paste this into a
-- migration and run it top-to-bottom on a clean database.
--
-- Idempotency: MySQL has no `CREATE INDEX IF NOT EXISTS` (unlike Postgres),
-- so every index and constraint here is declared INLINE inside
-- `CREATE TABLE IF NOT EXISTS` rather than as a separate statement — the
-- whole table, indexes included, is skipped on a second run once it
-- exists, which is what actually makes this file safe to run twice.
--
-- Session requirement: run this file, and all application writes, with
-- `time_zone` set to UTC (`SET time_zone = '+00:00';`, or configure it
-- server-wide / on the connection pool). See the `datetime` note below for
-- why this matters.
--
-- See src/core/types.ts for the corresponding TypeScript wire contract
-- (`ReviewThreadView`, `ReviewCommentView`) that these tables serialize to.
--
-- ─── Two design decisions worth reading before you extend this ───────────
-- Carried over unchanged from sql/postgres.sql — see that file for the full
-- rationale:
--
-- 1. AUTHOR IDENTITY IS NOT A FOREIGN KEY. `author_id` / `author_name` hold
--    a browser-minted reviewer id (localStorage), not a row in this
--    database. Access is gated at the API edge by a shared password, not by
--    a users table.
--
-- 2. `anchor` / `viewport` ARE OPAQUE. Their shape is owned by the client;
--    application code MUST store and return these columns verbatim and
--    must never introspect their contents.

-- ─── review_thread ─────────────────────────────────────────────────────────
create table if not exists review_thread (
  -- DIVERGENCE — no native UUID type. CHAR(36) stores the canonical
  -- 8-4-4-4-12 hex string form (e.g. "3fa85f64-5717-4562-b3fc-2c963f66afa6"),
  -- the same shape the wire contract (`ReviewThreadView.id: string`) and
  -- the Postgres column already use. The alternative, BINARY(16), is half
  -- the storage and a smaller/faster secondary-index footprint, but every
  -- query, log line, and admin tool then needs UUID_TO_BIN()/BIN_TO_UUID()
  -- at the boundary, and ids stop being directly comparable across the two
  -- engines' driver output without a conversion step. This package
  -- optimizes for "a consumer can paste this in and never think about it
  -- again" over the storage/index savings, which don't matter at
  -- review-tool scale — hence CHAR(36).
  --
  -- Default `(uuid())` mirrors Postgres's `gen_random_uuid()` default so a
  -- bare INSERT with no `id` still works (verified against a live MySQL 8
  -- container — see the package's WP8 report). The application is equally
  -- free to generate its own id (e.g. `crypto.randomUUID()`) and pass it
  -- explicitly, which is what the Drizzle factories' inferred insert type
  -- expects when a caller wants a known id before the row exists. Note
  -- MySQL's `UUID()` returns a version-1 (timestamp-based) UUID, not a
  -- version-4 random one like `gen_random_uuid()` — both are valid, opaque
  -- 36-character ids to every consumer of this table, and nothing in this
  -- package or its wire contract distinguishes UUID versions.
  id char(36) not null default (uuid()) primary key,

  -- Bounded (unlike the Postgres `text`) because it takes part in the
  -- composite index below, and MySQL sums each indexed column's maximum
  -- byte width against a single 3072-byte budget — see the `url_key` note
  -- for the full accounting. 64 characters is generous for a namespace
  -- slug and leaves the overwhelming majority of that budget for `url_key`.
  project varchar(64) not null default 'web',

  -- Full raw href at drop time. Unbounded and unindexed, so plain TEXT —
  -- none of the divergences below apply to it.
  url text not null,

  -- DIVERGENCE — index key length. `url_key` is indexed as part of the
  -- composite `review_thread_page_idx` below, and MySQL cannot index a
  -- TEXT/BLOB column at all without an explicit prefix length, which would
  -- make the index lossy (two distinct long keys sharing a prefix would
  -- collide). A bounded VARCHAR sidesteps that instead: it's fully
  -- indexable, at the cost of rejecting inserts whose key exceeds the
  -- bound.
  --
  -- The bound itself is set by MySQL's per-index byte budget: InnoDB's
  -- default DYNAMIC row format (with `innodb_large_prefix`, on since 5.7)
  -- allows up to 3072 index bytes total, and utf8mb4 spends up to 4 bytes
  -- per character. `review_thread_page_idx` covers `project` (64 chars),
  -- `url_key`, and `status` (20 chars) together, so the whole composite key
  -- must fit: (64 + url_key_chars + 20) * 4 <= 3072, i.e. url_key_chars <=
  -- 684. 512 is chosen well under that ceiling to leave headroom for
  -- InnoDB's internal per-column length-prefix overhead (verified against
  -- a live MySQL 8 container — see the package's WP8 report) while still
  -- comfortably covering a realistic path+query page key. A consumer whose
  -- `url_key`s can legitimately exceed 512 characters should hash it into a
  -- fixed-width column instead of widening this one, since widening it
  -- much further risks the 3072-byte ceiling on this composite index.
  url_key varchar(512) not null,

  -- Nullable, no default, unindexed — plain TEXT is unrestricted here even
  -- on MySQL 8.0.0 (the literal-default restriction below only applies to
  -- columns that declare a literal DEFAULT).
  locale text,
  route text,
  title text,

  -- Bounded (unlike the Postgres `text`) only because it carries a literal
  -- DEFAULT: MySQL disallows literal defaults on TEXT/BLOB columns before
  -- 8.0.13, and this file targets "MySQL 8.0+" without assuming a specific
  -- patch release. Same free-text, no-CHECK reasoning as postgres.sql:
  -- categories are consumer-configurable via `ReviewConfig.categories`, so
  -- constraining the value set here would force a migration every time a
  -- consumer adds one.
  category varchar(64) not null default 'other',

  -- DIVERGENCE — `json`, not `jsonb`. MySQL has one JSON type; there is no
  -- separate binary variant to choose between. Like Postgres's `jsonb`
  -- (and unlike Postgres's plain `json`), MySQL's JSON type parses the
  -- input and stores a normalized internal representation: key order and
  -- exact whitespace are not preserved byte-for-byte, and numbers may be
  -- reformatted. That's irrelevant to the opacity invariant (design note 2
  -- above), which is about application code never interpreting the
  -- *value* — not about preserving the original bytes — so the invariant
  -- holds identically under `json` here and `jsonb` in Postgres.
  anchor json not null,
  viewport json,

  -- Bounded for the same reason as `category` above (literal DEFAULT) and
  -- because it's part of the composite index below — TEXT could not be a
  -- full index key either way. Still CHECK-constrained: genuinely binary,
  -- same as Postgres. MySQL parses CHECK constraints starting at 8.0.0 but
  -- only enforces them starting at 8.0.16 (verified: rejected on a live
  -- MySQL 8 container — see the package's WP8 report); on 8.0.0-8.0.15 this
  -- constraint is accepted but silently not enforced.
  status varchar(20) not null default 'open',

  -- Browser-minted reviewer identity — see design note 1 above. Plain
  -- TEXT, not a foreign key, not indexed, no literal default.
  author_id text not null,
  author_name text not null,

  -- Object storage key for the drop-time screenshot. NULL when capture
  -- failed or was disabled — screenshot capture is best-effort and must
  -- never block thread submission.
  screenshot_key text,

  -- DIVERGENCE — no `timestamptz`. MySQL's TIMESTAMP type stores UTC
  -- internally but converts to/from the session `time_zone` on every write
  -- and read — exactly the kind of implicit, connection-dependent
  -- behavior this package wants to avoid — and it also stops working in
  -- 2038 (4-byte epoch, even on MySQL 8). DATETIME has neither problem: it
  -- stores the literal value with no timezone conversion, ever, and has no
  -- 2038 ceiling. The tradeoff is that DATETIME does nothing to *enforce*
  -- UTC — it stores whatever it's handed, which is why this file's header
  -- requires the session `time_zone` to be UTC: application code writing
  -- `new Date().toISOString()`-derived values and MySQL's own
  -- `CURRENT_TIMESTAMP` then agree on what "now" means. `(3)` is
  -- millisecond precision, matching the wire contract's ISO-8601
  -- `created_at`/`updated_at` strings (`Date.prototype.toISOString()`).
  created_at datetime(3) not null default current_timestamp(3),
  updated_at datetime(3) not null default current_timestamp(3),
  resolved_at datetime(3),
  resolved_by text,

  constraint review_thread_status_check check (status in ('open', 'resolved')),

  -- The overlay's per-page query: threads for this page, filtered by
  -- status. See the `url_key` note above for why each column here is
  -- bounded the way it is.
  key review_thread_page_idx (project, url_key, status),
  -- The triage inbox's default sort (newest first).
  key review_thread_created_at_idx (created_at)
) engine = innodb default charset = utf8mb4 collate = utf8mb4_0900_ai_ci;

-- ─── review_comment ─────────────────────────────────────────────────────────
-- One row per reply on a thread, including the thread's opening comment
-- (`NewThreadInput.firstComment`).
create table if not exists review_comment (
  id char(36) not null default (uuid()) primary key,

  -- Must match `review_thread.id`'s type, charset, and collation exactly —
  -- MySQL requires that for a foreign key to be creatable at all.
  thread_id char(36) not null,

  body text not null,

  -- Same browser-minted identity as `review_thread.author_id` — see design
  -- note 1 above. Not a foreign key here either.
  author_id text not null,
  author_name text not null,

  created_at datetime(3) not null default current_timestamp(3),

  constraint review_comment_thread_id_fkey
    foreign key (thread_id) references review_thread (id) on delete cascade,

  -- A thread's comments, oldest first — the shape `getThread` returns them
  -- in.
  key review_comment_thread_idx (thread_id, created_at)
) engine = innodb default charset = utf8mb4 collate = utf8mb4_0900_ai_ci;
