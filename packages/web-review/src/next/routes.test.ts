// @vitest-environment node
//
// jsdom's fetch polyfill hangs on `Request#formData()` for a `FormData`
// body containing a `File` (observed as a `POST /screenshot` test timeout).
// This suite needs no DOM — only the Web Fetch API — so it runs under
// Node's native, spec-compliant `Request`/`Response`/`FormData`/`File`
// instead of the package-wide jsdom default (see `vitest.config.ts`).
import { describe, expect, it } from "vitest";
import { ReviewApiError, isFeatureDisabled } from "../core/adapter";
import type { NewCommentInput, ReviewCommentView, ReviewStatus, ReviewThreadView } from "../core/types";
import { type AccessConfig, serializeAccessCookie } from "../server/access";
import type { ReviewCommentRow, ReviewThreadRow } from "../server/serialize";
import { deriveTitle } from "../server/serialize";
import { screenshotKeySchema } from "../server/validation";
import { createReviewRouteHandlers } from "./routes";
import type {
  CreateReviewRouteHandlersOptions,
  ReviewRouteHandlers,
  ReviewStore,
  ReviewStoreCreateThreadInput,
  ReviewStoreListThreadsParams,
} from "./routes";

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

/** `POST /threads`, asserting the 201 and handing back the created view. */
async function createThread(
  handlers: ReviewRouteHandlers,
  cookie: string,
  body: Record<string, unknown> = VALID_THREAD_BODY,
): Promise<ReviewThreadView> {
  const res = await handlers.threads.POST(makeRequest("POST", "/threads", { body, cookie }));
  expect(res.status).toBe(201);
  return (await readJson<{ thread: ReviewThreadView }>(res)).thread;
}

/** `GET /threads/:id`, asserting the 200 and handing back the view. */
async function getThread(
  handlers: ReviewRouteHandlers,
  cookie: string,
  id: string,
): Promise<ReviewThreadView> {
  const res = await handlers.thread.GET(makeRequest("GET", `/threads/${id}`, { cookie }), ctx(id));
  expect(res.status).toBe(200);
  return (await readJson<{ thread: ReviewThreadView }>(res)).thread;
}

/** `GET /threads?urlKey=/`, asserting the 200 and handing back the page. */
async function listThreads(
  handlers: ReviewRouteHandlers,
  cookie: string,
): Promise<ReviewThreadView[]> {
  const res = await handlers.threads.GET(makeRequest("GET", "/threads?urlKey=/", { cookie }));
  expect(res.status).toBe(200);
  return (await readJson<{ threads: ReviewThreadView[] }>(res)).threads;
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
      // The kill switch is coded `feature_disabled`, never the generic
      // `not_found` a missing thread gets — see the "404 code
      // discrimination" describe block below for why that distinction
      // matters to `isFeatureDisabled`.
      expect((await readJson<ErrorBody>(res)).error).toBe("feature_disabled");
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

  it("valid cookie sent among the app's own cookies ⇒ 200", async () => {
    // A neighbouring cookie whose value contains '=' (base64 padding) must
    // not derail the scan for ours — see `readCookieValue` in
    // `../server/access`, which is the parser this route runs.
    const handlers = buildHandlers();
    const cookie = `session=YWJjZA==; ${cookieHeaderFor(ACCESS)}; theme=dark`;
    const res = await handlers.threads.GET(makeRequest("GET", "/threads?urlKey=/", { cookie }));
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
// review.requireAccess — the same gate, exposed for a consumer's own routes
// ---------------------------------------------------------------------------

describe("review.requireAccess", () => {
  it("admits a valid cookie and reports how the caller got in", async () => {
    const handlers = buildHandlers();
    const req = makeRequest("GET", "/shot", { cookie: cookieHeaderFor(ACCESS) });
    await expect(handlers.requireAccess(req)).resolves.toEqual({ ok: true, isAdmin: false });
  });

  it("admits an admin without a cookie, and says so", async () => {
    const handlers = buildHandlers({ isAdmin: () => true });
    await expect(handlers.requireAccess(makeRequest("GET", "/shot"))).resolves.toEqual({
      ok: true,
      isAdmin: true,
    });
  });

  it("refuses an unauthenticated caller with the 401 the routes use", async () => {
    const handlers = buildHandlers();
    await expect(handlers.requireAccess(makeRequest("GET", "/shot"))).resolves.toEqual({
      ok: false,
      reason: "locked",
      status: 401,
    });
  });

  it("refuses with feature_disabled/404 when the kill switch is off, even for an admin", async () => {
    const handlers = buildHandlers({
      access: { password: "hunter2", secret: undefined },
      isAdmin: () => true,
    });
    await expect(handlers.requireAccess(makeRequest("GET", "/shot"))).resolves.toEqual({
      ok: false,
      reason: "feature_disabled",
      status: 404,
    });
  });

  it("answers exactly what the factory's own routes answer, request for request", async () => {
    // The point of exposing the guard is that an auxiliary route cannot end
    // up more permissive than the ones beside it. Assert that directly:
    // same handlers, same request, same status and error code.
    const cases: { label: string; handlers: ReviewRouteHandlers; cookie?: string }[] = [
      { label: "no cookie", handlers: buildHandlers() },
      { label: "bad cookie", handlers: buildHandlers(), cookie: "r3wr.access=garbage" },
      {
        label: "kill switch off",
        handlers: buildHandlers({ access: { password: undefined, secret: undefined }, isAdmin: () => true }),
      },
    ];

    for (const { label, handlers, cookie } of cases) {
      const verdict = await handlers.requireAccess(makeRequest("GET", "/threads?urlKey=/", { cookie }));
      const res = await handlers.threads.GET(makeRequest("GET", "/threads?urlKey=/", { cookie }));
      expect(verdict.ok, label).toBe(false);
      if (verdict.ok) continue;
      expect(res.status, label).toBe(verdict.status);
      expect((await readJson<ErrorBody>(res)).error, label).toBe(verdict.reason);
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

  // Regression: `locale` was the one optional create field that had to be
  // present, so a caller who simply left it out got a 400. It is `.nullish()`
  // now; what this guards is the other half of that fix — the omitted case
  // must reach the store and the wire as `null`, not as the `undefined` zod
  // parses it to, since `undefined` would drop the key from the JSON body.
  it("an omitted locale is accepted and lands as null, not undefined", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const withoutLocale: Record<string, unknown> = { ...VALID_THREAD_BODY };
    delete withoutLocale["locale"];

    const res = await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: withoutLocale, cookie }),
    );
    expect(res.status).toBe(201);
    const { thread } = await readJson<{ thread: ReviewThreadView }>(res);
    expect(thread.locale).toBeNull();

    // Read it back: the fake store copies `input.locale` verbatim onto the
    // row, so a `null` here proves the normalization happened before storage
    // rather than only on the create response.
    const fetched = await handlers.thread.GET(
      makeRequest("GET", `/threads/${thread.id}`, { cookie }),
      ctx(thread.id),
    );
    expect(fetched.status).toBe(200);
    const reread = await readJson<{ thread: ReviewThreadView }>(fetched);
    expect(reread.thread.locale).toBeNull();
  });

  it("an explicit null locale still round-trips as null", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: { ...VALID_THREAD_BODY, locale: null }, cookie }),
    );
    expect(res.status).toBe(201);
    expect((await readJson<{ thread: ReviewThreadView }>(res)).thread.locale).toBeNull();
  });

  it("a valid locale string still round-trips unchanged", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.threads.POST(
      makeRequest("POST", "/threads", { body: { ...VALID_THREAD_BODY, locale: "tr-TR" }, cookie }),
    );
    expect(res.status).toBe(201);
    expect((await readJson<{ thread: ReviewThreadView }>(res)).thread.locale).toBe("tr-TR");
  });

  it("an over-long locale is still rejected with 400", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.threads.POST(
      makeRequest("POST", "/threads", {
        body: { ...VALID_THREAD_BODY, locale: "a".repeat(33) },
        cookie,
      }),
    );
    expect(res.status).toBe(400);
    expect((await readJson<ErrorBody>(res)).error).toBe("bad_request");
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

  it("unknown (but well-formed) id ⇒ 404 not_found (never feature_disabled)", async () => {
    const handlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const missing = fakeUuid();
    const res = await handlers.thread.GET(makeRequest("GET", `/threads/${missing}`, { cookie }), ctx(missing));
    expect(res.status).toBe(404);
    expect((await readJson<ErrorBody>(res)).error).toBe("not_found");
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

  it("store without putScreenshot ⇒ 404 screenshots_unsupported", async () => {
    const handlers = buildHandlers({ store: createFakeStore({ withScreenshot: false }) });
    const cookie = cookieHeaderFor(ACCESS);
    const res = await handlers.screenshot.POST(
      makeRequest("POST", "/screenshot", { formData: pngForm(makePngBytes(300, 300)), cookie }),
    );
    expect(res.status).toBe(404);
    expect((await readJson<ErrorBody>(res)).error).toBe("screenshots_unsupported");
  });
});

// ---------------------------------------------------------------------------
// 404 code discrimination
// ---------------------------------------------------------------------------
//
// Three semantically different conditions all answer 404 through this
// factory: the kill switch being off, a thread id that doesn't resolve, and
// a store with no `putScreenshot`. Before this fix every one of them carried
// the identical body `{ error: "not_found" }`, which made
// `isFeatureDisabled` (`../core/adapter`) indistinguishable from a generic
// "no such thread" 404 — see that function's doc comment. These tests pin
// the three codes apart and prove `isFeatureDisabled` reacts only to the
// kill-switch one, using the REAL response bodies this factory produces
// (not hand-constructed `ReviewApiError`s), so a future change that
// collapses the codes back together fails here first.
describe("404 code discrimination", () => {
  it("the kill switch, an unknown thread, and unsupported screenshots each carry a distinct code", async () => {
    const disabledHandlers = buildHandlers({ access: { password: undefined, secret: undefined } });
    const disabledRes = await disabledHandlers.threads.GET(makeRequest("GET", "/threads?urlKey=/"));

    const enabledHandlers = buildHandlers({ store: createFakeStore({ withScreenshot: false }) });
    const cookie = cookieHeaderFor(ACCESS);
    const missing = fakeUuid();
    const missingThreadRes = await enabledHandlers.thread.GET(
      makeRequest("GET", `/threads/${missing}`, { cookie }),
      ctx(missing),
    );
    const screenshotRes = await enabledHandlers.screenshot.POST(
      makeRequest("POST", "/screenshot", { formData: pngForm(makePngBytes(300, 300)), cookie }),
    );

    const [disabledCode, missingThreadCode, screenshotCode] = await Promise.all(
      [disabledRes, missingThreadRes, screenshotRes].map(async (res) => {
        expect(res.status).toBe(404);
        return (await readJson<ErrorBody>(res)).error;
      }),
    );

    expect(disabledCode).toBe("feature_disabled");
    expect(missingThreadCode).toBe("not_found");
    expect(screenshotCode).toBe("screenshots_unsupported");
    expect(new Set([disabledCode, missingThreadCode, screenshotCode]).size).toBe(3);
  });

  // REGRESSION TEST: before the fix, every 404 above carried code
  // `not_found`, which is exactly the code `isFeatureDisabled` used to
  // check for — so it returned `true` for an unknown-thread 404 too.
  // Verified by hand against pre-fix `src/next/routes.ts` /
  // `src/core/adapter.ts`: this second assertion (`false`) failed there.
  it("isFeatureDisabled is true for the kill-switch 404 and false for an unknown-thread 404", async () => {
    const disabledHandlers = buildHandlers({ access: { password: undefined, secret: undefined } });
    const disabledRes = await disabledHandlers.threads.GET(makeRequest("GET", "/threads?urlKey=/"));
    const disabledBody = await readJson<ErrorBody>(disabledRes);
    const disabledErr = new ReviewApiError(disabledRes.status, "disabled", disabledBody.error);
    expect(isFeatureDisabled(disabledErr)).toBe(true);

    const enabledHandlers = buildHandlers();
    const cookie = cookieHeaderFor(ACCESS);
    const missing = fakeUuid();
    const missingRes = await enabledHandlers.thread.GET(
      makeRequest("GET", `/threads/${missing}`, { cookie }),
      ctx(missing),
    );
    const missingBody = await readJson<ErrorBody>(missingRes);
    const missingErr = new ReviewApiError(missingRes.status, "missing", missingBody.error);
    expect(isFeatureDisabled(missingErr)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// screenshotUrl resolution
// ---------------------------------------------------------------------------
//
// `ReviewStore.screenshotUrl` returns `string | null` OR a promise of one.
// The async half is the whole point: a private bucket cannot be served by
// string concatenation — it needs a presigned, expiring URL, and every SDK
// that mints one is asynchronous. These tests pin the properties that make
// relying on that safe: existing SYNCHRONOUS stores keep working untouched,
// a list resolves in PARALLEL rather than in series, one failing key cannot
// take down a whole response, a thread with no screenshot never reaches the
// store at all, and a class-based store that reads `this` still works.

const SHOT_A = "review/shot-a.png";
const SHOT_B = "review/shot-b.png";
const SHOT_C = "review/shot-c.png";

/**
 * A `screenshotUrl` resolver that PROVES concurrency rather than assuming
 * it. A test asserting only the resolved VALUES would pass against a
 * sequential `for (const key of keys) await resolve(key)` loop just as
 * happily, so this probe makes sequential resolution observable.
 *
 * Two overlapping mechanisms:
 *
 *  - A BARRIER: no call may settle until `expected` calls have been
 *    entered. A sequential implementation cannot satisfy that even in
 *    principle — its first call would be waiting on a barrier that only its
 *    second call can open.
 *  - A HIGH-WATER MARK of simultaneously in-flight calls, asserted against
 *    `expected`.
 *
 * The barrier carries a safety release so a sequential implementation fails
 * on a legible assertion (a `maxInFlight` of 1) instead of deadlocking
 * until the suite times out. Under a correct `Promise.all` that timer never
 * fires: every call is entered in the same synchronous burst, so the
 * barrier opens immediately and the probe costs no wall-clock time.
 */
function concurrencyProbe(expected: number, safetyMs = 2_000) {
  /** Every key the resolver was asked about, in call order. */
  const keys: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let open!: () => void;
  const allEntered = new Promise<void>((resolve) => {
    open = resolve;
  });
  const safety = setTimeout(() => open(), safetyMs);

  return {
    keys,
    get maxInFlight() {
      return maxInFlight;
    },
    /** Clears the safety timer so a finished test leaves nothing pending. */
    dispose() {
      clearTimeout(safety);
      open();
    },
    screenshotUrl: async (key: string): Promise<string> => {
      keys.push(key);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (keys.length >= expected) {
        clearTimeout(safety);
        open();
      }
      await allEntered;
      inFlight -= 1;
      return `https://signed.example.com/${key}`;
    },
  };
}

/**
 * A class-based store whose `screenshotUrl` reads `this`. `routes.ts`
 * deliberately invokes `store.screenshotUrl(...)` as a method rather than
 * extracting it into a bare local reference — extracting one would unbind
 * `this` and make `this.cdnBase` below `undefined` at call time. This class
 * is what pins that property; every other method delegates to a plain fake
 * store so only the `this`-dependence is under test. It is async as well as
 * `this`-dependent, so it covers both halves at once.
 */
class ClassBasedStore implements ReviewStore {
  private readonly inner = createFakeStore({ withScreenshot: false });

  constructor(private readonly cdnBase: string) {}

  listThreads(params: ReviewStoreListThreadsParams) {
    return this.inner.listThreads(params);
  }

  getThread(id: string) {
    return this.inner.getThread(id);
  }

  createThread(input: ReviewStoreCreateThreadInput) {
    return this.inner.createThread(input);
  }

  addComment(threadId: string, input: NewCommentInput) {
    return this.inner.addComment(threadId, input);
  }

  setStatus(threadId: string, status: ReviewStatus, resolvedBy: string | null) {
    return this.inner.setStatus(threadId, status, resolvedBy);
  }

  async screenshotUrl(key: string): Promise<string> {
    await Promise.resolve();
    return `${this.cdnBase}/${key}`;
  }
}

describe("screenshotUrl resolution", () => {
  it("an async screenshotUrl resolves on the create, get, patch and list paths", async () => {
    const store = createFakeStore({ withScreenshot: false });
    store.screenshotUrl = async (key) => {
      await Promise.resolve();
      return `https://signed.example.com/${key}?sig=abc`;
    };
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);
    const expected = `https://signed.example.com/${SHOT_A}?sig=abc`;

    const created = await createThread(handlers, cookie, {
      ...VALID_THREAD_BODY,
      screenshotKey: SHOT_A,
    });
    expect(created.screenshotUrl).toBe(expected);

    expect((await getThread(handlers, cookie, created.id)).screenshotUrl).toBe(expected);

    const listed = await listThreads(handlers, cookie);
    expect(listed.map((thread) => thread.screenshotUrl)).toEqual([expected]);

    const patched = await handlers.thread.PATCH(
      makeRequest("PATCH", `/threads/${created.id}`, { body: { status: "resolved" }, cookie }),
      ctx(created.id),
    );
    expect(patched.status).toBe(200);
    expect((await readJson<{ thread: ReviewThreadView }>(patched)).thread.screenshotUrl).toBe(
      expected,
    );
  });

  // THE COMPATIBILITY GUARANTEE. Widening the return type to
  // `string | null | Promise<string | null>` is not a breaking change,
  // because `screenshotUrl` is a method consumers IMPLEMENT and this
  // package CALLS: variance runs the helpful way and an existing
  // synchronous implementation still satisfies the wider type. The
  // assignment below is deliberately a plain, non-async function with no
  // cast and no annotation — if the widening had broken sync stores, this
  // file would fail to compile before it ever ran.
  it("a synchronous screenshotUrl still works untouched", async () => {
    const store = createFakeStore({ withScreenshot: false });
    store.screenshotUrl = (key) => `https://cdn.example.com/${key}`;
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);
    const expected = `https://cdn.example.com/${SHOT_A}`;

    const created = await createThread(handlers, cookie, {
      ...VALID_THREAD_BODY,
      screenshotKey: SHOT_A,
    });
    expect(created.screenshotUrl).toBe(expected);
    expect((await getThread(handlers, cookie, created.id)).screenshotUrl).toBe(expected);
    expect((await listThreads(handlers, cookie)).map((t) => t.screenshotUrl)).toEqual([expected]);
  });

  it("a synchronous screenshotUrl returning null still reports null", async () => {
    const store = createFakeStore({ withScreenshot: false });
    store.screenshotUrl = () => null;
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);

    const created = await createThread(handlers, cookie, {
      ...VALID_THREAD_BODY,
      screenshotKey: SHOT_A,
    });
    expect(created.screenshotUrl).toBeNull();
    expect((await getThread(handlers, cookie, created.id)).screenshotUrl).toBeNull();
  });

  it("a store with no screenshotUrl at all yields null everywhere", async () => {
    const store = createFakeStore({ withScreenshot: false });
    // `in` rather than a bare `store.screenshotUrl` reference: the method is
    // genuinely absent, not present-and-undefined, and reading it bare is
    // exactly the unbound-method pattern `routes.ts` avoids on purpose.
    expect("screenshotUrl" in store).toBe(false);
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);

    const created = await createThread(handlers, cookie, {
      ...VALID_THREAD_BODY,
      screenshotKey: SHOT_A,
    });
    expect(created.screenshotUrl).toBeNull();
    expect((await getThread(handlers, cookie, created.id)).screenshotUrl).toBeNull();
    expect((await listThreads(handlers, cookie)).map((t) => t.screenshotUrl)).toEqual([null]);
  });

  // THE PARALLELISM GUARANTEE. `GET /threads` returns up to 500 rows;
  // resolving presigned URLs one after another would turn a single round
  // trip into N sequential ones and make a real list unusable. The probe —
  // not the returned values — is what proves it: see `concurrencyProbe`.
  it("resolves a list of threads concurrently, not one after another", async () => {
    const store = createFakeStore({ withScreenshot: false });
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);
    const keys = [SHOT_A, SHOT_B, SHOT_C, "review/shot-d.png", "review/shot-e.png"];

    // Created BEFORE the probe is attached: the create path resolves its own
    // one-row page, and those single calls would open the barrier early.
    for (const screenshotKey of keys) {
      await createThread(handlers, cookie, { ...VALID_THREAD_BODY, screenshotKey });
    }

    const probe = concurrencyProbe(keys.length);
    store.screenshotUrl = probe.screenshotUrl;
    try {
      const listed = await listThreads(handlers, cookie);

      expect(listed).toHaveLength(keys.length);
      // Every call was in flight at the same moment. A sequential
      // implementation tops out at 1 here.
      expect(probe.maxInFlight).toBe(keys.length);
      expect([...probe.keys].sort()).toEqual([...keys].sort());
      // …and every row still carries its own URL, so the concurrency did
      // not come at the cost of correctness.
      expect(new Set(listed.map((thread) => thread.screenshotUrl))).toEqual(
        new Set(keys.map((key) => `https://signed.example.com/${key}`)),
      );
    } finally {
      probe.dispose();
    }
  });

  it("a rejected screenshotUrl nulls that thread alone and leaves its siblings intact", async () => {
    const store = createFakeStore({ withScreenshot: false });
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);

    const created: ReviewThreadView[] = [];
    for (const screenshotKey of [SHOT_A, SHOT_B, SHOT_C]) {
      created.push(await createThread(handlers, cookie, { ...VALID_THREAD_BODY, screenshotKey }));
    }

    store.screenshotUrl = async (key) => {
      await Promise.resolve();
      if (key === SHOT_B) throw new Error("presign failed: object missing");
      return `https://signed.example.com/${key}`;
    };

    const listed = await listThreads(handlers, cookie);
    expect(listed).toHaveLength(3);

    // One rejected key must not 500 the page, nor null out its siblings —
    // the same posture the write path takes, where a failed capture never
    // costs a reviewer their comment.
    const urls = new Map(listed.map((thread) => [thread.id, thread.screenshotUrl]));
    expect(urls.get(created[0]?.id ?? "")).toBe(`https://signed.example.com/${SHOT_A}`);
    expect(urls.get(created[1]?.id ?? "")).toBeNull();
    expect(urls.get(created[2]?.id ?? "")).toBe(`https://signed.example.com/${SHOT_C}`);

    // The single-thread read path degrades the same way.
    expect((await getThread(handlers, cookie, created[1]?.id ?? "")).screenshotUrl).toBeNull();
  });

  it("a synchronously thrown screenshotUrl error is survivable too", async () => {
    const store = createFakeStore({ withScreenshot: false });
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);

    store.screenshotUrl = (key) => {
      if (key === SHOT_B) throw new Error("misconfigured bucket");
      return `https://cdn.example.com/${key}`;
    };

    const ok = await createThread(handlers, cookie, {
      ...VALID_THREAD_BODY,
      screenshotKey: SHOT_A,
    });
    expect(ok.screenshotUrl).toBe(`https://cdn.example.com/${SHOT_A}`);

    const broken = await createThread(handlers, cookie, {
      ...VALID_THREAD_BODY,
      screenshotKey: SHOT_B,
    });
    expect(broken.screenshotUrl).toBeNull();
  });

  it("a thread with a null screenshotKey never invokes the resolver", async () => {
    const store = createFakeStore({ withScreenshot: false });
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);
    const asked: string[] = [];
    store.screenshotUrl = (key) => {
      asked.push(key);
      return `https://cdn.example.com/${key}`;
    };

    const created = await createThread(handlers, cookie);
    expect(created.screenshotUrl).toBeNull();
    expect((await getThread(handlers, cookie, created.id)).screenshotUrl).toBeNull();
    expect((await listThreads(handlers, cookie)).map((t) => t.screenshotUrl)).toEqual([null]);
    expect(asked).toEqual([]);
  });

  // Deduplication falls out of needing a key→URL map at all: distinct keys
  // are what fills it. Two threads sharing one screenshot therefore cost
  // one presign, not two.
  it("resolves each distinct key once, however many threads share it", async () => {
    const store = createFakeStore({ withScreenshot: false });
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);

    for (const screenshotKey of [SHOT_A, SHOT_A, SHOT_A, SHOT_B]) {
      await createThread(handlers, cookie, { ...VALID_THREAD_BODY, screenshotKey });
    }

    const asked: string[] = [];
    store.screenshotUrl = async (key) => {
      asked.push(key);
      await Promise.resolve();
      return `https://signed.example.com/${key}`;
    };

    const listed = await listThreads(handlers, cookie);
    expect(listed).toHaveLength(4);
    expect([...asked].sort()).toEqual([SHOT_A, SHOT_B]);
    expect(listed.filter((t) => t.screenshotUrl === `https://signed.example.com/${SHOT_A}`)).toHaveLength(3);
    expect(listed.filter((t) => t.screenshotUrl === `https://signed.example.com/${SHOT_B}`)).toHaveLength(1);
  });

  // `POST /threads/:id/comments` answers with a COMMENT view, not a thread
  // view — there is no `screenshotUrl` on that wire shape for the route to
  // resolve, and nothing to await. What the add-comment path must not do is
  // disturb the thread's screenshot, so this covers it from the read side:
  // the reply lands, and the next read of that thread still resolves.
  it("adding a comment leaves the thread's async screenshotUrl resolving", async () => {
    const store = createFakeStore({ withScreenshot: false });
    store.screenshotUrl = async (key) => {
      await Promise.resolve();
      return `https://signed.example.com/${key}`;
    };
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);

    const created = await createThread(handlers, cookie, {
      ...VALID_THREAD_BODY,
      screenshotKey: SHOT_A,
    });

    const res = await handlers.comments.POST(
      makeRequest("POST", `/threads/${created.id}/comments`, {
        body: { body: "still broken", authorId: "u2", authorName: "Bea" },
        cookie,
      }),
      ctx(created.id),
    );
    expect(res.status).toBe(201);
    const { comment } = await readJson<{ comment: ReviewCommentView }>(res);
    expect(comment.body).toBe("still broken");

    const reread = await getThread(handlers, cookie, created.id);
    expect(reread.screenshotUrl).toBe(`https://signed.example.com/${SHOT_A}`);
    expect(reread.commentCount).toBe(2);
  });

  it("a class-based store whose screenshotUrl reads `this` keeps working", async () => {
    const store = new ClassBasedStore("https://class.example.com");
    const handlers = buildHandlers({ store });
    const cookie = cookieHeaderFor(ACCESS);
    const expected = `https://class.example.com/${SHOT_A}`;

    const created = await createThread(handlers, cookie, {
      ...VALID_THREAD_BODY,
      screenshotKey: SHOT_A,
    });
    expect(created.screenshotUrl).toBe(expected);
    expect((await getThread(handlers, cookie, created.id)).screenshotUrl).toBe(expected);
    expect((await listThreads(handlers, cookie)).map((t) => t.screenshotUrl)).toEqual([expected]);
  });
});
