/**
 * `createHttpAdapter` unit tests (vitest + jsdom). A fake `fetch` is
 * injected via `HttpAdapterOptions.fetch` and every test asserts on the
 * ACTUAL request the adapter sent — method, URL, body, headers — not just
 * on the parsed return value. Covers every `ReviewAdapter` method, the
 * `ReviewApiError` status/code/`Retry-After` mapping, and the FormData /
 * JSON content-type split.
 */

import { describe, expect, it, vi } from "vitest";

import { ReviewApiError } from "../core/adapter";
import type { NewThreadInput } from "../core/types";
import { createHttpAdapter } from "./http-adapter";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/**
 * A fetch stub that records every call and returns a queued response.
 * `createHttpAdapter` always calls `fetchImpl` with a plain URL string (it
 * never passes a `Request`/`URL` object), so this is typed narrowly to
 * that — no `String(input)` coercion needed.
 */
function makeFetch(...responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...responses];
  const fetchStub = vi.fn(
    (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init: init ?? {} });
      const next = queue.shift();
      if (!next) throw new Error("makeFetch: no queued response left");
      return Promise.resolve(next);
    },
  );
  return { fetch: fetchStub as unknown as typeof fetch, calls };
}

const sampleThread = {
  id: "t1",
  project: "web",
  url: "https://example.com/",
  urlKey: "/",
  locale: null,
  route: "/",
  title: null,
  category: "bug",
  anchor: {
    selector: "#x",
    textHint: "",
    tagName: "div",
    classes: [],
    ancestorPath: [],
    rect: { x: 0, y: 0, w: 0, h: 0 },
    offsetPct: { x: 0.5, y: 0.5 },
    viewport: { w: 0, h: 0, dpr: 1, scrollW: 0, scrollH: 0 },
    urlKey: "/",
    href: "https://example.com/",
  },
  viewport: null,
  status: "open" as const,
  authorId: "u1",
  authorName: "Ada",
  screenshotUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  resolvedAt: null,
  resolvedBy: null,
  comments: [],
  commentCount: 1,
};

describe("createHttpAdapter — listThreads", () => {
  it("GETs /threads with every filter param set, in a stable order", async () => {
    const { fetch, calls } = makeFetch(jsonResponse({ threads: [sampleThread] }));
    const adapter = createHttpAdapter({ fetch });

    const threads = await adapter.listThreads({
      urlKey: "/about",
      project: "web",
      status: "all",
      limit: 10,
    });

    expect(threads).toEqual([sampleThread]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "/api/review/threads?urlKey=%2Fabout&project=web&status=all&limit=10",
    );
    expect(call.init.method ?? "GET").toBe("GET");
  });

  it("omits the query string entirely when no filters are given", async () => {
    const { fetch, calls } = makeFetch(jsonResponse({ threads: [] }));
    const adapter = createHttpAdapter({ fetch });

    await adapter.listThreads({});

    expect(calls[0]!.url).toBe("/api/review/threads");
  });
});

describe("createHttpAdapter — getThread", () => {
  it("GETs /threads/:id, encoding the id", async () => {
    const { fetch, calls } = makeFetch(jsonResponse({ thread: sampleThread }));
    const adapter = createHttpAdapter({ fetch });

    const thread = await adapter.getThread("weird/id");

    expect(thread).toEqual(sampleThread);
    expect(calls[0]!.url).toBe("/api/review/threads/weird%2Fid");
  });

  it("throws ReviewApiError with status 404 and code not_found", async () => {
    const { fetch } = makeFetch(
      jsonResponse({ error: "not_found" }, { status: 404 }),
      jsonResponse({ error: "not_found" }, { status: 404 }),
    );
    const adapter = createHttpAdapter({ fetch });

    await expect(adapter.getThread("missing")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    await expect(adapter.getThread("missing")).rejects.toBeInstanceOf(
      ReviewApiError,
    );
  });
});

describe("createHttpAdapter — createThread", () => {
  it("POSTs /threads with a JSON body and JSON content-type", async () => {
    const { fetch, calls } = makeFetch(jsonResponse({ thread: sampleThread }));
    const adapter = createHttpAdapter({ fetch });

    const input: NewThreadInput = {
      url: "https://example.com/",
      urlKey: "/",
      locale: null,
      category: "bug",
      anchor: sampleThread.anchor,
      authorId: "u1",
      authorName: "Ada",
      firstComment: "hello",
    };
    const thread = await adapter.createThread(input);

    expect(thread).toEqual(sampleThread);
    const call = calls[0]!;
    expect(call.url).toBe("/api/review/threads");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(call.init.body as string)).toEqual(input);
    const headers = call.init.headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
  });
});

describe("createHttpAdapter — addComment", () => {
  it("POSTs /threads/:id/comments and returns the comment (not the thread)", async () => {
    const comment = {
      id: "c1",
      threadId: "t1",
      body: "hi",
      authorId: "u1",
      authorName: "Ada",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const { fetch, calls } = makeFetch(jsonResponse({ comment }));
    const adapter = createHttpAdapter({ fetch });

    const result = await adapter.addComment("t1", {
      body: "hi",
      authorId: "u1",
      authorName: "Ada",
    });

    expect(result).toEqual(comment);
    expect(calls[0]!.url).toBe("/api/review/threads/t1/comments");
    expect(calls[0]!.init.method).toBe("POST");
  });
});

describe("createHttpAdapter — setStatus", () => {
  it("PATCHes /threads/:id with { status, resolvedBy }", async () => {
    const { fetch, calls } = makeFetch(jsonResponse({ thread: sampleThread }));
    const adapter = createHttpAdapter({ fetch });

    await adapter.setStatus("t1", "resolved", "u2");

    const call = calls[0]!;
    expect(call.url).toBe("/api/review/threads/t1");
    expect(call.init.method).toBe("PATCH");
    expect(JSON.parse(call.init.body as string)).toEqual({
      status: "resolved",
      resolvedBy: "u2",
    });
  });
});

describe("createHttpAdapter — uploadScreenshot", () => {
  it("POSTs FormData to /screenshot WITHOUT a JSON content-type header", async () => {
    const { fetch, calls } = makeFetch(jsonResponse({ key: "shot-1" }));
    const adapter = createHttpAdapter({ fetch });

    const key = await adapter.uploadScreenshot?.(
      new Blob(["x"], { type: "image/png" }),
    );

    expect(key).toBe("shot-1");
    const call = calls[0]!;
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBeInstanceOf(FormData);
    const headers = call.init.headers as Headers;
    expect(headers.get("content-type")).toBeNull();
  });

  it("resolves to null (never throws) when the upload fails", async () => {
    const { fetch } = makeFetch(
      jsonResponse({ error: "storage_unavailable" }, { status: 500 }),
    );
    const adapter = createHttpAdapter({ fetch });

    await expect(
      adapter.uploadScreenshot?.(new Blob(["x"])),
    ).resolves.toBeNull();
  });
});

describe("createHttpAdapter — unlock", () => {
  it("POSTs { password } to /unlock", async () => {
    const { fetch, calls } = makeFetch(jsonResponse({ ok: true }));
    const adapter = createHttpAdapter({ fetch });

    await adapter.unlock?.("hunter2");

    const call = calls[0]!;
    expect(call.url).toBe("/api/review/unlock");
    expect(JSON.parse(call.init.body as string)).toEqual({
      password: "hunter2",
    });
  });

  it("throws ReviewApiError(401, 'locked') on a wrong password", async () => {
    const { fetch } = makeFetch(
      jsonResponse({ error: "locked" }, { status: 401 }),
    );
    const adapter = createHttpAdapter({ fetch });

    await expect(adapter.unlock?.("wrong")).rejects.toMatchObject({
      status: 401,
      code: "locked",
    });
  });

  it("parses Retry-After into retryAfterSec on a 429", async () => {
    const { fetch } = makeFetch(
      jsonResponse(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": "30" } },
      ),
    );
    const adapter = createHttpAdapter({ fetch });

    await expect(adapter.unlock?.("x")).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterSec: 30,
    });
  });

  it("leaves retryAfterSec undefined when the header is absent", async () => {
    const { fetch } = makeFetch(
      jsonResponse({ error: "rate_limited" }, { status: 429 }),
    );
    const adapter = createHttpAdapter({ fetch });

    await expect(adapter.unlock?.("x")).rejects.toMatchObject({
      status: 429,
      retryAfterSec: undefined,
    });
  });
});

describe("createHttpAdapter — response body tolerance", () => {
  it("does not throw on a 204 No Content response", async () => {
    const { fetch } = makeFetch(new Response(null, { status: 204 }));
    const adapter = createHttpAdapter({ fetch });

    await expect(adapter.unlock?.("x")).resolves.toBeUndefined();
  });

  it("does not throw on an empty 200 body with no JSON content-type", async () => {
    const { fetch } = makeFetch(new Response("", { status: 200 }));
    const adapter = createHttpAdapter({ fetch });

    await expect(adapter.unlock?.("x")).resolves.toBeUndefined();
  });
});

describe("createHttpAdapter — options", () => {
  it("uses /api/review as the default baseUrl", async () => {
    const { fetch, calls } = makeFetch(jsonResponse({ threads: [] }));
    createHttpAdapter({ fetch });
    const adapter = createHttpAdapter({ fetch });
    await adapter.listThreads({});
    expect(calls[calls.length - 1]!.url.startsWith("/api/review/")).toBe(
      true,
    );
  });

  it("respects a custom baseUrl", async () => {
    const { fetch, calls } = makeFetch(jsonResponse({ threads: [] }));
    const adapter = createHttpAdapter({ fetch, baseUrl: "https://api.example.com/review" });
    await adapter.listThreads({});
    expect(calls[0]!.url).toBe("https://api.example.com/review/threads");
  });

  it("merges static extra headers into every request", async () => {
    const { fetch, calls } = makeFetch(jsonResponse({ threads: [] }));
    const adapter = createHttpAdapter({
      fetch,
      headers: { "x-app": "demo" },
    });
    await adapter.listThreads({});
    const headers = calls[0]!.init.headers as Headers;
    expect(headers.get("x-app")).toBe("demo");
  });

  it("merges dynamic (function) extra headers into every request", async () => {
    const { fetch, calls } = makeFetch(jsonResponse({ threads: [] }));
    const adapter = createHttpAdapter({
      fetch,
      headers: () => ({ "x-token": "live-token" }),
    });
    await adapter.listThreads({});
    const headers = calls[0]!.init.headers as Headers;
    expect(headers.get("x-token")).toBe("live-token");
  });

  it("always sends credentials: same-origin and cache: no-store", async () => {
    const { fetch, calls } = makeFetch(jsonResponse({ threads: [] }));
    const adapter = createHttpAdapter({ fetch });
    await adapter.listThreads({});
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(calls[0]!.init.cache).toBe("no-store");
  });
});
