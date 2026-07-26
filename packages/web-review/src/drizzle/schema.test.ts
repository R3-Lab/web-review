/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getMysqlTableConfig } from "drizzle-orm/mysql-core";
import { reviewCommentPg, reviewThreadPg } from "./postgres";
import { reviewCommentMysql, reviewThreadMysql } from "./mysql";

/**
 * Three things this file has to prove, matching the three ways
 * sql/postgres.sql, sql/mysql.sql, and the Drizzle factories could drift
 * apart from each other or from the wire contract:
 *
 * 1. Each SQL file, read as text, actually contains the columns,
 *    constraints, and indexes it claims to (not just "the file exists and
 *    is non-empty").
 * 2. The two SQL files define the exact same logical column set — same
 *    names, same nullability, same presence/absence of a default.
 * 3. The Drizzle factories' columns match the SQL files' columns exactly,
 *    and respect a caller-supplied table name.
 *
 * None of this needs a real database connection — it's all static
 * structure, checked against the actual file contents and the actual
 * Drizzle table objects, not by eyeballing them.
 */

// ─── SQL file parsing ──────────────────────────────────────────────────────
// A hand-rolled parser, not a general SQL parser: sql/postgres.sql and
// sql/mysql.sql are both written by this package in one consistent style
// (lowercase keywords, one column/constraint/index per line inside a
// `create table if not exists (...)`), and this only needs to understand
// that exact shape well enough to pull out real structure.

interface ParsedColumn {
  name: string;
  notNull: boolean;
  hasDefault: boolean;
}

interface ParsedTable {
  columns: ParsedColumn[];
  checks: string[];
  foreignKeys: string[];
  indexNames: string[];
}

/**
 * Drop `-- ...` line comments before any structural parsing — both SQL
 * files are heavily commented (that's the point: consumers read them), and
 * without this, prose that happens to mention a keyword like "create index"
 * gets misparsed as DDL. Kept separate from the raw file text, which some
 * tests below deliberately search (e.g. to confirm a rationale is
 * documented at all).
 */
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

/** `ddl` must already have comments stripped (see `stripSqlComments`). */
function parseTable(ddl: string, tableName: string): ParsedTable {
  const entries = splitTopLevel(extractTableBody(ddl, tableName));
  const columns: ParsedColumn[] = [];
  const checks: string[] = [];
  const foreignKeys: string[] = [];
  const indexNames: string[] = [];

  for (const raw of entries) {
    const entry = raw.replace(/\s+/g, " ").trim();
    const lower = entry.toLowerCase();

    if (lower.startsWith("constraint") && lower.includes("foreign key")) {
      foreignKeys.push(entry);
      continue;
    }
    if (lower.startsWith("constraint") && lower.includes(" check")) {
      checks.push(entry);
      continue;
    }
    const indexMatch = /^key\s+(\S+)/i.exec(entry);
    if (indexMatch) {
      const name = indexMatch[1];
      if (name !== undefined) indexNames.push(name);
      continue;
    }

    // Otherwise it's a plain column definition: `<name> <type and modifiers>`.
    const columnMatch = /^(\S+)\s+(.+)$/s.exec(entry);
    if (!columnMatch) continue;
    const name = columnMatch[1];
    const rest = columnMatch[2];
    if (name === undefined || rest === undefined) continue;
    const restLower = rest.toLowerCase();
    columns.push({
      name,
      // A column-level `primary key` implies NOT NULL in both dialects,
      // even though only the MySQL file spells out "not null" alongside it.
      notNull:
        /\bnot null\b/.test(restLower) || /\bprimary key\b/.test(restLower),
      hasDefault: /\bdefault\b/.test(restLower),
    });
  }

  return { columns, checks, foreignKeys, indexNames };
}

/**
 * Postgres-only: `create index if not exists <name> on <table> (<cols>)`
 * statements. `ddl` must already have comments stripped.
 */
function parsePgStandaloneIndexes(
  ddl: string,
): { name: string; table: string; columns: string[] }[] {
  const re = /create index if not exists (\S+)\s+on (\S+)\s*\(([^)]+)\)/gi;
  const out: { name: string; table: string; columns: string[] }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(ddl)) !== null) {
    const name = m[1];
    const table = m[2];
    const colsRaw = m[3];
    if (name === undefined || table === undefined || colsRaw === undefined) {
      continue;
    }
    out.push({ name, table, columns: colsRaw.split(",").map((c) => c.trim()) });
  }
  return out;
}

/** Narrow `T | undefined` to `T`, failing loudly instead of using `!`. */
function expectDefined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected value to be defined");
  }
  return value;
}

/** `{ notNull, hasDefault }` keyed by column name, for structural diffing. */
function byNullabilityAndDefault(
  columns: ParsedColumn[],
): Record<string, { notNull: boolean; hasDefault: boolean }> {
  return Object.fromEntries(
    columns.map((c) => [c.name, { notNull: c.notNull, hasDefault: c.hasDefault }]),
  );
}

// vitest.config.ts has no `root` override, so vitest resolves relative to
// the package root (where `pnpm test` is invoked) — same as `process.cwd()`
// here, and more reliable across test environments than parsing
// `import.meta.url` (which vitest's jsdom environment doesn't always give a
// `file:`-scheme value for).
const postgresSql = readFileSync(join(process.cwd(), "sql/postgres.sql"), "utf8");
const mysqlSql = readFileSync(join(process.cwd(), "sql/mysql.sql"), "utf8");
// Comment-stripped copies, used for all structural parsing below. The raw
// strings above stay in scope for the handful of tests that intentionally
// search the file's prose (e.g. "is a rationale documented at all").
const postgresDdl = stripSqlComments(postgresSql);
const mysqlDdl = stripSqlComments(mysqlSql);

const THREAD_COLUMNS = [
  "id",
  "project",
  "url",
  "url_key",
  "locale",
  "route",
  "title",
  "category",
  "anchor",
  "viewport",
  "status",
  "author_id",
  "author_name",
  "screenshot_key",
  "created_at",
  "updated_at",
  "resolved_at",
  "resolved_by",
];

const COMMENT_COLUMNS = [
  "id",
  "thread_id",
  "body",
  "author_id",
  "author_name",
  "created_at",
];

// ─── sql/postgres.sql ───────────────────────────────────────────────────────

describe("sql/postgres.sql", () => {
  const thread = parseTable(postgresDdl, "review_thread");
  const comment = parseTable(postgresDdl, "review_comment");
  const indexes = parsePgStandaloneIndexes(postgresDdl);

  it("defines review_thread with exactly the wire-contract columns", () => {
    expect(thread.columns.map((c) => c.name).sort()).toEqual(
      [...THREAD_COLUMNS].sort(),
    );
  });

  it("defines review_comment with exactly the wire-contract columns", () => {
    expect(comment.columns.map((c) => c.name).sort()).toEqual(
      [...COMMENT_COLUMNS].sort(),
    );
  });

  it("requires anchor NOT NULL but leaves viewport nullable", () => {
    const anchor = expectDefined(thread.columns.find((c) => c.name === "anchor"));
    const viewport = expectDefined(
      thread.columns.find((c) => c.name === "viewport"),
    );
    expect(anchor.notNull).toBe(true);
    expect(viewport.notNull).toBe(false);
  });

  it("constrains status to open/resolved via a named CHECK constraint", () => {
    expect(thread.checks).toHaveLength(1);
    const check = expectDefined(thread.checks[0]);
    expect(check).toContain("review_thread_status_check");
    expect(check).toMatch(/\bstatus\b/);
    expect(check).toContain("'open'");
    expect(check).toContain("'resolved'");
  });

  it("does NOT constrain category or locale (both are consumer-configurable)", () => {
    for (const check of thread.checks) {
      expect(check).not.toMatch(/\bcategory\b/);
      expect(check).not.toMatch(/\blocale\b/);
    }
  });

  it("cascades review_comment.thread_id to review_thread(id)", () => {
    expect(comment.foreignKeys).toHaveLength(1);
    const fk = expectDefined(comment.foreignKeys[0]);
    expect(fk).toContain("review_comment_thread_id_fkey");
    expect(fk).toContain("references review_thread (id)");
    expect(fk).toContain("on delete cascade");
  });

  it("declares the three required indexes with the right columns", () => {
    const pageIdx = expectDefined(
      indexes.find((i) => i.name === "review_thread_page_idx"),
    );
    expect(pageIdx.table).toBe("review_thread");
    expect(pageIdx.columns).toEqual(["project", "url_key", "status"]);

    const createdAtIdx = expectDefined(
      indexes.find((i) => i.name === "review_thread_created_at_idx"),
    );
    expect(createdAtIdx.table).toBe("review_thread");
    expect(createdAtIdx.columns).toEqual(["created_at"]);

    const commentIdx = expectDefined(
      indexes.find((i) => i.name === "review_comment_thread_idx"),
    );
    expect(commentIdx.table).toBe("review_comment");
    expect(commentIdx.columns).toEqual(["thread_id", "created_at"]);
  });

  it("uses IF NOT EXISTS on every CREATE TABLE and CREATE INDEX, for idempotency", () => {
    expect(postgresDdl.match(/create table(?! if not exists)/gi)).toBeNull();
    expect(postgresDdl.match(/create index(?! if not exists)/gi)).toBeNull();
  });

  it("uses gen_random_uuid() as the id default (core since PG13, no extension)", () => {
    expect(postgresDdl).toMatch(/id uuid primary key default gen_random_uuid\(\)/);
  });

  it("uses timestamptz for every timestamp column", () => {
    for (const col of ["created_at", "updated_at", "resolved_at"]) {
      expect(postgresDdl).toMatch(new RegExp(`${col} timestamptz`));
    }
  });
});

// ─── sql/mysql.sql ──────────────────────────────────────────────────────────

describe("sql/mysql.sql", () => {
  const thread = parseTable(mysqlDdl, "review_thread");
  const comment = parseTable(mysqlDdl, "review_comment");

  it("defines review_thread with exactly the wire-contract columns", () => {
    expect(thread.columns.map((c) => c.name).sort()).toEqual(
      [...THREAD_COLUMNS].sort(),
    );
  });

  it("defines review_comment with exactly the wire-contract columns", () => {
    expect(comment.columns.map((c) => c.name).sort()).toEqual(
      [...COMMENT_COLUMNS].sort(),
    );
  });

  it("constrains status to open/resolved via a named CHECK constraint", () => {
    expect(thread.checks).toHaveLength(1);
    const check = expectDefined(thread.checks[0]);
    expect(check).toContain("review_thread_status_check");
    expect(check).toContain("'open'");
    expect(check).toContain("'resolved'");
  });

  it("does NOT constrain category or locale (both are consumer-configurable)", () => {
    for (const check of thread.checks) {
      expect(check).not.toMatch(/\bcategory\b/);
      expect(check).not.toMatch(/\blocale\b/);
    }
  });

  it("cascades review_comment.thread_id to review_thread(id)", () => {
    expect(comment.foreignKeys).toHaveLength(1);
    const fk = expectDefined(comment.foreignKeys[0]);
    expect(fk).toContain("review_comment_thread_id_fkey");
    expect(fk).toContain("references review_thread (id)");
    expect(fk).toContain("on delete cascade");
  });

  it("declares the three required indexes inline (MySQL has no CREATE INDEX IF NOT EXISTS)", () => {
    expect(thread.indexNames).toEqual(
      expect.arrayContaining([
        "review_thread_page_idx",
        "review_thread_created_at_idx",
      ]),
    );
    expect(comment.indexNames).toEqual(
      expect.arrayContaining(["review_comment_thread_idx"]),
    );
  });

  it("uses IF NOT EXISTS on every CREATE TABLE, and declares no standalone CREATE INDEX", () => {
    expect(mysqlDdl.match(/create table(?! if not exists)/gi)).toBeNull();
    expect(mysqlDdl).not.toMatch(/create index/i);
  });

  it("DIVERGENCE: uses CHAR(36) + UUID() default, not a native UUID type", () => {
    expect(mysqlDdl.match(/id char\(36\) not null default \(uuid\(\)\)/g)).toHaveLength(2);
  });

  it("DIVERGENCE: uses JSON, not JSONB, for the opaque anchor/viewport columns", () => {
    expect(mysqlDdl).toMatch(/anchor json not null/);
    expect(mysqlDdl).toMatch(/viewport json,/);
    expect(mysqlDdl).not.toMatch(/jsonb/i);
  });

  it("DIVERGENCE: uses DATETIME(3), not TIMESTAMPTZ, with explicit CURRENT_TIMESTAMP(3) defaults", () => {
    expect(mysqlDdl).not.toMatch(/timestamptz/i);
    expect(mysqlDdl).toMatch(
      /created_at datetime\(3\) not null default current_timestamp\(3\)/,
    );
    expect(mysqlDdl).toMatch(
      /updated_at datetime\(3\) not null default current_timestamp\(3\)/,
    );
    expect(mysqlDdl).toMatch(/resolved_at datetime\(3\),/);
  });

  it("DIVERGENCE: bounds indexed/defaulted columns instead of using unbounded TEXT", () => {
    // url_key participates in a composite index and cannot be TEXT.
    expect(mysqlDdl).toMatch(/url_key varchar\(512\) not null/);
    // project/status/category all carry a literal DEFAULT and/or take part
    // in the same composite index.
    expect(mysqlDdl).toMatch(/project varchar\(64\) not null default 'web'/);
    expect(mysqlDdl).toMatch(/status varchar\(20\) not null default 'open'/);
    expect(mysqlDdl).toMatch(/category varchar\(64\) not null default 'other'/);
    // Columns with neither constraint stay TEXT, same as Postgres.
    expect(mysqlDdl).toMatch(/\burl text not null/);
    expect(mysqlDdl).toMatch(/\bbody text not null/);
  });

  it("requires the session to run as UTC, documented in the file header", () => {
    // Deliberately checks the RAW file, not the comment-stripped DDL: this
    // is a documentation requirement, not a DDL statement.
    expect(mysqlSql).toMatch(/time_zone/i);
  });
});

// ─── Cross-dialect drift check ─────────────────────────────────────────────

describe("postgres.sql and mysql.sql define the same logical schema", () => {
  const pgThread = parseTable(postgresDdl, "review_thread");
  const myThread = parseTable(mysqlDdl, "review_thread");
  const pgComment = parseTable(postgresDdl, "review_comment");
  const myComment = parseTable(mysqlDdl, "review_comment");

  it("review_thread: identical column names across dialects", () => {
    expect(myThread.columns.map((c) => c.name).sort()).toEqual(
      pgThread.columns.map((c) => c.name).sort(),
    );
  });

  it("review_thread: identical nullability and default-presence per column", () => {
    expect(byNullabilityAndDefault(myThread.columns)).toEqual(
      byNullabilityAndDefault(pgThread.columns),
    );
  });

  it("review_comment: identical column names across dialects", () => {
    expect(myComment.columns.map((c) => c.name).sort()).toEqual(
      pgComment.columns.map((c) => c.name).sort(),
    );
  });

  it("review_comment: identical nullability and default-presence per column", () => {
    expect(byNullabilityAndDefault(myComment.columns)).toEqual(
      byNullabilityAndDefault(pgComment.columns),
    );
  });

  it("both dialects CHECK-constrain status to the same two values", () => {
    expect(pgThread.checks).toHaveLength(1);
    expect(myThread.checks).toHaveLength(1);
  });

  it("both dialects cascade-delete comments with their thread", () => {
    expect(pgComment.foreignKeys).toHaveLength(1);
    expect(myComment.foreignKeys).toHaveLength(1);
  });
});

// ─── Drizzle factories match the hand-written SQL ──────────────────────────

describe("Drizzle factories match sql/postgres.sql", () => {
  it("reviewThreadPg's columns match review_thread exactly", () => {
    const config = getPgTableConfig(reviewThreadPg());
    const drizzleCols = Object.fromEntries(
      config.columns.map((c) => [c.name, { notNull: c.notNull, hasDefault: c.hasDefault }]),
    );
    expect(drizzleCols).toEqual(
      byNullabilityAndDefault(parseTable(postgresDdl, "review_thread").columns),
    );
  });

  it("reviewCommentPg's columns match review_comment exactly", () => {
    const config = getPgTableConfig(reviewCommentPg());
    const drizzleCols = Object.fromEntries(
      config.columns.map((c) => [c.name, { notNull: c.notNull, hasDefault: c.hasDefault }]),
    );
    expect(drizzleCols).toEqual(
      byNullabilityAndDefault(parseTable(postgresDdl, "review_comment").columns),
    );
  });

  it("reviewThreadPg declares the same named CHECK constraint as the SQL file", () => {
    const config = getPgTableConfig(reviewThreadPg());
    expect(config.checks).toHaveLength(1);
    expect(expectDefined(config.checks[0]).name).toBe("review_thread_status_check");
  });

  it("reviewThreadPg declares the same two named indexes as the SQL file", () => {
    const config = getPgTableConfig(reviewThreadPg());
    expect(config.indexes.map((i) => i.config.name).sort()).toEqual(
      ["review_thread_created_at_idx", "review_thread_page_idx"].sort(),
    );
  });

  it("reviewCommentPg's FK cascades to review_thread, by default", () => {
    const config = getPgTableConfig(reviewCommentPg());
    expect(config.foreignKeys).toHaveLength(1);
    const fk = expectDefined(config.foreignKeys[0]);
    expect(fk.onDelete).toBe("cascade");
    expect(getPgTableConfig(fk.reference().foreignTable).name).toBe("review_thread");
  });
});

describe("Drizzle factories match sql/mysql.sql", () => {
  it("reviewThreadMysql's columns match review_thread exactly", () => {
    const config = getMysqlTableConfig(reviewThreadMysql());
    const drizzleCols = Object.fromEntries(
      config.columns.map((c) => [c.name, { notNull: c.notNull, hasDefault: c.hasDefault }]),
    );
    expect(drizzleCols).toEqual(
      byNullabilityAndDefault(parseTable(mysqlDdl, "review_thread").columns),
    );
  });

  it("reviewCommentMysql's columns match review_comment exactly", () => {
    const config = getMysqlTableConfig(reviewCommentMysql());
    const drizzleCols = Object.fromEntries(
      config.columns.map((c) => [c.name, { notNull: c.notNull, hasDefault: c.hasDefault }]),
    );
    expect(drizzleCols).toEqual(
      byNullabilityAndDefault(parseTable(mysqlDdl, "review_comment").columns),
    );
  });

  it("reviewThreadMysql declares the same named CHECK constraint as the SQL file", () => {
    const config = getMysqlTableConfig(reviewThreadMysql());
    expect(config.checks).toHaveLength(1);
    expect(expectDefined(config.checks[0]).name).toBe("review_thread_status_check");
  });

  it("reviewThreadMysql declares the same two named indexes as the SQL file", () => {
    const config = getMysqlTableConfig(reviewThreadMysql());
    expect(config.indexes.map((i) => i.config.name).sort()).toEqual(
      ["review_thread_created_at_idx", "review_thread_page_idx"].sort(),
    );
  });

  it("reviewCommentMysql's FK cascades to review_thread, by default", () => {
    const config = getMysqlTableConfig(reviewCommentMysql());
    expect(config.foreignKeys).toHaveLength(1);
    const fk = expectDefined(config.foreignKeys[0]);
    expect(fk.onDelete).toBe("cascade");
    expect(getMysqlTableConfig(fk.reference().foreignTable).name).toBe("review_thread");
  });
});

// ─── Factories respect a custom table name ─────────────────────────────────

describe("factories respect a custom table name", () => {
  it("reviewThreadPg renames the table without changing its columns", () => {
    const config = getPgTableConfig(reviewThreadPg("my_review_thread"));
    expect(config.name).toBe("my_review_thread");
    expect(config.columns.map((c) => c.name).sort()).toEqual(
      [...THREAD_COLUMNS].sort(),
    );
  });

  it("reviewCommentPg's FK follows an explicitly-passed, renamed thread table", () => {
    const thread = reviewThreadPg("acme_review_thread");
    const comment = reviewCommentPg("acme_review_comment", thread);
    const config = getPgTableConfig(comment);
    expect(config.name).toBe("acme_review_comment");
    const fk = expectDefined(config.foreignKeys[0]);
    expect(getPgTableConfig(fk.reference().foreignTable).name).toBe(
      "acme_review_thread",
    );
  });

  it("reviewThreadMysql renames the table without changing its columns", () => {
    const config = getMysqlTableConfig(reviewThreadMysql("my_review_thread"));
    expect(config.name).toBe("my_review_thread");
    expect(config.columns.map((c) => c.name).sort()).toEqual(
      [...THREAD_COLUMNS].sort(),
    );
  });

  it("reviewCommentMysql's FK follows an explicitly-passed, renamed thread table", () => {
    const thread = reviewThreadMysql("acme_review_thread");
    const comment = reviewCommentMysql("acme_review_comment", thread);
    const config = getMysqlTableConfig(comment);
    expect(config.name).toBe("acme_review_comment");
    const fk = expectDefined(config.foreignKeys[0]);
    expect(getMysqlTableConfig(fk.reference().foreignTable).name).toBe(
      "acme_review_thread",
    );
  });

  it("both factories default to review_thread/review_comment, wired to each other", () => {
    const threadConfig = getPgTableConfig(reviewThreadPg());
    const commentConfig = getPgTableConfig(reviewCommentPg());
    expect(threadConfig.name).toBe("review_thread");
    expect(commentConfig.name).toBe("review_comment");
    const fk = expectDefined(commentConfig.foreignKeys[0]);
    expect(getPgTableConfig(fk.reference().foreignTable).name).toBe("review_thread");
  });
});
