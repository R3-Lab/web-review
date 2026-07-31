import { describe, expect, it } from "vitest";
import {
  accessCookieName,
  clientIp,
  getAccessConfig,
  mintAccessToken,
  passwordMatches,
  readCookieValue,
  requireReviewAccess,
  resolveAccess,
  serializeAccessCookie,
  toSetCookieHeader,
  verifyAccessToken,
} from "./access";
import type { AccessConfig, ReviewAccessOptions } from "./access";

const config: AccessConfig = { password: "hunter2", secret: "signing-secret" };

describe("getAccessConfig — kill switch / fail closed", () => {
  it("returns a config when both password and secret are set", () => {
    expect(getAccessConfig({ password: "p", secret: "s" })).toEqual({ password: "p", secret: "s" });
  });

  it("returns null when password is missing", () => {
    expect(getAccessConfig({ password: undefined, secret: "s" })).toBeNull();
    expect(getAccessConfig({ password: "", secret: "s" })).toBeNull();
  });

  it("returns null when secret is missing even though password is set (fail closed, not unsigned)", () => {
    expect(getAccessConfig({ password: "p", secret: undefined })).toBeNull();
    expect(getAccessConfig({ password: "p", secret: "" })).toBeNull();
  });

  it("returns null when both are missing", () => {
    expect(getAccessConfig({ password: undefined, secret: undefined })).toBeNull();
  });
});

describe("mintAccessToken / verifyAccessToken — round trip", () => {
  it("verifies a freshly minted token", () => {
    const token = mintAccessToken(config, 1_000);
    expect(verifyAccessToken(token, config, 1_000)).toBe(true);
  });

  it("verifies right up until expiry, but not after", () => {
    const now = 1_000;
    const token = mintAccessToken(config, now);
    const ttlMs = 7 * 24 * 60 * 60 * 1000;
    expect(verifyAccessToken(token, config, now + ttlMs - 1)).toBe(true);
    expect(verifyAccessToken(token, config, now + ttlMs + 1)).toBe(false);
  });

  it("rejects an undefined token", () => {
    expect(verifyAccessToken(undefined, config)).toBe(false);
  });

  it("rejects a malformed token (wrong number of segments)", () => {
    expect(verifyAccessToken("v1.123", config)).toBe(false);
    expect(verifyAccessToken("v1.123.abc.extra", config)).toBe(false);
    expect(verifyAccessToken("garbage", config)).toBe(false);
  });

  it("rejects a token with a non-numeric expiry", () => {
    expect(verifyAccessToken("v1.notanumber.abc", config)).toBe(false);
  });
});

describe("verifyAccessToken — tamper resistance", () => {
  it("rejects a tampered signature", () => {
    const token = mintAccessToken(config, 1_000);
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -1)}X`;
    expect(verifyAccessToken(tampered, config, 1_000)).toBe(false);
  });

  it("rejects a tampered (extended) expiry even if the signature format still parses", () => {
    const token = mintAccessToken(config, 1_000);
    const parts = token.split(".");
    // Extend the expiry without re-signing — the signature no longer matches.
    const tampered = `${parts[0]}.999999999999999.${parts[2]}`;
    expect(verifyAccessToken(tampered, config, 1_000)).toBe(false);
  });

  it("rejects an expired token", () => {
    const now = 1_000;
    const token = mintAccessToken(config, now);
    const ttlMs = 7 * 24 * 60 * 60 * 1000;
    expect(verifyAccessToken(token, config, now + ttlMs + 1)).toBe(false);
  });

  it("rejects a wrong-version token", () => {
    const token = mintAccessToken(config, 1_000);
    const parts = token.split(".");
    const tampered = `v2.${parts[1]}.${parts[2]}`;
    expect(verifyAccessToken(tampered, config, 1_000)).toBe(false);
  });
});

describe("verifyAccessToken — password rotation invalidates cookies", () => {
  it("a cookie minted under password A fails to verify after rotating to password B", () => {
    const configA: AccessConfig = { password: "password-a", secret: "shared-secret" };
    const configB: AccessConfig = { password: "password-b", secret: "shared-secret" };
    const token = mintAccessToken(configA, 1_000);

    expect(verifyAccessToken(token, configA, 1_000)).toBe(true);
    expect(verifyAccessToken(token, configB, 1_000)).toBe(false);
  });
});

describe("passwordMatches", () => {
  it("is true for matching passwords", () => {
    expect(passwordMatches("hunter2", "hunter2")).toBe(true);
  });

  it("is false for a mismatched password", () => {
    expect(passwordMatches("hunter2", "hunter3")).toBe(false);
  });

  it("is false for passwords of different lengths (no length-mismatch throw)", () => {
    expect(passwordMatches("short", "a-much-longer-password")).toBe(false);
  });
});

describe("accessCookieName", () => {
  it("uses the default package prefix", () => {
    expect(accessCookieName()).toBe("r3wr.access");
  });

  it("honors a custom prefix", () => {
    expect(accessCookieName("myapp")).toBe("myapp.access");
  });
});

describe("serializeAccessCookie / toSetCookieHeader", () => {
  it("mints a verifiable token as the cookie value", () => {
    const descriptor = serializeAccessCookie(config, { now: 1_000 });
    expect(verifyAccessToken(descriptor.value, config, 1_000)).toBe(true);
  });

  it("sets secure httpOnly lax attributes with the expected maxAge", () => {
    const descriptor = serializeAccessCookie(config, { secure: true });
    expect(descriptor.attributes.httpOnly).toBe(true);
    expect(descriptor.attributes.sameSite).toBe("lax");
    expect(descriptor.attributes.secure).toBe(true);
    expect(descriptor.attributes.path).toBe("/");
    expect(descriptor.attributes.maxAge).toBe(7 * 24 * 60 * 60);
  });

  it("renders a Set-Cookie header string", () => {
    const descriptor = serializeAccessCookie(config, { secure: true, cookiePrefix: "myapp" });
    const header = toSetCookieHeader(descriptor);
    expect(header).toContain("myapp.access=");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
  });

  it("omits Secure when explicitly disabled", () => {
    const descriptor = serializeAccessCookie(config, { secure: false });
    const header = toSetCookieHeader(descriptor);
    expect(header).not.toContain("Secure");
  });
});

describe("resolveAccess — ordering and admin fallback", () => {
  it("succeeds via a valid cookie without ever calling the admin predicate", async () => {
    const token = mintAccessToken(config, 1_000);
    let called = false;
    const isAdmin = () => {
      called = true;
      return true;
    };
    const verdict = await resolveAccess(token, config, isAdmin, 1_000);
    expect(verdict).toEqual({ ok: true, isAdmin: false });
    expect(called).toBe(false);
  });

  it("falls back to the admin predicate when the cookie is absent", async () => {
    const verdict = await resolveAccess(undefined, config, () => true, 1_000);
    expect(verdict).toEqual({ ok: true, isAdmin: true });
  });

  it("falls back to the admin predicate when the cookie is invalid", async () => {
    const verdict = await resolveAccess("garbage", config, () => Promise.resolve(true), 1_000);
    expect(verdict).toEqual({ ok: true, isAdmin: true });
  });

  it("locks out when there is no cookie and no admin predicate", async () => {
    const verdict = await resolveAccess(undefined, config, undefined, 1_000);
    expect(verdict).toEqual({ ok: false });
  });

  it("locks out when the admin predicate returns false", async () => {
    const verdict = await resolveAccess(undefined, config, () => false, 1_000);
    expect(verdict).toEqual({ ok: false });
  });

  it("treats a throwing admin predicate as 'not admin' rather than propagating", async () => {
    const isAdmin = () => {
      throw new Error("db down");
    };
    await expect(resolveAccess(undefined, config, isAdmin, 1_000)).resolves.toEqual({ ok: false });
  });
});

describe("readCookieValue", () => {
  it("reads a lone cookie", () => {
    expect(readCookieValue("r3wr.access=abc", "r3wr.access")).toBe("abc");
  });

  it("keeps a value containing '=' intact (splits at the first '=' only)", () => {
    // The bug this function exists to prevent: splitting on every '='
    // truncates base64 padding — and a truncated token fails its signature
    // check, so the symptom is an unexplained 401 on a perfectly good
    // cookie.
    expect(readCookieValue("sid=YWJjZA==", "sid")).toBe("YWJjZA==");
    expect(readCookieValue("sid=a=b=c=d", "sid")).toBe("a=b=c=d");
  });

  it("finds the requested cookie among several, wherever it sits", () => {
    const header = "session=xyz; r3wr.access=wanted; theme=dark";
    expect(readCookieValue(header, "r3wr.access")).toBe("wanted");
    expect(readCookieValue(header, "session")).toBe("xyz");
    expect(readCookieValue(header, "theme")).toBe("dark");
  });

  it("tolerates surrounding whitespace around names and values", () => {
    expect(readCookieValue("  session=xyz ;   r3wr.access =  wanted  ", "r3wr.access")).toBe(
      "wanted",
    );
  });

  it("returns undefined for an absent header, in every shape a server reports one", () => {
    expect(readCookieValue(null, "r3wr.access")).toBeUndefined();
    expect(readCookieValue(undefined, "r3wr.access")).toBeUndefined();
    expect(readCookieValue("", "r3wr.access")).toBeUndefined();
  });

  it("returns undefined when the header has other cookies but not this one", () => {
    expect(readCookieValue("session=xyz; theme=dark", "r3wr.access")).toBeUndefined();
  });

  it("matches the cookie name exactly, never as a suffix or prefix", () => {
    expect(readCookieValue("other.r3wr.access=nope", "r3wr.access")).toBeUndefined();
    expect(readCookieValue("r3wr.access.stale=nope", "r3wr.access")).toBeUndefined();
  });

  it("skips a valueless segment without derailing the scan", () => {
    expect(readCookieValue("flag; r3wr.access=wanted", "r3wr.access")).toBe("wanted");
  });

  it("percent-decodes an encoded value", () => {
    expect(readCookieValue("note=a%20b", "note")).toBe("a b");
  });

  it("hands back the raw value when a percent-escape is malformed, rather than throwing", () => {
    expect(readCookieValue("note=100%", "note")).toBe("100%");
  });

  it("round-trips a real minted token through a Cookie header alongside other cookies", () => {
    const descriptor = serializeAccessCookie(config, { now: 1_000 });
    const header = `session=xyz; ${descriptor.name}=${descriptor.value}; theme=dark`;
    const token = readCookieValue(header, descriptor.name);
    expect(verifyAccessToken(token, config, 1_000)).toBe(true);
  });
});

describe("requireReviewAccess", () => {
  const enabled: ReviewAccessOptions = { password: "hunter2", secret: "signing-secret" };

  function request(cookie?: string): Request {
    const headers = new Headers();
    if (cookie !== undefined) headers.set("cookie", cookie);
    return new Request("http://localhost/api/review/shot", { headers });
  }

  function cookieFor(options: ReviewAccessOptions, now?: number): string {
    const descriptor = serializeAccessCookie(
      { password: options.password ?? "", secret: options.secret ?? "" },
      { cookiePrefix: options.cookiePrefix, now },
    );
    return `${descriptor.name}=${descriptor.value}`;
  }

  it("admits a valid signed cookie without consulting the admin predicate", async () => {
    let called = false;
    const verdict = await requireReviewAccess(request(cookieFor(enabled, 1_000)), {
      access: enabled,
      isAdmin: () => {
        called = true;
        return true;
      },
      now: 1_000,
    });
    expect(verdict).toEqual({ ok: true, isAdmin: false });
    expect(called).toBe(false);
  });

  it("admits a valid cookie sent alongside the app's own cookies", async () => {
    const verdict = await requireReviewAccess(
      request(`session=xyz; ${cookieFor(enabled, 1_000)}; theme=dark`),
      { access: enabled, now: 1_000 },
    );
    expect(verdict).toEqual({ ok: true, isAdmin: false });
  });

  it("refuses when no Cookie header is sent at all", async () => {
    const verdict = await requireReviewAccess(request(), { access: enabled, now: 1_000 });
    expect(verdict).toEqual({ ok: false, reason: "locked", status: 401 });
  });

  it("refuses a malformed cookie value", async () => {
    const verdict = await requireReviewAccess(request(`${accessCookieName()}=garbage`), {
      access: enabled,
      now: 1_000,
    });
    expect(verdict).toEqual({ ok: false, reason: "locked", status: 401 });
  });

  it("refuses a tampered signature", async () => {
    const parts = mintAccessToken({ password: "hunter2", secret: "signing-secret" }, 1_000).split(
      ".",
    );
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -1)}X`;
    const verdict = await requireReviewAccess(request(`${accessCookieName()}=${tampered}`), {
      access: enabled,
      now: 1_000,
    });
    expect(verdict).toEqual({ ok: false, reason: "locked", status: 401 });
  });

  it("refuses an expired cookie", async () => {
    const ttlMs = 7 * 24 * 60 * 60 * 1000;
    const cookie = cookieFor(enabled, 1_000);
    await expect(
      requireReviewAccess(request(cookie), { access: enabled, now: 1_000 + ttlMs - 1 }),
    ).resolves.toEqual({ ok: true, isAdmin: false });
    await expect(
      requireReviewAccess(request(cookie), { access: enabled, now: 1_000 + ttlMs + 1 }),
    ).resolves.toEqual({ ok: false, reason: "locked", status: 401 });
  });

  it("honours a custom cookie prefix, and ignores a cookie under the default name", async () => {
    const prefixed: ReviewAccessOptions = { ...enabled, cookiePrefix: "myapp" };
    const wrongName = cookieFor(enabled, 1_000); // minted under "r3wr.access"
    await expect(
      requireReviewAccess(request(wrongName), { access: prefixed, now: 1_000 }),
    ).resolves.toEqual({ ok: false, reason: "locked", status: 401 });
    await expect(
      requireReviewAccess(request(cookieFor(prefixed, 1_000)), { access: prefixed, now: 1_000 }),
    ).resolves.toEqual({ ok: true, isAdmin: false });
  });

  it("admits via the admin predicate when configuration is otherwise valid", async () => {
    const verdict = await requireReviewAccess(request(), {
      access: enabled,
      isAdmin: () => Promise.resolve(true),
      now: 1_000,
    });
    expect(verdict).toEqual({ ok: true, isAdmin: true });
  });

  it("treats a throwing admin predicate as 'not admin' rather than propagating", async () => {
    await expect(
      requireReviewAccess(request(), {
        access: enabled,
        isAdmin: () => {
          throw new Error("db down");
        },
        now: 1_000,
      }),
    ).resolves.toEqual({ ok: false, reason: "locked", status: 401 });
  });
});

// This is the security-critical block for the guard: a misconfigured
// deployment must be MORE closed than a configured one, never less. An
// `isAdmin` predicate that says yes is the tempting escape hatch — it is the
// consumer's own administrator, after all — and admitting them is precisely
// what would hide a missing REVIEW_SECRET until a stranger found it instead.
describe("requireReviewAccess — fail closed, even for an admin", () => {
  function request(): Request {
    return new Request("http://localhost/api/review/shot");
  }

  const alwaysAdmin = () => {
    throw new Error("isAdmin must never be consulted while the kill switch is off");
  };

  const misconfigurations: [label: string, access: ReviewAccessOptions][] = [
    ["secret unset", { password: "hunter2", secret: undefined }],
    ["secret empty", { password: "hunter2", secret: "" }],
    ["password unset", { password: undefined, secret: "signing-secret" }],
    ["password empty", { password: "", secret: "signing-secret" }],
    ["neither set", { password: undefined, secret: undefined }],
  ];

  for (const [label, access] of misconfigurations) {
    it(`${label} ⇒ feature_disabled/404 even though isAdmin would admit`, async () => {
      const verdict = await requireReviewAccess(request(), { access, isAdmin: alwaysAdmin });
      expect(verdict).toEqual({ ok: false, reason: "feature_disabled", status: 404 });
    });
  }

  it("never calls the admin predicate at all while the kill switch is off", async () => {
    let called = false;
    const verdict = await requireReviewAccess(request(), {
      access: { password: "hunter2", secret: undefined },
      isAdmin: () => {
        called = true;
        return true;
      },
    });
    expect(called).toBe(false);
    expect(verdict.ok).toBe(false);
  });

  it("refuses a cookie that WAS valid before the secret went missing", async () => {
    // Same request, same cookie; only the deployment's config changed.
    const descriptor = serializeAccessCookie(config, { now: 1_000 });
    const headers = new Headers({ cookie: `${descriptor.name}=${descriptor.value}` });
    const req = () => new Request("http://localhost/api/review/shot", { headers });

    await expect(
      requireReviewAccess(req(), { access: { ...config }, now: 1_000 }),
    ).resolves.toEqual({ ok: true, isAdmin: false });
    await expect(
      requireReviewAccess(req(), {
        access: { password: config.password, secret: undefined },
        now: 1_000,
      }),
    ).resolves.toEqual({ ok: false, reason: "feature_disabled", status: 404 });
  });
});

describe("clientIp", () => {
  it("uses the first entry of x-forwarded-for", () => {
    const headers: Record<string, string> = { "x-forwarded-for": "1.2.3.4, 5.6.7.8" };
    expect(clientIp((name) => headers[name])).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const headers: Record<string, string> = { "x-real-ip": "9.9.9.9" };
    expect(clientIp((name) => headers[name])).toBe("9.9.9.9");
  });

  it("falls back to 'unknown' when neither header is present", () => {
    expect(clientIp(() => undefined)).toBe("unknown");
    expect(clientIp(() => null)).toBe("unknown");
  });

  it("trims whitespace around the forwarded entry", () => {
    const headers: Record<string, string> = { "x-forwarded-for": "  1.2.3.4  , 5.6.7.8" };
    expect(clientIp((name) => headers[name])).toBe("1.2.3.4");
  });
});
