/**
 * `UnlockDialog` interaction tests (vitest + jsdom + React Testing Library).
 *
 * `PasswordForm` (the shared field `UnlockDialog` wraps, also reused inline
 * by `Composer`/`ThreadDetail`) is exercised here through `UnlockDialog` and
 * again through those two components' own 401-recovery tests.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { ReviewApiError, unlockErrorMessage } from "../core/adapter";
import { resolveConfig } from "../core/config";
import { UnlockDialog } from "./unlock-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A bare function type, not `ReviewAdapter["unlock"]` — see the matching
 *  comment in `./composer.test.tsx`'s `makeAdapter` for why: naming the
 *  interface's method type here would trip `@typescript-eslint/unbound-method`
 *  the moment a test references `adapter.unlock` as a bare value. */
type UnlockFn = (password: string) => Promise<void>;

// Deliberately NOT typed against the `ReviewAdapter` interface — see the
// matching comment in `./composer.test.tsx`'s `makeAdapter`.
function makeAdapter(unlock: UnlockFn) {
  return {
    listThreads: vi.fn(),
    getThread: vi.fn(),
    createThread: vi.fn(),
    addComment: vi.fn(),
    setStatus: vi.fn(),
    unlock,
  };
}

function renderDialog(unlock: UnlockFn) {
  const adapter = makeAdapter(unlock);
  const config = resolveConfig({ adapter });
  const onClose = vi.fn();
  const onUnlocked = vi.fn();
  const utils = render(<UnlockDialog config={config} onClose={onClose} onUnlocked={onUnlocked} />);
  return { ...utils, adapter, onClose, onUnlocked };
}

describe("UnlockDialog", () => {
  it("calls adapter.unlock then onUnlocked on a correct password", async () => {
    const user = userEvent.setup();
    const { adapter, onUnlocked } = renderDialog(vi.fn(() => Promise.resolve()));

    await user.type(screen.getByPlaceholderText(/review password/i), "correct-password");
    await user.click(screen.getByRole("button", { name: /^unlock$/i }));

    await waitFor(() => expect(adapter.unlock).toHaveBeenCalledWith("correct-password"));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
  });

  it("surfaces unlockErrorMessage's text for a wrong password", async () => {
    const user = userEvent.setup();
    const err = new ReviewApiError(401, "bad password");
    renderDialog(vi.fn(() => Promise.reject(err)));

    await user.type(screen.getByPlaceholderText(/review password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /^unlock$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(unlockErrorMessage(err));
  });

  it("surfaces the retry-after text on a 429", async () => {
    const user = userEvent.setup();
    const err = new ReviewApiError(429, "too many", undefined, 30);
    renderDialog(vi.fn(() => Promise.reject(err)));

    await user.type(screen.getByPlaceholderText(/review password/i), "whatever");
    await user.click(screen.getByRole("button", { name: /^unlock$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(unlockErrorMessage(err));
    expect(alert).toHaveTextContent(/30s/);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog(vi.fn(() => Promise.resolve()));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the close button is clicked", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog(vi.fn(() => Promise.resolve()));
    await user.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
