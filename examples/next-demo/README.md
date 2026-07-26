# @r3lab/web-review — Next.js + Postgres example

A minimal Next.js App Router app demonstrating `@r3lab/web-review` wired to a
real Postgres database through `@r3lab/web-review/drizzle`. It proves the
package resolves through its real `exports` map, survives an App Router
production build, and round-trips a thread through a genuine `ReviewStore`
implementation — nothing here is stubbed.

## What's here

- `docker-compose.yml` — Postgres on host port `55434` (container
  `r3wr-demo-postgres`, so it never collides with another project's database
  on this machine).
- `drizzle/schema.ts` — the demo's Drizzle schema, built from
  `@r3lab/web-review/drizzle`'s `reviewThreadPg`/`reviewCommentPg` table
  factories (not hand-written).
- `drizzle/client.ts` — a `node-postgres` pool + Drizzle client. `pg` is used
  deliberately (not an HTTP-only driver) so `createThread` can use a real
  interactive transaction.
- `lib/review-store.ts` — a `ReviewStore` implementation over that schema.
  `createThread` inserts the thread and its opening comment atomically in one
  transaction.
- `lib/review.ts` — the one `createReviewRouteHandlers` call, re-exported by
  every route file.
- `app/api/review/**` — the route handlers, wired exactly per the wiring
  example in `@r3lab/web-review/next`'s `routes.ts`.
- `app/layout.tsx` + `app/review-mount.tsx` — mounts the overlay and imports
  its stylesheet.
- `app/page.tsx` — a real demo page (hero, feature cards, a testimonial
  paragraph, CTA buttons, an image) with stable `id`/`data-testid`s on every
  pinnable element, substantial enough to drop a pin on an element or select
  text inside a paragraph.

Screenshot upload (`putScreenshot`/`screenshotUrl`) is intentionally **not**
implemented here — both are optional on `ReviewStore`, and the route factory
answers a clean 404 on `POST /screenshot` when they're absent. A real
deployment would implement `putScreenshot` against R2/S3/etc.

## Running it

1. **Install** (from the repo root):

   ```sh
   pnpm install
   pnpm -F @r3lab/web-review build   # builds dist/ so the workspace `exports` map resolves
   ```

2. **Start Postgres** (from this directory):

   ```sh
   docker compose up -d
   ```

3. **Configure env**:

   ```sh
   cp .env.example .env.local
   # edit REVIEW_PASSWORD / REVIEW_SECRET if you want something other than the placeholders
   ```

4. **Apply the schema** — the package's own `sql/postgres.sql` is the source
   of truth; this demo never hand-writes a competing schema:

   ```sh
   pnpm db:apply
   # runs scripts/apply-sql.mjs, which reads DATABASE_URL from .env.local
   # (pnpm scripts, unlike `next dev`/`next build`/`next start`, don't load
   # .env.local on their own) and then runs:
   #   psql "$DATABASE_URL" -f ../../packages/web-review/sql/postgres.sql
   ```

5. **Run it**:

   ```sh
   pnpm dev     # http://localhost:3000
   # or, to test a production build:
   pnpm build && pnpm start
   ```

   `pnpm build` needs `DATABASE_URL` set — `next build` loads `.env.local`
   itself and, unlike `dev`, evaluates every route handler module (including
   `drizzle/client.ts`, which throws immediately if `DATABASE_URL` is unset)
   while collecting page data. Postgres must already be up (step 2) and
   `.env.local` in place (step 3) before running `pnpm build`.

6. **Unlock the overlay** — with `NEXT_PUBLIC_REVIEW_ENABLED=1` (the
   `.env.example` default), the overlay's launcher button appears on the
   page. Click it and enter `REVIEW_PASSWORD`. Once unlocked, press `c` and
   click any element to drop a pin, or select a sentence in the testimonial
   paragraph.

7. **Tear down**:

   ```sh
   docker compose down
   docker volume rm r3wr_demo_pgdata   # optional: also drop the data
   ```

## End-to-end tests

`e2e/` holds a Playwright suite that drives a real Chromium browser against a
real build of this app and a real (throwaway) Postgres — no mocking. It
covers unlock, pin drop → composer → submit, persistence straight from
Postgres, a pin surviving a page reload re-anchored to the same element,
text-selection anchoring, reply/resolve, drift, and that the overlay costs
nothing (no DOM, no requests, chunk never fetched) when
`NEXT_PUBLIC_REVIEW_ENABLED` is unset at build time.

```sh
pnpm e2e   # from the repo root, or `pnpm -F next-demo e2e` from anywhere
```

This brings up its own uniquely-named, non-default-port Postgres container
(`r3wr-e2e-postgres` on `55499` — separate from the dev container above, so
both can run at once), applies `packages/web-review/sql/postgres.sql`,
builds and starts two Next.js servers (overlay enabled and disabled — the
env var is baked in at build time), runs the suite, and tears the container
down by name. It's a separate script from `pnpm -F @r3lab/web-review test`,
which stays fast and hermetic.

## Notes on the overlay wiring

`@r3lab/web-review/next/client`'s `ReviewOverlay` wires up default
`Composer`/`Panel`/`UnlockDialog` implementations the same way the
framework-agnostic `ReviewOverlay` exported from the package's main entry
does, so `config` is the only prop a consumer has to supply.
`app/review-mount.tsx` demonstrates the clean path:

```tsx
import { createHttpAdapter } from "@r3lab/web-review";
import { ReviewOverlay } from "@r3lab/web-review/next/client";

<ReviewOverlay config={{ adapter: createHttpAdapter() }} />;
```

Each surface stays individually overridable — pass `renderComposer` (or
`renderPanel` / `renderUnlockDialog`) to replace just that one surface with
your own component while the others stay stock:

```tsx
import { createHttpAdapter } from "@r3lab/web-review";
import { ReviewOverlay } from "@r3lab/web-review/next/client";
import { MyBrandedComposer } from "./my-branded-composer";

<ReviewOverlay
  config={{ adapter: createHttpAdapter() }}
  renderComposer={(props) => <MyBrandedComposer {...props} />}
/>;
```
