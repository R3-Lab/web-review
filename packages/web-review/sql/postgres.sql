-- @r3lab/web-review — PostgreSQL schema
--
-- Two tables: `review_thread` (one row per pinned comment thread) and
-- `review_comment` (one row per reply on a thread, including the thread's
-- opening comment). Paste this into a migration and run it top-to-bottom on
-- a clean database — every statement is idempotent, so running the whole
-- file a second time is a no-op.
--
-- Requires PostgreSQL 13+, for `gen_random_uuid()`: it has been part of core
-- since PG13, no `pgcrypto`/`uuid-ossp` extension needed. On an older
-- Postgres, run `create extension if not exists pgcrypto;` before this file
-- — pgcrypto ships the same function, so nothing below has to change.
--
-- See src/core/types.ts for the corresponding TypeScript wire contract
-- (`ReviewThreadView`, `ReviewCommentView`) that these tables serialize to.
--
-- ─── Two design decisions worth reading before you extend this ───────────
--
-- 1. AUTHOR IDENTITY IS NOT A FOREIGN KEY. `author_id` / `author_name` on
--    both tables are plain text holding a stable id minted in the
--    reviewer's own browser (localStorage) — see `ReviewerIdentity` in the
--    client. Reviewers are stakeholders leaving feedback on a preview
--    deployment, not users of the product; requiring them to hold an
--    account in this database is how internal review tools die from
--    friction. Access is instead gated at the API edge by a shared password
--    (see `ReviewAdapter.unlock`), not by a users table.
--
-- 2. `anchor` / `viewport` ARE OPAQUE. Their shape is owned by the client
--    (`Anchor` / `AnchorViewport` in types.ts), not by this schema, so the
--    DOM-anchoring strategy can evolve — a new selector heuristic, a new
--    highlight kind — with no migration here. Application code MUST store
--    and return these columns verbatim and must never introspect their
--    contents.

-- ─── review_thread ─────────────────────────────────────────────────────────
-- One row per pinned comment thread.
create table if not exists review_thread (
  id uuid primary key default gen_random_uuid(),

  -- Which surface the pin was dropped on. Namespaces threads when one
  -- deployment/database serves more than one app or tool sharing this
  -- schema. Default 'web' covers the common single-app case with zero
  -- configuration.
  project text not null default 'web',

  -- The raw href at drop time (origin + path + query + hash), kept verbatim
  -- so the triage UI can link straight back to the reviewed page.
  url text not null,

  -- Normalized grouping key the overlay queries by — typically the pathname
  -- with the query/hash stripped, computed by `ReviewConfig.urlKeyFromHref`.
  -- Deliberately NOT required to strip a locale prefix: a localized site's
  -- /en/page and /fr/page carry different copy and should collect separate
  -- threads, so a consumer's `urlKeyFromHref` is expected to keep it.
  url_key text not null,

  -- Free-form locale of the page the reviewer was reading, or NULL when the
  -- consuming site has no notion of locale. The tool this package was
  -- generalized from hard-coded a closed `en`/`tr` union; every consumer of
  -- this package has its own locale set (or none), so this is unconstrained
  -- text instead of an enum/CHECK.
  locale text,

  -- Optional route pattern (e.g. "/products/[slug]") when the client can
  -- derive one; NULL when it can't.
  route text,

  -- Thread title. NULL until the client (or the consumer's admin UI)
  -- derives one, typically from the opening comment's body.
  title text,

  -- The thread's category id (e.g. "design", "copy", "bug"). Free-form text
  -- rather than a CHECK-constrained enum: categories are consumer-defined
  -- via `ReviewConfig.categories`, so a CHECK here would force a schema
  -- migration every time a consumer adds or renames one. The default
  -- 'other' matches `DEFAULT_CATEGORIES` in types.ts.
  category text not null default 'other',

  -- Opaque, client-owned anchor payload — see design note 2 above. NOT
  -- NULL: every thread is pinned to something, even a bare-click "point"
  -- anchor with no highlight.
  anchor jsonb not null,

  -- Opaque, client-owned viewport snapshot at drop time — see design note 2
  -- above. Nullable: capture can be skipped without blocking thread
  -- creation.
  viewport jsonb,

  -- Lifecycle state. Unlike `category`/`locale` above, this genuinely is a
  -- closed 2-value set — it drives the per-page index below and the
  -- overlay's default "open" filter — so it stays a real CHECK constraint
  -- rather than free text.
  status text not null default 'open',

  -- Browser-minted reviewer identity — see design note 1 above. Plain text,
  -- not a foreign key.
  author_id text not null,
  author_name text not null,

  -- Object storage key for the drop-time screenshot; the public URL is
  -- composed at read time from wherever the consumer's storage config
  -- points. NULL when capture failed or was disabled — screenshot capture
  -- is best-effort and must never block thread submission.
  screenshot_key text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,

  constraint review_thread_status_check check (status in ('open', 'resolved'))
);

-- The overlay's per-page query: threads for this page, filtered by status.
create index if not exists review_thread_page_idx
  on review_thread (project, url_key, status);

-- The triage inbox's default sort (newest first).
create index if not exists review_thread_created_at_idx
  on review_thread (created_at);

-- ─── review_comment ─────────────────────────────────────────────────────────
-- One row per reply on a thread, including the thread's opening comment
-- (`NewThreadInput.firstComment`).
create table if not exists review_comment (
  id uuid primary key default gen_random_uuid(),

  thread_id uuid not null,

  body text not null,

  -- Same browser-minted identity as `review_thread.author_id` — see design
  -- note 1 above. Not a foreign key here either.
  author_id text not null,
  author_name text not null,

  created_at timestamptz not null default now(),

  constraint review_comment_thread_id_fkey
    foreign key (thread_id) references review_thread (id) on delete cascade
);

-- A thread's comments, oldest first — the shape `getThread` returns them in.
create index if not exists review_comment_thread_idx
  on review_comment (thread_id, created_at);
