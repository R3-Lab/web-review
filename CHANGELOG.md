# Changelog

All notable changes to `@r3lab/web-review` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Newest first.

**This package is pre-1.0.** Under 0.x semver a *minor* bump may carry breaking
changes, and one already has (0.2.0). Read the entry before upgrading; pin an
exact version if you cannot.

Every entry states whether the release touched the **database schema** (the DDL
in `sql/*` and the Drizzle table factories) and the **store/adapter interface**
(`ReviewStore` and friends in `@r3lab/web-review/next`), because those are the
two things that cost an integrator real work.

---

## [0.3.0] — 2026-07-31

**Schema: no change.** **Store interface: changed — widened, non-breaking for
implementers.** No export subpath, dependency, or peer-dependency range changed.

### Added

- `requireReviewAccess(req, options)` — the access gate the route factory runs,
  as a standalone export from `@r3lab/web-review/server`, for protecting routes
  this package does not provide (a screenshot redirector, a CSV export, an
  admin sweep). Takes a Web `Request`, returns a verdict, never a `Response`.
  Fail-closed: an unset password or secret ends the call at `feature_disabled`
  before `isAdmin` is consulted. `src/server/access.ts:413`
- `ReviewRouteHandlers.requireAccess` — the same guard, already bound to the
  factory's `access` config and `isAdmin` predicate, so there is no second copy
  of the password/secret/prefix triple to keep in sync.
  `src/next/routes.ts:447` (type), `src/next/routes.ts:844` (wiring)
- `readCookieValue(header, name)` — cookie parser for a raw `Cookie` header
  string, exported because the Web Fetch `Request` has no structured cookie jar
  and every consumer protecting an auxiliary route hits the same wall. Splits
  each pair at its first `=` only. `src/server/access.ts:222`
- Types: `RequestAccessVerdict` (`src/server/access.ts:344`),
  `AccessDenialReason` (`:354`), `ReviewAccessOptions` (`:82`),
  `RequireAccessOptions` (`:364`). `RequestAccessVerdict` and
  `ReviewAccessOptions` are re-exported from `@r3lab/web-review/next` so the
  route factory's signatures are nameable from that subpath alone.
  `src/next/routes.ts:109`

### Changed

- **`ReviewStore.screenshotUrl` may now return a promise:**
  `(key: string) => string | null | Promise<string | null>`.
  `src/next/routes.ts:340`

  **Not breaking for implementers.** It is a method you implement and this
  package calls, so variance runs the helpful way — an existing synchronous
  `string | null` implementation still satisfies the wider type and compiles
  untouched. The motivation is private buckets: every SDK that mints a
  presigned URL is asynchronous, so the old sync-only signature forced a
  redirector route on anyone not serving screenshots from a public CDN.

- Screenshot URLs are now resolved in one pass per response rather than once
  per thread inside the serializer. `src/next/routes.ts:559`. Three
  consumer-visible consequences:
  - **Parallel, not serial** — `GET /threads` returns up to 500 rows; they
    resolve via `Promise.all` rather than sequentially.
  - **Deduplicated** — keys go through a `Set`, so two threads sharing one
    screenshot cost one `screenshotUrl` call, not two. Threads with no
    `screenshotKey` never reach the store at all.
  - **Failure-isolated** — a throw or rejection now yields `screenshotUrl:
    null` for that one thread. Previously it propagated and failed the whole
    response.

- `newThreadSchema.locale` relaxed from `.nullable()` to `.nullish()`, so the
  key may be omitted rather than sent as an explicit `locale: null`.
  `src/server/validation.ts:108`. This is a relaxation — payloads that were
  valid before are still valid. Stores are unaffected:
  `ReviewStoreCreateThreadInput.locale` remains `string | null`
  (`src/next/routes.ts:175`) and the route collapses an omitted key to `null`
  at the storage boundary (`src/next/routes.ts:710`), so `undefined` never
  reaches a store, a row, or the wire.

- `CreateReviewRouteHandlersOptions.access` is now typed as the named
  `ReviewAccessOptions` instead of an inline object literal
  (`src/next/routes.ts:362`). Structurally identical; the point is that the
  same object can be handed to `requireReviewAccess`.

### Fixed

- **`VERSION` was stale.** All five entry points exported the literal `"0.1.0"`
  for the entire life of the 0.2.0 release, so anything gating on the package
  version got a confidently wrong answer. The value now lives in one place
  (`src/version.ts:44`) and the entry points re-export it:
  `src/index.ts:43`, `src/next/index.ts:38`, `src/next/client.tsx:258`,
  `src/server/index.ts:26`, `src/drizzle/index.ts:38`. `src/version.test.ts`
  asserts it equals `package.json`'s `version` field and that all five entries
  agree, so drift fails a test instead of shipping.

---

## [0.2.0] — 2026-07-31

**Schema: no change.** **Store interface: no change.** This release touched only
`src/overlay/*` and `package.json` — no `sql/*`, no `src/drizzle/*`, no
`src/server/*`, no `src/next/routes.ts`. Export subpaths, dependencies, and peer
ranges are unchanged from 0.1.0. Server-side integration code needs no edit.

### ⚠️ BREAKING — custom overlay surfaces

`PanelRenderProps` gains `panelSide`, `pinDropMode`, and `onTogglePinDrop`.
`ComposerRenderProps` gains `panelSide`. All are required members.

The failure modes are asymmetric, and the compiler only catches one of them:

- Code that **constructs** either object stops compiling. Loud, easy fix.
- A `renderPanel` / `renderComposer` callback that only **destructures** the old
  members still type-checks — and this is the dangerous half. It compiles
  clean, then leaves reviewers with no way to start a comment, because the
  launcher no longer arms pin-drop mode (see below) and a custom panel has no
  control that calls `onTogglePinDrop`.

**If you pass `renderPanel`, you must add a control that calls
`onTogglePinDrop`.** Nothing will tell you otherwise until a reviewer reports
that they cannot leave feedback. Consumers using the default surfaces from
`@r3lab/web-review/surfaces` are unaffected.

### Changed

- **The launcher opens the panel and nothing else.** It previously opened the
  side panel *and* armed pin-drop mode in one click, so a reviewer who only
  wanted to read existing feedback was put into picking mode as well —
  crosshair cursor, capture scrim, every click on the host page swallowed.
  Arming is now explicit: the panel's "New comment" control, or the `c`
  shortcut.
- **`c` arms and disarms pin-drop mode only** — it no longer opens the panel.
  The same separation, pointing the other way. `src/overlay/overlay-root.tsx:576`
- Submitting feedback still opens the panel on the thread just created. That is
  the one place the two remain coupled, deliberately.
- The panel docks to whichever side keeps the launcher uncovered, rather than
  always right.

### Added

- **Draggable launcher.** No longer nailed to the bottom-right corner, which on
  a real site is contested ground (chat widgets, cookie banners). Drags to any
  viewport edge and snaps to the nearest on release. Position persists in
  `localStorage` under `<prefix>.launcher`
  (`src/overlay/launcher-position.ts:95`) and is stored as an edge plus a 0..1
  fraction rather than a pixel pair, so it survives a resize without landing
  off-screen.
- **Arrow-key docking** — WCAG 2.5.7 requires a non-drag path to anything a
  drag can do. `src/overlay/launcher-position.ts:321`
- **"New comment" control** in the panel, now that the launcher no longer arms
  picking. `src/overlay/panel.tsx:149`
- **Keyboard shortcuts strip**, pinned outside the panel's scrolling body in
  both list and detail views — the overlay's keyboard paths became
  undiscoverable once the launcher's label stopped advertising `c`.
  `src/overlay/panel.tsx:275`
- New internal modules `launcher.tsx`, `launcher-position.ts`, and
  `panel-geometry.ts`. The last hoists `.r3wr-panel`'s geometry out of the
  stylesheet and `composer.tsx`, which had been duplicating it.

### Fixed

- **The README now ships inside the published tarball.** `0.1.0` on npm
  contains only `LICENSE` — the README lived at the repo root and was never
  copied into the package directory, so the npm page was blank.
  `prepublishOnly` now copies it. This was version-bumped as `0.1.1`
  (`9a6f2ed`) but **never published**; the fix first reached the registry here.
  See the note below.
- The launcher sat on top of the new shortcuts strip in the default
  configuration (bottom-right launcher, right-docked 384px panel), swallowing
  text a reviewer has to read. It now steps clear of an open dock.

### A note on 0.1.1

`0.1.1` exists in this repository's history — `package.json` was bumped at
`9a6f2ed` — but **it was never published and cannot be installed.** npm has only
`0.1.0` and `0.2.0`. Its single change (shipping the README in the tarball) is
listed above under 0.2.0, which is the release that actually delivered it. It
gets no heading of its own precisely so that it does not read like something a
consumer could have had.

Commits: `9a6f2ed`, `060816e`.

---

## [0.1.0] — 2026-07-27

Initial public release. **Establishes the schema and the store interface**;
neither has changed in any release since.

### Added

- **Client overlay** — `ReviewOverlay` mount gate (renders nothing until
  switched on; the shell lazy-loads behind it), pins, thread highlights, anchor
  drift handling, pin-drop mode, and polling.
- **Overlay surfaces** — composer, panel, thread detail, and unlock dialog,
  wired in as `ReviewOverlay`'s defaults and also exported as values from
  `@r3lab/web-review/surfaces`. The separate subpath exists because Next's
  webpack integration forces the full export list of any `"use client"` file
  into a consumer's client bundle regardless of what is used.
- **DOM anchoring engine** — element and text-range anchors, with resolution
  and drift detection.
- **Screenshot capture** via `@zumer/snapdom` (peer dependency).
- **Next.js App Router integration** — `createReviewRouteHandlers` route
  factory (`unlock`, `threads`, `thread`, `comments`, `screenshot`) and a
  client mount at `@r3lab/web-review/next/client`.
- **Server kit**, framework-agnostic and free of `next/server` imports: Zod
  validators, row→wire serializers, HMAC-signed access cookie, unlock rate
  limiter, and PNG validation.
- **Access model** — a shared reviewer password plus an HMAC-signed cookie,
  with an optional consumer-supplied `isAdmin` predicate. A kill switch: an
  unset password or secret takes every route to 404 `feature_disabled`,
  including for a caller `isAdmin` would otherwise admit. There is deliberately
  no open fallback, and `feature_disabled` is 404 rather than 403 so a
  deployment with the tool off is indistinguishable from one that never shipped
  it.
- **Database schema** — Postgres and MySQL DDL at `@r3lab/web-review/sql/*`
  (`review_thread`, `review_comment`, and their indexes) and Drizzle table
  factories at `@r3lab/web-review/drizzle`. Bring your own database; this
  package never opens a connection.
- **Entry points**: `.`, `./next`, `./next/client`, `./server`, `./drizzle`,
  `./surfaces`, `./styles.css`, `./sql/*`.

### Known issues in this release

Both were fixed later; recorded here because they are what a consumer of 0.1.0
actually encountered.

- The published tarball contains no README (fixed in 0.2.0).
- Every entry point's `VERSION` export reads `"0.1.0"` — correct here by
  coincidence, but it was not updated for 0.2.0 either (fixed in 0.3.0).

Commit: `609b91b`.

<!-- Each heading above links to the diff that produced that release. 0.1.0 has
     no predecessor to compare against, so it points at the tag itself. -->

[0.3.0]: https://github.com/R3-Lab/web-review/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/R3-Lab/web-review/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/R3-Lab/web-review/releases/tag/v0.1.0
