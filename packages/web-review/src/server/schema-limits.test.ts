/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_URL_KEY, listThreadsQuerySchema, newThreadSchema } from "./validation";

/**
 * Regression test for the `urlKey` bug: `newThreadSchema`/`listThreadsQuerySchema`
 * used to cap `urlKey` at 1024 characters while `sql/mysql.sql`'s indexed
 * `url_key varchar(512)` column could only ever store 512 — a key in the
 * 513-1024 range validated and inserted successfully on Postgres (`url_key
 * text`, unbounded) but failed on MySQL with a data-too-long error. See
 * `MAX_URL_KEY`'s doc comment in `./validation.ts` and the `url_key` note in
 * `sql/mysql.sql` for the full story.
 *
 * This file doesn't just assert `MAX_URL_KEY === 512` — a hardcoded number
 * would happily keep passing even if `sql/mysql.sql`'s column width changed
 * out from under it. Instead it parses `sql/mysql.sql` for the column's
 * *actual* declared width and checks the validators' behavior against that
 * parsed value, so a change to either side without the other breaks this
 * test. Reuses the same hand-rolled parsing approach as
 * `../drizzle/schema.test.ts` (comment-stripping, brace-depth-aware table
 * body extraction) — see that file for why a hand-rolled parser is
 * appropriate here rather than a general SQL parser.
 */

/** Drop `-- ...` line comments before any structural parsing. */
function stripSqlComments(sqlText: string): string {
  return sqlText
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/** Split on top-level commas only — commas inside `(...)` don't split. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Everything between a `create table if not exists <name> (` and its matching `)`. */
function extractTableBody(ddl: string, tableName: string): string {
  const marker = `create table if not exists ${tableName} (`;
  const start = ddl.indexOf(marker);
  if (start === -1) {
    throw new Error(`table "${tableName}" not found via marker "${marker}"`);
  }
  let idx = start + marker.length;
  let depth = 1;
  const bodyStart = idx;
  while (depth > 0) {
    const ch = ddl[idx];
    if (ch === undefined) {
      throw new Error(`unterminated table body for "${tableName}"`);
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    idx++;
  }
  return ddl.slice(bodyStart, idx - 1);
}

/**
 * Declared character bound per column, keyed by column name — `512` for
 * `url_key varchar(512)`, `36` for `id char(36)`, and `null` for an
 * unbounded `text` column (or for a non-column entry, e.g. a `constraint`
 * or `key` line, which isn't included at all).
 */
function parseColumnBounds(ddl: string, tableName: string): Record<string, number | null> {
  const entries = splitTopLevel(extractTableBody(ddl, tableName));
  const bounds: Record<string, number | null> = {};

  for (const raw of entries) {
    const entry = raw.replace(/\s+/g, " ").trim();
    const lower = entry.toLowerCase();
    if (lower.startsWith("constraint") || /^key\s+/i.test(entry)) continue;

    const columnMatch = /^(\S+)\s+(.+)$/s.exec(entry);
    if (!columnMatch) continue;
    const name = columnMatch[1];
    const rest = columnMatch[2];
    if (name === undefined || rest === undefined) continue;

    const boundMatch = /^(?:varchar|char)\((\d+)\)/i.exec(rest.trim());
    bounds[name] = boundMatch?.[1] !== undefined ? Number(boundMatch[1]) : null;
  }

  return bounds;
}

// Same resolution strategy as ../drizzle/schema.test.ts: relative to the
// package root, where `pnpm test` (and thus `process.cwd()`) runs.
const mysqlSql = readFileSync(join(process.cwd(), "sql/mysql.sql"), "utf8");
const mysqlDdl = stripSqlComments(mysqlSql);
const threadBounds = parseColumnBounds(mysqlDdl, "review_thread");

describe("validator caps track sql/mysql.sql column widths (url_key)", () => {
  const parsedBound = threadBounds["url_key"];

  it("sql/mysql.sql still declares url_key as a bounded varchar", () => {
    // Fails loudly (rather than silently skipping the rest) if url_key ever
    // becomes unbounded text or the column is renamed out from under this
    // parser.
    expect(parsedBound).not.toBeNull();
  });

  it("MAX_URL_KEY equals url_key's parsed varchar bound", () => {
    expect(MAX_URL_KEY).toBe(parsedBound);
  });

  it("newThreadSchema.urlKey accepts exactly the parsed bound and rejects one more", () => {
    const bound = parsedBound;
    if (bound === null || bound === undefined) throw new Error("url_key bound not parsed");

    const atBound = {
      url: "https://example.com/",
      urlKey: "a".repeat(bound),
      locale: "en",
      category: "bug",
      anchor: { selector: "#x" },
      authorId: "user-1",
      authorName: "Ada",
      firstComment: "hello",
    };
    expect(newThreadSchema.safeParse(atBound).success).toBe(true);
    expect(
      newThreadSchema.safeParse({ ...atBound, urlKey: "a".repeat(bound + 1) }).success,
    ).toBe(false);
  });

  it("listThreadsQuerySchema.urlKey accepts exactly the parsed bound and rejects one more", () => {
    const bound = parsedBound;
    if (bound === null || bound === undefined) throw new Error("url_key bound not parsed");

    expect(listThreadsQuerySchema.safeParse({ urlKey: "a".repeat(bound) }).success).toBe(true);
    expect(
      listThreadsQuerySchema.safeParse({ urlKey: "a".repeat(bound + 1) }).success,
    ).toBe(false);
  });
});

describe("validator caps track sql/mysql.sql column widths (project, category)", () => {
  // project/category both take part in review_thread_page_idx alongside
  // url_key and carry a literal DEFAULT, which is why they're bounded
  // varchar rather than text too — see sql/mysql.sql's column comments.
  it.each([
    { field: "project" as const, column: "project", schemaField: "project" as const },
    { field: "category" as const, column: "category", schemaField: "category" as const },
  ])("newThreadSchema.$field accepts exactly the parsed bound and rejects one more", ({ column, schemaField }) => {
    const bound = threadBounds[column];
    if (bound === null || bound === undefined) {
      throw new Error(`${column} bound not parsed as a bounded varchar`);
    }

    const base = {
      url: "https://example.com/",
      urlKey: "/",
      locale: "en",
      category: "bug",
      anchor: { selector: "#x" },
      authorId: "user-1",
      authorName: "Ada",
      firstComment: "hello",
    };
    const atBound = { ...base, [schemaField]: "a".repeat(bound) };
    const overBound = { ...base, [schemaField]: "a".repeat(bound + 1) };
    expect(newThreadSchema.safeParse(atBound).success).toBe(true);
    expect(newThreadSchema.safeParse(overBound).success).toBe(false);
  });

  it("listThreadsQuerySchema.project accepts exactly the parsed bound and rejects one more", () => {
    const bound = threadBounds["project"];
    if (bound === null || bound === undefined) {
      throw new Error("project bound not parsed as a bounded varchar");
    }

    expect(listThreadsQuerySchema.safeParse({ project: "a".repeat(bound) }).success).toBe(true);
    expect(
      listThreadsQuerySchema.safeParse({ project: "a".repeat(bound + 1) }).success,
    ).toBe(false);
  });
});
