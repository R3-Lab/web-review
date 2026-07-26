"use client";

/**
 * Mounts the review overlay. Split out from `layout.tsx` because it needs
 * `"use client"`.
 *
 * `@r3lab/web-review/next/client`'s `ReviewOverlay` wires the same default
 * `Composer`/`Panel`/`UnlockDialog` surfaces as the framework-agnostic
 * `ReviewOverlay` from the package's main entry — `config` is the only prop
 * this demo needs to supply. (Earlier revisions of this demo wired those
 * three render props by hand; that workaround is no longer necessary.)
 */

import { useMemo } from "react";
import { createHttpAdapter } from "@r3lab/web-review";
import type { ReviewConfig } from "@r3lab/web-review";
import { ReviewOverlay } from "@r3lab/web-review/next/client";

export function ReviewMount() {
  const config = useMemo<ReviewConfig>(() => ({ adapter: createHttpAdapter() }), []);

  return <ReviewOverlay config={config} />;
}
