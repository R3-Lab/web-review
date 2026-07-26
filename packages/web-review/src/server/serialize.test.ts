import { describe, expect, it } from "vitest";
import { deriveTitle, toCommentView, toThreadView } from "./serialize";
import type { ReviewCommentRow, ReviewThreadRow } from "./serialize";

const anchor = { selector: "#x", extra: "opaque" };
const viewport = { w: 1024, h: 768 };

function makeThreadRow(overrides: Partial<ReviewThreadRow> = {}): ReviewThreadRow {
  return {
    id: "t1",
    project: "web",
    url: "https://example.com/",
    urlKey: "/",
    locale: "en",
    route: "/pricing",
    title: "Pricing feedback",
    category: "bug",
    anchor,
    viewport,
    status: "open",
    authorId: "u1",
    authorName: "Ada",
    screenshotKey: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

function makeCommentRow(overrides: Partial<ReviewCommentRow> = {}): ReviewCommentRow {
  return {
    id: "c1",
    threadId: "t1",
    body: "hello",
    authorId: "u1",
    authorName: "Ada",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("toCommentView", () => {
  it("maps every field and formats createdAt as ISO", () => {
    const row = makeCommentRow();
    expect(toCommentView(row)).toEqual({
      id: "c1",
      threadId: "t1",
      body: "hello",
      authorId: "u1",
      authorName: "Ada",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("toThreadView", () => {
  it("maps every field, defaulting screenshotUrl to null and comments to empty", () => {
    const row = makeThreadRow();
    const view = toThreadView(row);
    expect(view).toEqual({
      id: "t1",
      project: "web",
      url: "https://example.com/",
      urlKey: "/",
      locale: "en",
      route: "/pricing",
      title: "Pricing feedback",
      category: "bug",
      anchor,
      viewport,
      status: "open",
      authorId: "u1",
      authorName: "Ada",
      screenshotUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      resolvedAt: null,
      resolvedBy: null,
      comments: [],
      commentCount: 0,
    });
  });

  it("passes anchor/viewport through untouched (opaque JSON)", () => {
    const row = makeThreadRow();
    const view = toThreadView(row);
    expect(view.anchor).toBe(anchor);
    expect(view.viewport).toBe(viewport);
  });

  it("defaults viewport to null when the row has none", () => {
    const row = makeThreadRow({ viewport: null });
    expect(toThreadView(row).viewport).toBeNull();
  });

  it("formats resolvedAt as ISO when present", () => {
    const row = makeThreadRow({
      status: "resolved",
      resolvedAt: new Date("2026-01-03T00:00:00.000Z"),
      resolvedBy: "Ada",
    });
    const view = toThreadView(row);
    expect(view.resolvedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(view.resolvedBy).toBe("Ada");
  });

  it("only calls the injected screenshotUrl when screenshotKey is set", () => {
    const calls: string[] = [];
    const screenshotUrl = (key: string) => {
      calls.push(key);
      return `https://cdn.example.com/${key}`;
    };

    const withoutKey = toThreadView(makeThreadRow({ screenshotKey: null }), { screenshotUrl });
    expect(withoutKey.screenshotUrl).toBeNull();
    expect(calls).toEqual([]);

    const withKey = toThreadView(makeThreadRow({ screenshotKey: "review/abc.png" }), {
      screenshotUrl,
    });
    expect(withKey.screenshotUrl).toBe("https://cdn.example.com/review/abc.png");
    expect(calls).toEqual(["review/abc.png"]);
  });

  it("maps and orders comments via toCommentView", () => {
    const row = makeThreadRow();
    const comments = [
      makeCommentRow({ id: "c1", body: "first" }),
      makeCommentRow({ id: "c2", body: "second" }),
    ];
    const view = toThreadView(row, { comments });
    expect(view.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(view.comments.map((c) => c.body)).toEqual(["first", "second"]);
    expect(view.commentCount).toBe(2);
  });

  it("derives commentCount from comments.length when commentCount is omitted", () => {
    const row = makeThreadRow();
    const view = toThreadView(row, { comments: [makeCommentRow()] });
    expect(view.commentCount).toBe(1);
  });

  it("uses an explicit commentCount over comments.length (list rows)", () => {
    const row = makeThreadRow();
    const view = toThreadView(row, { commentCount: 7 });
    expect(view.commentCount).toBe(7);
    expect(view.comments).toEqual([]);
  });
});

describe("deriveTitle", () => {
  it("returns null for an empty string", () => {
    expect(deriveTitle("")).toBeNull();
  });

  it("returns null for a whitespace-only string", () => {
    expect(deriveTitle("   \n\t  ")).toBeNull();
  });

  it("returns a short string unchanged", () => {
    expect(deriveTitle("Fix the button")).toBe("Fix the button");
  });

  it("collapses internal whitespace (including newlines) to single spaces", () => {
    expect(deriveTitle("Fix   the\n\nbutton\tplease")).toBe("Fix the button please");
  });

  it("trims leading/trailing whitespace", () => {
    expect(deriveTitle("   Fix the button   ")).toBe("Fix the button");
  });

  it("caps at 80 characters with an ellipsis", () => {
    const long = "a".repeat(100);
    const title = deriveTitle(long);
    expect(title).not.toBeNull();
    expect(title?.length).toBe(80);
    expect(title?.endsWith("…")).toBe(true);
    expect(title).toBe(`${"a".repeat(79)}…`);
  });

  it("leaves an exactly-80-character string unchanged", () => {
    const exact = "a".repeat(80);
    expect(deriveTitle(exact)).toBe(exact);
  });
});
