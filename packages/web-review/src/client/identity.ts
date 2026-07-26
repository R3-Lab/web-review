"use client";

/**
 * Reviewer identity — minted in the browser, persisted to localStorage.
 *
 * Ported from a working single-app review tool's `feedback/identity.ts`.
 * The reviewer names themselves once; we mint a stable uuid and persist
 * `{ id, name }` under one localStorage key. Deliberately NOT an account:
 * stakeholders reviewing copy don't have logins, and requiring one is how
 * internal review tools die. Whatever gate actually authorises writes (a
 * shared password via `ReviewAdapter.unlock`, or the preview deployment's
 * own auth) is separate from this identity.
 *
 * The reference hardcoded its storage key (`"ayasofya.feedback.identity"`);
 * here it derives from `ReviewConfig.storagePrefix` so multiple consumers
 * (or multiple `@r3lab/web-review` mounts) never collide in the same
 * origin's localStorage.
 */

import type { ReviewerIdentity } from "../core/types";

/** The localStorage key holding the persisted identity JSON for `prefix`. */
export function identityStorageKey(prefix: string): string {
  return `${prefix}.identity`;
}

/**
 * Read the persisted identity for `prefix`, or `null` when unset, malformed,
 * or localStorage is unavailable (e.g. Safari private mode throws on
 * access — this degrades to `null` rather than throwing).
 */
export function getIdentity(prefix: string): ReviewerIdentity | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(identityStorageKey(prefix));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReviewerIdentity>;
    if (
      parsed &&
      typeof parsed.id === "string" &&
      typeof parsed.name === "string"
    ) {
      return { id: parsed.id, name: parsed.name };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ensure an identity exists for `name` under `prefix`: reuse the persisted
 * id when present (only updating the display name), otherwise mint a fresh
 * uuid. Persists and returns the identity.
 *
 * Storage may be unavailable (private mode / quota) — the in-memory
 * identity is still returned so the current submission can proceed even
 * when the write silently fails.
 */
export function ensureIdentity(
  prefix: string,
  name: string,
): ReviewerIdentity {
  const trimmed = name.trim();
  const existing = getIdentity(prefix);
  const identity: ReviewerIdentity = {
    id: existing?.id ?? newId(),
    name: trimmed || existing?.name || "Anonymous",
  };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        identityStorageKey(prefix),
        JSON.stringify(identity),
      );
    } catch {
      // Storage may be unavailable (private mode / quota); the in-memory
      // identity is still returned so the current submission can proceed.
    }
  }
  return identity;
}

/** A uuid for the identity id (crypto.randomUUID where available). */
function newId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  // RFC4122-ish v4 from getRandomValues; final fallback for old webviews.
  const bytes = new Uint8Array(16);
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
