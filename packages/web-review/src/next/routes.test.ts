// @vitest-environment node
//
// jsdom's fetch polyfill hangs on `Request#formData()` for a `FormData`
// body containing a `File` (observed as a `POST /screenshot` test timeout).
// This suite needs no DOM — only the Web Fetch API — so it runs under
// Node's native, spec-compliant `Request`/`Response`/`FormData`/`File`
// instead of the package-wide jsdom default (see `vitest.config.ts`).
import { describe, expect, it } from "vitest";
import type { NewCommentInput, ReviewCommentView, ReviewStatus, ReviewThreadView } from "../core/types";
import { type AccessConfig, serializeAccessCookie } from "../server/access";
import type { ReviewCommentRow, ReviewThreadRow } from "../server/serialize";
import { deriveTitle } from "../server/serialize";
import { screenshotKeySchema } from "../server/validation";
import { createReviewRouteHandlers } from "./routes";
import type { CreateReviewRouteHandlersOptions, ReviewStore } from "./routes";

const ACCESS: AccessConfig = { password: "hunter2", secret: "signing-secret" };

const VALID_THREAD_BODY = {
  url: "https://example.com/",
  urlKey: "/",
  locale: "en",
  category: "bug",
  anchor: { selector: "#x" },
  authorId: "user-1",
  authorName: "Ada",
  firstComment: "This button is broken",
};

// ---------------------------------------------------------------------------
// Fake in-memory ReviewStore
// ---------------------------------------------------------------------------

let nextId = 0;
function fakeUuid(): string {
  nextId += 1;
  return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
}

function createFakeStore(options: { withScreenshot?: boolean } = {}): ReviewStore {
  const threads = new Map<string, ReviewThreadRow>();
  const comments = new Map<string, ReviewCommentRow[]>();
  let screenshotCount = 0;

  const store: ReviewStore = {
    listThreads(params) {
      const rows = [...threads.values()]
        .filter((t) => t.project === params.project)
        .filter((t) => (params.urlKey ? t.urlKey === params.urlKey : true))
        .filter((t) => (params.status === "all" ? true : t.status === params.status))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, params.limit);
      return Promise.resolve(
        rows.map((thread) => ({ thread, commentCount: comments.get(thread.id)?.length ?? 0 })),
      );
    },

    getThread(id) {
      const thread = threads.get(id);
      if (!thread) return Promise.resolve(null);
      return Promise.resolve({ thread, comments: comments.get(id) ?? [] });
    },

    createThread(input) {
      const id = fakeUuid();
      const now = new Date();
      const thread: ReviewThreadRow = {
        id,
        project: input.project,
        url: input.url,
        urlKey: input.urlKey,
        locale: input.locale,
        route: input.route,
        title: input.title,
        category: input.category,
        anchor: input.anchor,
        viewport: input.viewport,
        status: "open",
        authorId: input.authorId,
        authorName: input.authorName,
        screenshotKey: input.screenshotKey,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
        resolvedBy: null,
      };
      const comment: ReviewCommentRow = {
        id: fakeUuid(),
        threadId: id,
        body: input.firstComment,
        authorId: input.authorId,
        authorName: input.authorName,
        createdAt: now,
      };
      threads.set(id, thread);
      comments.set(id, [comment]);
      return Promise.resolve({ thread, comment });
    },

    addComment(threadId, input: NewCommentInput) {
      const thread = threads.get(threadId);
      if (!thread) return Promise.resolve(null);
      const comment: ReviewCommentRow = {
        id: fakeUuid(),
        threadId,
        body: input.body,
        authorId: input.authorId,
        authorName: input.authorName,
        createdAt: new Date(),
      };
      const list = comments.get(threadId) ?? [];
      list.push(comment);
      comments.set(threadId, list);
      thread.updatedAt = new Date();
      return Promise.resolve(comment);
    },

    setStatus(threadId, status: ReviewStatus, resolvedBy: string | null) {
      const thread = threads.get(threadId);
      if (!thread) return Promise.resolve(null);
      thread.status = status;
      thread.updatedAt = new Date();
      if (status === "resolved") {
        thread.resolvedAt = new Date();
        thread.resolvedBy = resolvedBy;
      } else {
        thread.resolvedAt = null;
        thread.resolvedBy = null;
      }
      return Promise.resolve({ thread, comments: comments.get(threadId) ?? [] });
    },
  };

  if (options.withScreenshot ?? true) {
    store.putScreenshot = (bytes) => {
      screenshotCount += 1;
      const key = `review/shot-${screenshotCount}-${bytes.byteLength}.png`;
      return Promise.resolve(key);
    };
    store.screenshotUrl = (key) => `https://cdn.example.com/${key}`;
  }

  return store;
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function makeRequest(
  method: string,
  path: string,
  opts: { body?: unknown; formData?: FormData; cookie?: string } = {},
): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("cookie", opts.cookie);

  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.body);
  }

  return new Request(`http://localhost${path}`, { method, headers, body });
}

function cookieHeaderFor(config: AccessConfig, now?: number): string {
  const descriptor = serializeAccessCookie(config, { now });
  return `${descriptor.name}=${descriptor.value}`;
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface ErrorBody {
  error: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// PNG fixture (same minimal-IHDR technique as server/png.test.ts)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function makePngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set(PNG_SIGNATURE, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function pngForm(bytes: Uint8Array, filename = "shot.png"): FormData {
  // `File`'s BlobPart typing wants a plain `ArrayBuffer`, not the
  // `ArrayBufferLike` a `Uint8Array` view carries — copy into one.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const form = new FormData();
  form.set("file", new File([buffer], filename, { type: "image/png" }));
  return form;
}

// ---------------------------------------------------------------------------
// Handler factory helper
// ---------------------------------------------------------------------------

function buildHandlers(overrides: Partial<CreateReviewRouteHandlersOptions> = {}) {
  const store = overrides.store ?? createFakeStore();
  return createReviewRouteHandlers({
    store,
    access: ACCESS,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Feature disabled (kill switch)
// ---------------------------------------------------------------------------

describe("feature disabled (no password configured)", () => {
  const disabledAccess = { password: undefined, secret: undefined };

  it("answers 404 on every route, including with a valid admin predicate", async () => {
    const handlers = buildHandlers({ access: disabledAccess, isAdmin: () => true });

    const cases: Promise<Response>[] = [
      handlers.unlock.POST(makeRequest("POST", "/unlock", { body: { password: "hunter2" } })),
      handlers.threads.GET(makeRequest("GET", "/threads?urlKey=/")),
      handlers.threads.POST(makeRequest("POST", "/threads", { body: VALID_THREAD_BODY })),
      handlers.thread.GET(makeRequest("GET", "/threads/x"), ctx(fakeUuid())),
      handlers.thread.PATCH(makeRequest("PATCH", "/threads/x", { body: { status: "resolved" } }), ctx(fakeUuid())),
      handlers.comments.POST(
        makeRequest("POST", "/threads/x/comments", { body: { body: "hi", authorId: "u", authorName: "A" } }),
        ctx(fakeUuid()),
      ),
      handlers.screenshot.POST(makeRequest("POST", "/screenshot", { formData: pngForm(makePngBytes(300, 300)) })),
    ];

    const responses = await Promise.all(cases);
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect((await readJson<ErrorBody>(res)).error).toBe("not_found");
    }
  });

  it("password set but secret missing also stays disabled (fail closed, not unsigned)", async () => {
    const handlers = buildHandlers({ access: { password: "hunter2", secret: undefined } });
    const res = await handlers.threads.GET(makeRequest("GET", "/threads?urlKey=/"));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Access gate
// ---------------------------------------------------------------------------

describe("access gate", () => {
  it("no cookie ⇒ 401 locked", async () => {
    const handlers = buildHandlers();
    const res = await handlers.threads.GET(makeRequest("GET", "/threads?urlKey=/"));
    expect(res.status).toBe(401);
    expect((await readJson<ErrorBody>(res)).error).toBe("locked");
  });

  it("valid cookie ⇒ 200", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.threads.GET(makeRequest("GET", "/threads?urlKey=/", { cookie }));
    expect(res.status).toBe(200);
  });

  it("valid admin predicate without a cookie ⇒ 200", async () => {
    const handlers = buildHandlers({ isAdmin: () => true });
    const res = await handlers.threads.GET(makeRequest("GET", "/threads?urlKey=/"));
    expect(res.status).toBe(200);
  });

  it("every response carries X-Robots-Tag and Cache-Control, success or error", async () => {
    const handlers = buildHandlers();
    const locked = await handlers.threads.GET(makeRequest("GET", "/threads?urlKey=/"));
    const ok = await handlers.threads.GET(
      makeRequest("GET", "/threads?urlKey=/", { cookie: cookieHeaderFor(ACCESS) }),
    );
    for (const res of [locked, ok]) {
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

// ---------------------------------------------------------------------------
// Unlock
// ---------------------------------------------------------------------------

describe("POST /unlock", () => {
  it("wrong password ⇒ 401 invalid_password", async () => {
    const handlers = buildHandlers();
    const res = await handlers.unlock.POST(makeRequest("POST", "/unlock", { body: { password: "wrong" } }));
    expect(res.status).toBe(401);
    expect((await readJson<ErrorBody>(res)).error).toBe("invalid_password");
  });

  it("correct password ⇒ 200 and sets an HttpOnly Set-Cookie", async () => {
    const handlers = buildHandlers();
    const res = await handlers.unlock.POST(makeRequest("POST", "/unlock", { body: { password: "hunter2" } }));
    expect(res.status).toBe(200);
    expect((await readJson<{ ok: true }>(res)).ok).toBe(true);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toContain("r3wr.access=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("a cookie minted by unlock is accepted by the access gate", async () => {
    const handlers = buildHandlers();
    const unlockRes = await handlers.unlock.POST(
      makeRequest("POST", "/unlock", { body: { password: "hunter2" } }),
    );
    const setCookie = unlockRes.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    const cookie = (setCookie ?? "").split(";")[0] ?? "";
    const res = await handlers.threads.GET(makeRequest("GET", "/threads?urlKey=/", { cookie }));
    expect(res.status).toBe(200);
  });

  it("over the attempt limit ⇒ 429 with Retry-After", async () => {
    const handlers = buildHandlers({ rateLimit: { windowMs: 60_000, maxAttempts: 1 } });
    const first = await handlers.unlock.POST(makeRequest("POST", "/unlock", { body: { password: "wrong" } }));
    expect(first.status).toBe(401);
    const second = await handlers.unlock.POST(makeRequest("POST", "/unlock", { body: { password: "wrong" } }));
    expect(second.status).toBe(429);
    expect((await readJson<ErrorBody>(second)).error).toBe("too_many_attempts");
    expect(second.headers.get("Retry-After")).toBe("60");
  });

  it("malformed body ⇒ 400 bad_request", async () => {
    const handlers = buildHandlers();
    const res = await handlers.unlock.POST(makeRequest("POST", "/unlock", { body: { password: "" } }));
    expect(res.status).toBe(400);
    expect((await readJson<ErrorBody>(res)).error).toBe("bad_request");
  });
});

// ---------------------------------------------------------------------------
// GET /threads
// ---------------------------------------------------------------------------

describe("GET /threads", () => {
  it("without urlKey, as a non-admin ⇒ 400 url_key_required", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.threads.GET(makeRequest("GET", "/threads", { cookie }));
    expect(res.status).toBe(400);
    expect((await readJson<ErrorBody>(res)).error).toBe("url_key_required");
  });

  it("without urlKey, as an admin ⇒ 200 (the triage inbox query)", async () => {
    const handlers = buildHandlers({ isAdmin: () => true });
    const res = await handlers.threads.GET(makeRequest("GET", "/threads"));
    expect(res.status).toBe(200);
    expect((await readJson<{ threads: ReviewThreadView[] }>(res)).threads).toEqual([]);
  });

  it("with urlKey, as a non-admin reviewer ⇒ 200", async () => {
    const store = createFakeStore();
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);

    await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: VALID_THREAD_BODY, cookie }),
    );

    const res = await handlers.threads.GET(makeRequest("GET", "/threads?urlKey=/", { cookie }));
    expect(res.status).toBe(200);
    const { threads } = await readJson<{ threads: ReviewThreadView[] }>(res);
    expect(threads).toHaveLength(1);
    // List rows carry commentCount, not full comment bodies.
    expect(threads[0]?.comments).toEqual([]);
    expect(threads[0]?.commentCount).toBe(1);
  });

  it("rejects an invalid query (e.g. an out-of-range limit) with 400 bad_request", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.threads.GET(makeRequest("GET", "/threads?urlKey=/&limit=9999", { cookie }));
    expect(res.status).toBe(400);
    const errorBody = await readJson<ErrorBody>(res);
    expect(errorBody.error).toBe("bad_request");
    expect(errorBody.details).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /threads
// ---------------------------------------------------------------------------

describe("POST /threads", () => {
  it("valid body ⇒ 201 with the created thread", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: { ...VALID_THREAD_BODY, title: "Broken button" }, cookie }),
    );
    expect(res.status).toBe(201);
    const { thread } = await readJson<{ thread: ReviewThreadView }>(res);
    expect(thread.title).toBe("Broken button");
    expect(thread.status).toBe("open");
    expect(thread.commentCount).toBe(1);
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]?.body).toBe(VALID_THREAD_BODY.firstComment);
  });

  it("missing required fields ⇒ 400 bad_request with zod details", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const withoutFirstComment: Record<string, unknown> = { ...VALID_THREAD_BODY };
    delete withoutFirstComment["firstComment"];
    const res = await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: withoutFirstComment, cookie }),
    );
    expect(res.status).toBe(400);
    const errorBody = await readJson<ErrorBody>(res);
    expect(errorBody.error).toBe("bad_request");
    expect(errorBody.details).toBeDefined();
  });

  it("derives the title from the first comment when omitted", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.threads.POST(makeRequest("POST", "/threads", { body: VALID_THREAD_BODY, cookie }));
    expect(res.status).toBe(201);
    const { thread } = await readJson<{ thread: ReviewThreadView }>(res);
    expect(thread.title).toBe(deriveTitle(VALID_THREAD_BODY.firstComment));
  });

  it("a forged screenshotKey (wrong prefix) is rejected with 400", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.threads.POST(
      makeRequest("POST", "/threads", {
        body: { ...VALID_THREAD_BODY, screenshotKey: "some-other-bucket/secret.png" },
        cookie,
      }),
    );
    expect(res.status).toBe(400);
    expect((await readJson<ErrorBody>(res)).error).toBe("bad_request");
  });

  it("a genuine screenshotKey minted by the screenshot endpoint is accepted", async () => {
    const store = createFakeStore();
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);

    const shotRes = await handlers.screenshot.POST(
      makeRequest("POST", "/screenshot", { formData: pngForm(makePngBytes(300, 300)), cookie }),
    );
    expect(shotRes.status).toBe(201);
    const { key } = await readJson<{ key: string }>(shotRes);
    expect(screenshotKeySchema().safeParse(key).success).toBe(true);

    const res = await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: { ...VALID_THREAD_BODY, screenshotKey: key }, cookie }),
    );
    expect(res.status).toBe(201);
    const { thread } = await readJson<{ thread: ReviewThreadView }>(res);
    expect(thread.screenshotUrl).toBe(`https://cdn.example.com/${key}`);
  });

  it("malformed JSON body ⇒ 400, not a 500", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const req = new Request("http://localhost/threads", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{not json",
    });
    const res = await handlers.threads.POST(req);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET / PATCH /threads/:id
// ---------------------------------------------------------------------------

describe("GET /threads/:id", () => {
  it("returns the thread with its comments, oldest first", async () => {
    const store = createFakeStore();
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);

    const created = await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: VALID_THREAD_BODY, cookie }),
    );
    const { thread: createdThread } = await readJson<{ thread: ReviewThreadView }>(created);

    await handlers.comments.POST(
      makeRequest("POST", `/threads/${createdThread.id}/comments`, {
        body: { body: "a reply", authorId: "u2", authorName: "Bea" },
        cookie,
      }),
      ctx(createdThread.id),
    );

    const res = await handlers.thread.GET(makeRequest("GET", `/threads/${createdThread.id}`, { cookie }), ctx(createdThread.id));
    expect(res.status).toBe(200);
    const { thread } = await readJson<{ thread: ReviewThreadView }>(res);
    expect(thread.comments.map((c) => c.body)).toEqual([VALID_THREAD_BODY.firstComment, "a reply"]);
    expect(thread.commentCount).toBe(2);
  });

  it("malformed id ⇒ 404, not a 500", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.thread.GET(makeRequest("GET", "/threads/not-a-uuid", { cookie }), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
  });

  it("unknown (but well-formed) id ⇒ 404", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const missing = fakeUuid();
    const res = await handlers.thread.GET(makeRequest("GET", `/threads/${missing}`, { cookie }), ctx(missing));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /threads/:id", () => {
  it("resolves a thread, stamping resolvedAt/resolvedBy", async () => {
    const store = createFakeStore();
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);

    const created = await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: VALID_THREAD_BODY, cookie }),
    );
    const { thread: createdThread } = await readJson<{ thread: ReviewThreadView }>(created);

    const res = await handlers.thread.PATCH(
      makeRequest("PATCH", `/threads/${createdThread.id}`, { body: { status: "resolved", resolvedBy: "Ada" }, cookie }),
      ctx(createdThread.id),
    );
    expect(res.status).toBe(200);
    const { thread } = await readJson<{ thread: ReviewThreadView }>(res);
    expect(thread.status).toBe("resolved");
    expect(thread.resolvedBy).toBe("Ada");
    expect(thread.resolvedAt).not.toBeNull();
  });

  it("reopening clears resolvedAt/resolvedBy regardless of the resolvedBy passed", async () => {
    const store = createFakeStore();
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);

    const created = await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: VALID_THREAD_BODY, cookie }),
    );
    const { thread: createdThread } = await readJson<{ thread: ReviewThreadView }>(created);

    await handlers.thread.PATCH(
      makeRequest("PATCH", `/threads/${createdThread.id}`, { body: { status: "resolved", resolvedBy: "Ada" }, cookie }),
      ctx(createdThread.id),
    );
    const reopened = await handlers.thread.PATCH(
      makeRequest("PATCH", `/threads/${createdThread.id}`, { body: { status: "open", resolvedBy: "Ignored" }, cookie }),
      ctx(createdThread.id),
    );
    const { thread } = await readJson<{ thread: ReviewThreadView }>(reopened);
    expect(thread.status).toBe("open");
    expect(thread.resolvedAt).toBeNull();
    expect(thread.resolvedBy).toBeNull();
  });

  it("unknown id ⇒ 404", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const missing = fakeUuid();
    const res = await handlers.thread.PATCH(
      makeRequest("PATCH", `/threads/${missing}`, { body: { status: "resolved" }, cookie }),
      ctx(missing),
    );
    expect(res.status).toBe(404);
  });

  it("malformed id ⇒ 404, not a 500", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.thread.PATCH(
      makeRequest("PATCH", "/threads/not-a-uuid", { body: { status: "resolved" }, cookie }),
      ctx("not-a-uuid"),
    );
    expect(res.status).toBe(404);
  });

  it("invalid status value ⇒ 400 bad_request", async () => {
    const store = createFakeStore();
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);
    const created = await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: VALID_THREAD_BODY, cookie }),
    );
    const { thread: createdThread } = await readJson<{ thread: ReviewThreadView }>(created);

    const res = await handlers.thread.PATCH(
      makeRequest("PATCH", `/threads/${createdThread.id}`, { body: { status: "archived" }, cookie }),
      ctx(createdThread.id),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /threads/:id/comments
// ---------------------------------------------------------------------------

describe("POST /threads/:id/comments", () => {
  it("valid body on an existing thread ⇒ 201 with the created comment", async () => {
    const store = createFakeStore();
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);

    const created = await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: VALID_THREAD_BODY, cookie }),
    );
    const { thread } = await readJson<{ thread: ReviewThreadView }>(created);

    const res = await handlers.comments.POST(
      makeRequest("POST", `/threads/${thread.id}/comments`, {
        body: { body: "Looks fixed now", authorId: "u2", authorName: "Bea" },
        cookie,
      }),
      ctx(thread.id),
    );
    expect(res.status).toBe(201);
    const { comment } = await readJson<{ comment: ReviewCommentView }>(res);
    expect(comment.body).toBe("Looks fixed now");
    expect(comment.threadId).toBe(thread.id);
  });

  it("unknown thread ⇒ 404", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const missing = fakeUuid();
    const res = await handlers.comments.POST(
      makeRequest("POST", `/threads/${missing}/comments`, {
        body: { body: "hi", authorId: "u", authorName: "A" },
        cookie,
      }),
      ctx(missing),
    );
    expect(res.status).toBe(404);
  });

  it("malformed id ⇒ 404, not a 500", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.comments.POST(
      makeRequest("POST", "/threads/not-a-uuid/comments", {
        body: { body: "hi", authorId: "u", authorName: "A" },
        cookie,
      }),
      ctx("not-a-uuid"),
    );
    expect(res.status).toBe(404);
  });

  it("blank body ⇒ 400 bad_request", async () => {
    const store = createFakeStore();
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);
    const created = await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: VALID_THREAD_BODY, cookie }),
    );
    const { thread } = await readJson<{ thread: ReviewThreadView }>(created);

    const res = await handlers.comments.POST(
      makeRequest("POST", `/threads/${thread.id}/comments`, {
        body: { body: "   ", authorId: "u2", authorName: "Bea" },
        cookie,
      }),
      ctx(thread.id),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /screenshot
// ---------------------------------------------------------------------------

describe("POST /screenshot", () => {
  it("valid PNG ⇒ 201 with a key matching the configured prefix", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.screenshot.POST(
      makeRequest("POST", "/screenshot", { formData: pngForm(makePngBytes(300, 300)), cookie }),
    );
    expect(res.status).toBe(201);
    const { key } = await readJson<{ key: string }>(res);
    expect(screenshotKeySchema().safeParse(key).success).toBe(true);
  });

  it("non-PNG bytes ⇒ 400 not_a_png", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const notPng = new Uint8Array(24).fill(0x41);
    const res = await handlers.screenshot.POST(
      makeRequest("POST", "/screenshot", { formData: pngForm(notPng), cookie }),
    );
    expect(res.status).toBe(400);
    expect((await readJson<ErrorBody>(res)).error).toBe("not_a_png");
  });

  it("oversize upload ⇒ 400 too_large", async () => {
    const handlers = buildHandlers({ screenshot: { maxBytes: 10 } });
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.screenshot.POST(
      makeRequest("POST", "/screenshot", { formData: pngForm(makePngBytes(300, 300)), cookie }),
    );
    expect(res.status).toBe(400);
    expect((await readJson<ErrorBody>(res)).error).toBe("too_large");
  });

  it("under the minimum dimension ⇒ 400 too_small", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.screenshot.POST(
      makeRequest("POST", "/screenshot", { formData: pngForm(makePngBytes(50, 50)), cookie }),
    );
    expect(res.status).toBe(400);
    expect((await readJson<ErrorBody>(res)).error).toBe("too_small");
  });

  it("missing file field ⇒ 400 no_file", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.screenshot.POST(
      makeRequest("POST", "/screenshot", { formData: new FormData(), cookie }),
    );
    expect(res.status).toBe(400);
    expect((await readJson<ErrorBody>(res)).error).toBe("no_file");
  });

  it("store without putScreenshot ⇒ 404", async () => {
    const handlers = buildHandlers({ store: createFakeStore({ withScreenshot: false }) });
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.screenshot.POST(
      makeRequest("POST", "/screenshot", { formData: pngForm(makePngBytes(300, 300)), cookie }),
    );
    expect(res.status).toBe(404);
    expect((await readJson<ErrorBody>(res)).error).toBe("not_found");
  });
});
