import { describe, expect, it } from "vitest";
import {
  MAX_COMMENT_BODY,
  MAX_URL_KEY,
  listThreadsQuerySchema,
  newCommentSchema,
  newThreadSchema,
  patchThreadSchema,
  screenshotKeySchema,
  threadIdSchema,
  trimmedNonEmpty,
  unlockSchema,
} from "./validation";

const validAnchor = {
  selector: "#x",
  textHint: "hello",
  tagName: "div",
  classes: [],
  ancestorPath: [],
  rect: { x: 0, y: 0, w: 10, h: 10 },
  offsetPct: { x: 0.5, y: 0.5 },
  viewport: { w: 1024, h: 768, dpr: 1, scrollW: 1024, scrollH: 2000 },
  urlKey: "/",
  href: "https://example.com/",
};

const validThreadPayload = {
  url: "https://example.com/",
  urlKey: "/",
  locale: "en",
  category: "bug",
  anchor: validAnchor,
  authorId: "user-1",
  authorName: "Ada",
  firstComment: "This button is broken",
};

describe("unlockSchema", () => {
  it("accepts a non-empty password", () => {
    expect(unlockSchema.safeParse({ password: "hunter2" }).success).toBe(true);
  });

  it("rejects an empty password", () => {
    expect(unlockSchema.safeParse({ password: "" }).success).toBe(false);
  });

  it("rejects a password over 512 chars", () => {
    expect(unlockSchema.safeParse({ password: "a".repeat(513) }).success).toBe(false);
  });

  it("rejects a missing password", () => {
    expect(unlockSchema.safeParse({}).success).toBe(false);
  });
});

describe("newThreadSchema", () => {
  it("accepts a minimal valid payload", () => {
    const result = newThreadSchema.safeParse(validThreadPayload);
    expect(result.success).toBe(true);
  });

  it("accepts a full payload with all optional fields", () => {
    const result = newThreadSchema.safeParse({
      ...validThreadPayload,
      project: "docs",
      route: "/pricing",
      title: "Pricing feedback",
      viewport: { w: 1024, h: 768, dpr: 1, scrollW: 1024, scrollH: 2000 },
      screenshotKey: "review/abc123.png",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null locale (unlocalized consumer sites)", () => {
    const result = newThreadSchema.safeParse({ ...validThreadPayload, locale: null });
    expect(result.success).toBe(true);
  });

  it("accepts any free-form category string (not a closed enum)", () => {
    const result = newThreadSchema.safeParse({ ...validThreadPayload, category: "accessibility" });
    expect(result.success).toBe(true);
  });

  it("rejects a missing url", () => {
    const rest: Record<string, unknown> = { ...validThreadPayload };
    delete rest["url"];
    expect(newThreadSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a blank (whitespace-only) firstComment", () => {
    const result = newThreadSchema.safeParse({ ...validThreadPayload, firstComment: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects a firstComment over MAX_COMMENT_BODY", () => {
    const result = newThreadSchema.safeParse({
      ...validThreadPayload,
      firstComment: "a".repeat(MAX_COMMENT_BODY + 1),
    });
    expect(result.success).toBe(false);
  });

  // Regression: urlKey used to allow up to 1024 characters here while
  // sql/mysql.sql's indexed `url_key varchar(512)` column could only ever
  // store 512 — a key in the 513-1024 range validated and inserted on
  // Postgres but failed on MySQL. See MAX_URL_KEY's doc comment and
  // schema-limits.test.ts for the drift check.
  it("accepts a urlKey exactly MAX_URL_KEY characters long", () => {
    const result = newThreadSchema.safeParse({
      ...validThreadPayload,
      urlKey: "a".repeat(MAX_URL_KEY),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a urlKey over MAX_URL_KEY characters long", () => {
    const result = newThreadSchema.safeParse({
      ...validThreadPayload,
      urlKey: "a".repeat(MAX_URL_KEY + 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an anchor that is not an object", () => {
    expect(newThreadSchema.safeParse({ ...validThreadPayload, anchor: "not-an-object" }).success).toBe(
      false,
    );
    expect(newThreadSchema.safeParse({ ...validThreadPayload, anchor: ["a"] }).success).toBe(false);
    expect(newThreadSchema.safeParse({ ...validThreadPayload, anchor: null }).success).toBe(false);
  });

  it("rejects a screenshotKey that doesn't match the default prefix", () => {
    const result = newThreadSchema.safeParse({
      ...validThreadPayload,
      screenshotKey: "feedback/abc.png",
    });
    expect(result.success).toBe(false);
  });

  it("trims whitespace from trimmed fields", () => {
    const result = newThreadSchema.safeParse({
      ...validThreadPayload,
      firstComment: "  hello world  ",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.firstComment).toBe("hello world");
  });

  describe("anchor / viewport opaque-JSON invariant", () => {
    it("passes anchor through with object identity preserved", () => {
      const anchor = { ...validAnchor, extra: { nested: true } };
      const result = newThreadSchema.safeParse({ ...validThreadPayload, anchor });
      expect(result.success).toBe(true);
      if (result.success) {
        // Same object reference — z.custom returns the ORIGINAL value, no
        // cloning and no key reordering.
        expect(result.data.anchor).toBe(anchor);
      }
    });

    it("preserves unknown keys the client added, verbatim", () => {
      const anchor = { ...validAnchor, futureField: "from a newer client", nested: { a: 1, b: [1, 2] } };
      const result = newThreadSchema.safeParse({ ...validThreadPayload, anchor });
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data.anchor;
        expect(data["futureField"]).toBe("from a newer client");
        expect(data["nested"]).toEqual({ a: 1, b: [1, 2] });
      }
    });

    it("passes a provided viewport through with object identity preserved", () => {
      const viewport = { w: 1, h: 2, dpr: 1, scrollW: 1, scrollH: 1, extra: "x" };
      const result = newThreadSchema.safeParse({ ...validThreadPayload, viewport });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.viewport).toBe(viewport);
    });
  });
});

describe("newCommentSchema", () => {
  it("accepts a valid comment", () => {
    expect(
      newCommentSchema.safeParse({ body: "Looks good", authorId: "u1", authorName: "Ada" }).success,
    ).toBe(true);
  });

  it("rejects a blank body", () => {
    expect(
      newCommentSchema.safeParse({ body: "   ", authorId: "u1", authorName: "Ada" }).success,
    ).toBe(false);
  });

  it("rejects a missing authorName", () => {
    expect(newCommentSchema.safeParse({ body: "hi", authorId: "u1" }).success).toBe(false);
  });
});

describe("patchThreadSchema", () => {
  it("accepts status alone", () => {
    expect(patchThreadSchema.safeParse({ status: "resolved" }).success).toBe(true);
  });

  it("accepts status with resolvedBy", () => {
    expect(patchThreadSchema.safeParse({ status: "resolved", resolvedBy: "Ada" }).success).toBe(true);
  });

  it("rejects an invalid status value", () => {
    expect(patchThreadSchema.safeParse({ status: "archived" }).success).toBe(false);
  });
});

describe("listThreadsQuerySchema", () => {
  it("defaults status to 'all' and limit to 500", () => {
    const result = listThreadsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("all");
      expect(result.data.limit).toBe(500);
    }
  });

  it("coerces a string limit to a number", () => {
    const result = listThreadsQuerySchema.safeParse({ limit: "50" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(50);
  });

  it("rejects a limit over 500", () => {
    expect(listThreadsQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
  });

  // Same MAX_URL_KEY regression as newThreadSchema above — the query-string
  // urlKey filter must accept exactly what a stored thread's urlKey can be.
  it("accepts a urlKey exactly MAX_URL_KEY characters long", () => {
    const result = listThreadsQuerySchema.safeParse({ urlKey: "a".repeat(MAX_URL_KEY) });
    expect(result.success).toBe(true);
  });

  it("rejects a urlKey over MAX_URL_KEY characters long", () => {
    const result = listThreadsQuerySchema.safeParse({ urlKey: "a".repeat(MAX_URL_KEY + 1) });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid status", () => {
    expect(listThreadsQuerySchema.safeParse({ status: "archived" }).success).toBe(false);
  });
});

describe("threadIdSchema", () => {
  it("accepts a valid uuid", () => {
    expect(threadIdSchema.safeParse("123e4567-e89b-12d3-a456-426614174000").success).toBe(true);
  });

  it("rejects a non-uuid string", () => {
    expect(threadIdSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("trimmedNonEmpty", () => {
  const schema = trimmedNonEmpty(10);

  it("trims surrounding whitespace", () => {
    const result = schema.safeParse("  hi  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("hi");
  });

  it("rejects a whitespace-only string", () => {
    expect(schema.safeParse("   ").success).toBe(false);
  });

  it("rejects a string over the max length", () => {
    expect(schema.safeParse("12345678901").success).toBe(false);
  });
});

describe("screenshotKeySchema factory", () => {
  it("accepts a key under the default 'review' prefix", () => {
    expect(screenshotKeySchema().safeParse("review/abc-123.png").success).toBe(true);
  });

  it("accepts a key under a custom prefix", () => {
    expect(screenshotKeySchema("uploads").safeParse("uploads/abc-123.png").success).toBe(true);
  });

  it("rejects a key under a foreign prefix", () => {
    expect(screenshotKeySchema("review").safeParse("uploads/abc-123.png").success).toBe(false);
    expect(screenshotKeySchema("uploads").safeParse("review/abc-123.png").success).toBe(false);
  });

  it("rejects path traversal (slashes inside the key segment)", () => {
    expect(screenshotKeySchema().safeParse("review/../etc/passwd.png").success).toBe(false);
    expect(screenshotKeySchema().safeParse("review/../../secret.png").success).toBe(false);
    expect(screenshotKeySchema().safeParse("review//etc/passwd.png").success).toBe(false);
  });

  it("rejects a non-png extension", () => {
    expect(screenshotKeySchema().safeParse("review/abc.jpg").success).toBe(false);
  });

  it("rejects keys with disallowed characters", () => {
    expect(screenshotKeySchema().safeParse("review/abc def.png").success).toBe(false);
    expect(screenshotKeySchema().safeParse("review/abc$.png").success).toBe(false);
  });

  it("escapes regex-special characters in a custom prefix", () => {
    // A prefix containing a regex metacharacter must be treated literally,
    // not interpreted as part of the pattern.
    const schema = screenshotKeySchema("re.view");
    expect(schema.safeParse("re.view/abc.png").success).toBe(true);
    expect(schema.safeParse("reXview/abc.png").success).toBe(false);
  });
});
