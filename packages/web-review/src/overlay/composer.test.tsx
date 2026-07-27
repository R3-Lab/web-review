/**
 * `Composer` interaction tests (vitest + jsdom + React Testing Library).
 *
 * Renders `Composer` directly against a minimal `ComposerRenderProps` fixture
 * — no `OverlayRoot` involved — so these tests exercise exactly the seam
 * `Composer` implements against (`./overlay-root`'s `ComposerRenderProps`) in
 * isolation. The full pin → composer → panel round trip through the real
 * seam lives in `./panels-integration.test.tsx`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { ReviewApiError } from "../core/adapter";
import { resolveConfig } from "../core/config";
import type { ReviewConfig } from "../core/config";
import type { Anchor, ReviewerIdentity } from "../core/types";
import { Composer } from "./composer";
import type { ComposerRenderProps } from "./overlay-root";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeAnchor(overrides: Partial<Anchor> = {}): Anchor {
  return {
    selector: "#target",
    textHint: "Target",
    tagName: "div",
    classes: [],
    ancestorPath: [],
    rect: { x: 10, y: 10, w: 100, h: 40 },
    offsetPct: { x: 0.5, y: 0.5 },
    viewport: { w: 1024, h: 768, dpr: 1, scrollW: 1024, scrollH: 2000 },
    urlKey: "/",
    href: "https://example.test/",
    kind: "element",
    ...overrides,
  };
}

// Deliberately NOT typed against the `ReviewAdapter` interface (its methods
// are declared method-shorthand, which gives them an implicit `this` and
// trips `@typescript-eslint/unbound-method` the moment a test references
// `adapter.unlock` as a bare value in `expect(...)`). Structural inference
// from these `vi.fn()` properties satisfies `ReviewAdapter` at every call
// site that needs it (`resolveConfig({ adapter, ... })` below) without ever
// naming the interface.
function makeAdapter() {
  return {
    listThreads: vi.fn(),
    getThread: vi.fn(),
    createThread: vi.fn(),
    addComment: vi.fn(),
    setStatus: vi.fn(),
    unlock: vi.fn(() => Promise.resolve()),
  };
}

function renderComposer(
  propsOverride: Partial<ComposerRenderProps> = {},
  configOverride: Omit<Partial<ReviewConfig>, "adapter"> = {},
) {
  const adapter = makeAdapter();
  const config = resolveConfig({ adapter, ...configOverride });
  const onCancel = vi.fn();
  const onSubmit = vi.fn(() => Promise.resolve());
  const onUnlocked = vi.fn();
  const props: ComposerRenderProps = {
    anchor: makeAnchor(),
    config,
    identity: null,
    shotState: "idle",
    onCancel,
    onSubmit,
    onUnlocked,
    ...propsOverride,
  };
  const utils = render(<Composer {...props} />);
  return { ...utils, adapter, config, onCancel, onSubmit, onUnlocked, props };
}

describe("Composer", () => {
  it("renders categories from config.categories, including a fully custom set", () => {
    renderComposer(
      {},
      { categories: [{ id: "ux", label: "UX Issue" }, { id: "perf", label: "Performance" }] },
    );
    expect(screen.getByRole("radio", { name: /ux issue/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /performance/i })).toBeInTheDocument();
    // The built-in categories are gone entirely when the consumer overrides them.
    expect(screen.queryByRole("radio", { name: /^design$/i })).not.toBeInTheDocument();
  });

  it("submits the typed category/title/body/name via onSubmit", async () => {
    const user = userEvent.setup();
    const identity: ReviewerIdentity = { id: "u1", name: "Ada" };
    const { onSubmit } = renderComposer({ identity });

    await user.click(screen.getByRole("radio", { name: /bug/i }));
    await user.type(screen.getByLabelText(/title/i), "Broken button");
    await user.type(screen.getByLabelText(/comment/i), "It does nothing");
    await user.click(screen.getByRole("button", { name: /add feedback/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        category: "bug",
        title: "Broken button",
        body: "It does nothing",
        // No identity name field is shown once `identity` is set, so the
        // submitted name is the identity's own — not blank, not re-typed.
        name: "Ada",
      }),
    );
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderComposer();
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel on Escape", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderComposer();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the name field only when identity is null", () => {
    renderComposer({ identity: null });
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    cleanup();

    renderComposer({ identity: { id: "u1", name: "Ada" } });
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument();
  });

  it("reflects each shotState", () => {
    renderComposer({ shotState: "pending" });
    expect(screen.getByText(/capturing a screenshot/i)).toBeInTheDocument();
    cleanup();

    renderComposer({ shotState: "done" });
    expect(screen.getByText(/screenshot attached/i)).toBeInTheDocument();
    cleanup();

    renderComposer({ shotState: "idle" });
    expect(screen.getByText(/submitting without one/i)).toBeInTheDocument();
    cleanup();

    renderComposer({ shotState: "error" });
    expect(screen.getByText(/submitting without one/i)).toBeInTheDocument();
  });

  it("on a 401 from onSubmit, shows the password field, then retries submit after unlock without losing the draft", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn<ComposerRenderProps["onSubmit"]>()
      .mockRejectedValueOnce(new ReviewApiError(401, "locked"))
      .mockResolvedValueOnce(undefined);
    const { adapter, onUnlocked } = renderComposer({
      identity: { id: "u1", name: "Ada" },
      onSubmit,
    });

    await user.type(screen.getByLabelText(/comment/i), "It broke");
    await user.click(screen.getByRole("button", { name: /add feedback/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    const passwordField = await screen.findByPlaceholderText(/review password/i);
    // The draft is still on screen — nothing typed was lost by the failed submit.
    expect(screen.getByLabelText(/comment/i)).toHaveValue("It broke");

    await user.type(passwordField, "secret");
    await user.click(screen.getByRole("button", { name: /unlock & save/i }));

    await waitFor(() => expect(adapter.unlock).toHaveBeenCalledWith("secret"));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    // Retried automatically — the reviewer never had to click "Add feedback" again.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });
});
