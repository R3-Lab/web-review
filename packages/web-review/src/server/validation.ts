/**
 * Zod schemas for a review-route factory built on this package.
 *
 * Everything EXCEPT `anchor` / `viewport` is validated. Those two are
 * opaque, client-owned JSON (see `../core/types.ts`): they are checked to be
 * a JSON object and then passed through untouched. `z.custom` is used rather
 * than `z.record` precisely because it returns the ORIGINAL value — no
 * cloning, no key reordering, no chance of dropping a field the client
 * added.
 *
 * Generalized from a single-app reference implementation:
 *  - `locale` was a closed `["en", "tr"]` enum there; here it's a free-form,
 *    length-bounded string, since consumers define their own locale sets (or
 *    none at all — see `ReviewThreadView.locale` in `../core/types.ts`).
 *  - `category` was a closed 4-value enum there; here it's a bounded string,
 *    since categories are consumer-configurable via `ReviewConfig.categories`.
 *  - `status` stays a closed `["open", "resolved"]` enum — that one is
 *    genuinely binary regardless of consumer.
 *  - `screenshotKey` was a hardcoded `/^feedback\/.../ regex there; here it's
 *    a factory so the prefix isn't baked in — see `screenshotKeySchema`.
 */

import { z } from "zod";

/** Comment bodies are generous but bounded — 10k characters. */
export const MAX_COMMENT_BODY = 10_000;

/**
 * The package-wide bound for `urlKey`: the tightest limit across supported
 * backends. `sql/mysql.sql`'s `url_key varchar(512)` is that limit —
 * `url_key` takes part in the composite index `review_thread_page_idx
 * (project, url_key, status)`, and MySQL's indexable-byte budget caps it
 * there (see the derivation in that file's `url_key` comment). Postgres's
 * `url_key text` column could store more, but a key that validates and
 * inserts on one supported database while failing on another is worse than
 * a slightly tighter limit enforced everywhere, so this is the bound both
 * `newThreadSchema` and `listThreadsQuerySchema` validate against.
 *
 * `src/server/schema-limits.test.ts` parses `sql/mysql.sql` and asserts this
 * constant tracks the column's actual declared width, so the two cannot
 * silently drift apart again.
 */
export const MAX_URL_KEY = 512;

const jsonObject = z.custom<Record<string, unknown>>(
  (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  { message: "expected a JSON object" },
);

/** Free-form, bounded — consumers define their own locale sets (or none). */
const localeSchema = z.string().min(1).max(32);
/** Bounded string — categories are consumer-configurable, not a fixed set. */
const categorySchema = z.string().min(1).max(64);
const statusSchema = z.enum(["open", "resolved"]);

export const trimmedNonEmpty = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, { message: "must not be blank" });

/**
 * Screenshot keys must look like something a screenshot upload route
 * minted. Without this a reviewer could point `screenshotKey` at any object
 * in the consumer's bucket and have the API compose a public URL for it.
 *
 * The prefix can't be hardcoded in a general-purpose package, so this is a
 * factory rather than a fixed schema — a route factory (or a consumer
 * building its own routes) supplies its own storage-key prefix. `default`
 * below is `screenshotKeySchema()` with the package's own default prefix,
 * for consumers who don't need to override it.
 */
export function screenshotKeySchema(prefix = "review") {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return z
    .string()
    .max(256)
    .regex(new RegExp(`^${escapedPrefix}/[A-Za-z0-9._-]+\\.png$`), "not a review screenshot key");
}

const defaultScreenshotKeySchema = screenshotKeySchema();

export const unlockSchema = z.object({
  password: z.string().min(1).max(512),
});

export const newThreadSchema = z.object({
  project: z.string().min(1).max(64).optional(),
  url: trimmedNonEmpty(2048),
  urlKey: trimmedNonEmpty(MAX_URL_KEY),
  locale: localeSchema.nullable(),
  route: z.string().max(512).nullish(),
  title: z.string().max(200).nullish(),
  category: categorySchema,
  anchor: jsonObject,
  viewport: jsonObject.nullish(),
  authorId: trimmedNonEmpty(128),
  authorName: trimmedNonEmpty(120),
  firstComment: trimmedNonEmpty(MAX_COMMENT_BODY),
  screenshotKey: defaultScreenshotKeySchema.nullish(),
});

export const newCommentSchema = z.object({
  body: trimmedNonEmpty(MAX_COMMENT_BODY),
  authorId: trimmedNonEmpty(128),
  authorName: trimmedNonEmpty(120),
});

export const patchThreadSchema = z.object({
  status: statusSchema,
  resolvedBy: z.string().max(120).nullish(),
});

/** Query string for a `GET /threads`-style list route. */
export const listThreadsQuerySchema = z.object({
  urlKey: z.string().min(1).max(MAX_URL_KEY).optional(),
  project: z.string().min(1).max(64).optional(),
  status: z.enum(["open", "resolved", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

/** Path param for `[id]`-style routes. Malformed ids are treated as not-found. */
export const threadIdSchema = z.uuid();
