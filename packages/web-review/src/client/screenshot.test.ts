/**
 * `captureScreenshot` unit tests (vitest + jsdom). `@zumer/snapdom` is
 * mocked via `vi.doMock` + a fresh dynamic `import("./screenshot")` per
 * test (not a top-level `vi.mock`), so each test controls independently
 * whether the module resolves, rejects, or throws — proving the "loaded
 * only via dynamic import, never a static top-level import" contract from
 * the file header along the way: nothing here would work if snapdom were
 * imported eagerly at module load.
 *
 * jsdom has no layout engine, so `getBoundingClientRect` defaults to an
 * all-zero rect (see `anchor.test.ts` for the same note) — that default is
 * exactly what the "too small" test relies on, and every other test
 * overrides it on the target element to clear the capture floor.
 *
 * jsdom also has no `<canvas>` 2D backend, so `HTMLCanvasElement`'s
 * `getContext`/`toBlob` are stubbed per test — this file tests
 * `captureScreenshot`'s control flow (which failure degrades to `null`,
 * which succeeds), not real pixel rasterization.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function bigRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 300,
    bottom: 300,
    width: 300,
    height: 300,
    toJSON() {
      return {};
    },
  };
}

describe("captureScreenshot", () => {
  let target: HTMLDivElement;

  beforeEach(() => {
    target = document.createElement("div");
    document.body.appendChild(target);

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      function (this: HTMLCanvasElement, callback: BlobCallback) {
        callback(new Blob(["fake-png-bytes"], { type: "image/png" }));
      },
    );
  });

  afterEach(() => {
    target.remove();
    vi.restoreAllMocks();
    vi.doUnmock("@zumer/snapdom");
    vi.resetModules();
  });

  it("returns null, never throws, when the target is below the capture floor", async () => {
    const { captureScreenshot } = await import("./screenshot");

    await expect(captureScreenshot(target)).resolves.toBeNull();
  });

  it("returns null, never throws, when @zumer/snapdom is not installed", async () => {
    vi.doMock("@zumer/snapdom", () => {
      throw new Error("Cannot find module '@zumer/snapdom'");
    });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(bigRect());

    const { captureScreenshot } = await import("./screenshot");

    await expect(captureScreenshot(target)).resolves.toBeNull();
  });

  it("returns null, never throws, when snapdom rejects at every scale", async () => {
    const toPng = vi.fn(() => Promise.reject(new Error("capture failed")));
    vi.doMock("@zumer/snapdom", () => ({ snapdom: { toPng } }));
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(bigRect());

    const { captureScreenshot } = await import("./screenshot");

    await expect(captureScreenshot(target)).resolves.toBeNull();
    expect(toPng).toHaveBeenCalled();
  });

  it("returns a PNG Blob on the success path, excluding the overlay's own DOM", async () => {
    const fakeImg = {
      decode: vi.fn(() => Promise.resolve(undefined)),
      naturalWidth: 300,
      naturalHeight: 300,
      width: 300,
      height: 300,
    };
    const toPng = vi.fn(() => Promise.resolve(fakeImg));
    vi.doMock("@zumer/snapdom", () => ({ snapdom: { toPng } }));
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(bigRect());

    const { captureScreenshot } = await import("./screenshot");
    const blob = await captureScreenshot(target);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe("image/png");
    expect(toPng).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ exclude: ["[data-r3-review]"] }),
    );
  });

  it("returns null without calling snapdom when passed no target and <html> is too small", async () => {
    const toPng = vi.fn(() => Promise.resolve({}));
    vi.doMock("@zumer/snapdom", () => ({ snapdom: { toPng } }));

    const { captureScreenshot } = await import("./screenshot");

    await expect(captureScreenshot(null)).resolves.toBeNull();
    expect(toPng).not.toHaveBeenCalled();
  });
});
