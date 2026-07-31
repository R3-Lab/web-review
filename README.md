# @r3lab/web-review

An in-page review overlay for React and Next.js apps: pin comments to any
DOM element of a preview deployment — bring your own database.

[![npm version](https://img.shields.io/npm/v/@r3lab/web-review.svg)](https://www.npmjs.com/package/@r3lab/web-review)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/R3-Lab/web-review/blob/main/LICENSE)
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
  works](https://github.com/R3-Lab/web-review/blob/main/docs/anchoring.md)).
- **Anchors that survive re-renders** — a layered anchor (selector, text
  hint, class fingerprint, ancestor path, geometry) rebinds after a markup
  change or a copy edit; when it can't rebind confidently, the pin still
  renders at its last known position, badged **drifted**, instead of
  disappearing.
- **Reading feedback and leaving it are separate acts** — the launcher opens
  the review panel and nothing else; picking a target is armed explicitly,
  from the panel's own **New comment** button or the `c` shortcut. A reviewer
  who only wants to read what's already on the page never lands in picking
  mode, with a crosshair cursor and a capture scrim swallowing every click.
- **A launcher that moves out of the way** — the Review button drags to any
  viewport edge and snaps to the nearest one on release (never mid-screen),
  stays where it was left across reloads, and takes the panel to whichever
  side keeps the button uncovered. Arrow keys dock it too, so dragging is
  never the only way to move it (WCAG 2.5.7). The bottom-right corner is
  contested ground on a real site — chat widgets, cookie banners — and a
  launcher you can't move is a launcher sitting on the thing you were asked
  to review.
- **No reviewer accounts** — a shared-password gate and a browser-minted
  identity stand in for a login; nothing to provision in your users table.
- **Postgres and MySQL, both** — idempotent SQL files for each dialect, plus
  Drizzle table factories if you'd rather compose than hand-write.
- **~6 KB main entry** — the overlay UI is a separate chunk, lazily loaded
  only once the feature is enabled (see [Bundle cost](#bundle-cost) for the
  full measurement, including a Turbopack caveat worth knowing about).

See it wired to a real Postgres database in
[`examples/next-demo`](https://github.com/R3-Lab/web-review/tree/main/examples/next-demo), a full Next.js App Router app
you can run yourself.

## Documentation

Everything needed to install, wire up, and ship the overlay is on this page.
The deeper material — the contracts you implement, the wire format, and the
reasoning behind each — lives in
[`docs/`](https://github.com/R3-Lab/web-review/tree/main/docs):

| Page | What's in it |
|---|---|
| [Bring your own storage](https://github.com/R3-Lab/web-review/blob/main/docs/storage.md) | The `ReviewAdapter` (client) and `ReviewStore` (server) contracts, async `screenshotUrl` for private buckets, and the Drizzle table factories |
| [REST API and database schema](https://github.com/R3-Lab/web-review/blob/main/docs/api.md) | Every endpoint, request body, and error code; the two tables in both dialects, and why MySQL's differ |
| [Auth model](https://github.com/R3-Lab/web-review/blob/main/docs/auth.md) | The shared-password gate and signed cookie, plus `requireReviewAccess` and `readCookieValue` for protecting your own routes |
| [Customizing a surface](https://github.com/R3-Lab/web-review/blob/main/docs/customizing.md) | Replacing or wrapping `Composer`/`Panel`/`ThreadDetail`/`UnlockDialog`, and the render-prop contracts they must satisfy |
| [How anchoring works](https://github.com/R3-Lab/web-review/blob/main/docs/anchoring.md) | Capture, resolve, confidence scoring, and what the **drifted** badge means |
| [Keyboard and accessibility](https://github.com/R3-Lab/web-review/blob/main/docs/keyboard.md) | `c`, arrow-key launcher docking, Escape's unwind order, focus traps, live regions |
| [Bundle cost: the full breakdown](https://github.com/R3-Lab/web-review/blob/main/docs/bundle-cost.md) | The measured forensics behind the [summary below](#bundle-cost) |

Release history: [CHANGELOG.md](https://github.com/R3-Lab/web-review/blob/main/CHANGELOG.md).

On this page: [Install](#install) · [Quickstart: Next.js](#quickstart-nextjs) ·
[Quickstart: plain React](#quickstart-plain-react) ·
[Configuration reference](#configuration-reference) · [Bundle cost](#bundle-cost) ·
[Example app, testing, CI](#example-app-testing-ci)

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

All five entry points — `.`, `/next`, `/next/client`, `/server` and
`/drizzle` — also export a `VERSION` string, for code that gates behaviour on
the package version without reaching for `package.json`. A test asserts it
equals `package.json`'s own `version` field from every one of those subpaths,
so it can't quietly go stale.

## Quickstart: Next.js

**1. Create the tables.** Run [`sql/postgres.sql`](https://github.com/R3-Lab/web-review/blob/main/packages/web-review/sql/postgres.sql)
(or [`sql/mysql.sql`](https://github.com/R3-Lab/web-review/blob/main/packages/web-review/sql/mysql.sql)) against your
database — every statement is idempotent, so it's safe to run as part of a
migration you already have.

**2. Implement a `ReviewStore`.** This example uses the package's own Drizzle
table factories over `node-postgres`; see [Bring your own storage](https://github.com/R3-Lab/web-review/blob/main/docs/storage.md)
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

For routes this factory does *not* provide — a screenshot redirector, a CSV
export, an admin-only sweep — `await review.requireAccess(req)` applies the
very same gate, already bound to the config above. See
[Auth model](https://github.com/R3-Lab/web-review/blob/main/docs/auth.md#protecting-your-own-routes-requirereviewaccess).

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

**5. Set the env vars** (see [Auth model](https://github.com/R3-Lab/web-review/blob/main/docs/auth.md) for what they do):

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
routes you wire up yourself (see [REST API](https://github.com/R3-Lab/web-review/blob/main/docs/api.md#rest-api) for the contract a
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

The server side is yours to wire up: implement the same
[REST contract](https://github.com/R3-Lab/web-review/blob/main/docs/api.md#rest-api)
on Express, Hono, Fastify or plain Node — `@r3lab/web-review/server` ships the
validators, serializers and auth helpers those routes need, with no React and
no Next in sight.

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

### localStorage keys

Three keys hang off `storagePrefix` — the reason it's configurable at all is
that two consumers on the same origin would otherwise share them. Every read
degrades to the default below on a missing, malformed, or unreadable value,
including when `localStorage` throws outright (Safari private mode), so all
three are safe to delete and safe to ignore:

| Key | Holds | Absent or unreadable |
|---|---|---|
| `` `${storagePrefix}.identity` `` | The browser-minted reviewer `{ id, name }` — see [Auth model](https://github.com/R3-Lab/web-review/blob/main/docs/auth.md) | No identity; the composer asks for a name |
| `` `${storagePrefix}.showHighlights` `` | `"1"`/`"0"`, the panel's **Highlights** checkbox | On |
| `` `${storagePrefix}.launcher` `` | `{"edge":"left"\|"right"\|"top"\|"bottom","offset":0..1}` — which viewport edge the launcher is docked against, and how far along that edge it sits | Bottom of the right edge |

The launcher's position is an edge plus a fraction rather than a pixel pair on
purpose: a fraction survives a viewport resize — or the same stored value
being read on a different machine — without ever putting the button
off-screen. An `offset` outside `0..1` is clamped rather than rejected, since
what "1.4" meant is unambiguous and discarding it would move a launcher
somebody deliberately parked.

## Bundle cost

Measured from a clean `pnpm -F @r3lab/web-review build` (tsup 8.5.1,
esbuild), ESM output, uncompressed:

```
ESM dist/index.js                  6.08 KB
ESM dist/next/client.js             1.86 KB
ESM dist/surfaces.js                0.45 KB   (Composer/Panel/ThreadDetail/UnlockDialog re-exports)
ESM dist/overlay-root-KYNT3AOQ.js  22.22 KB   (a separate chunk)
```

`dist/index.js` (the main entry) and `dist/next/client.js` (the Next mount)
each import a small shared loader (`loadWiredOverlayRoot`, ~1.75 KB, its own
chunk) that wires the default composer/panel/unlock-dialog surfaces onto
`OverlayRoot`. That loader's *own* imports of the ~22.7 KB overlay
implementation — `overlay-root-KYNT3AOQ.js` plus the small composer/panel/
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
directly: building [`examples/next-demo`](https://github.com/R3-Lab/web-review/tree/main/examples/next-demo) with
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

There is one more measured caveat, for consumers who import from the main `.`
entry under webpack: a *disabled* build's always-loaded JS still carries the
anchoring engine today, because of a chunk it shares with `createHttpAdapter`.
That, the fix that moved the four UI surfaces onto their own subpath, its root
cause in Next's client-reference handling, and the measured floor are all in
[Bundle cost: the full breakdown](https://github.com/R3-Lab/web-review/blob/main/docs/bundle-cost.md).

## Example app, testing, CI

[`examples/next-demo`](https://github.com/R3-Lab/web-review/tree/main/examples/next-demo) is a full Next.js App Router app
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

## License

MIT — see [LICENSE](https://github.com/R3-Lab/web-review/blob/main/LICENSE).
