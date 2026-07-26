"use client";

/**
 * Mounts the review overlay. Split out from `layout.tsx` because it needs
 * `"use client"`.
 *
 * `@r3lab/web-review/next/client`'s `ReviewOverlay` (the Next-specific
 * mount) does NOT wire up default `renderComposer` / `renderPanel` /
 * `renderUnlockDialog` implementations the way the framework-agnostic
 * `ReviewOverlay` from the package's main entry does (see that file's own
 * doc comment: "wires WP4b's four surfaces in as OverlayRoot's default...
 * so the overlay is complete out of the box"). The Next entry has no
 * equivalent default wiring, so this demo supplies WP4b's own
 * `Composer`/`Panel`/`UnlockDialog` explicitly — see the WP9 report for
 * this as a package friction point.
 */

import { useMemo } from "react";
import { Composer, Panel, UnlockDialog, createHttpAdapter } from "@r3lab/web-review";
import type { ReviewConfig } from "@r3lab/web-review";
import { ReviewOverlay } from "@r3lab/web-review/next/client";

export function ReviewMount() {
  const config = useMemo<ReviewConfig>(() => ({ adapter: createHttpAdapter() }), []);

  return (
    <ReviewOverlay
      config={config}
      renderComposer={(props) => <Composer {...props} />}
      renderPanel={(props) => <Panel {...props} />}
      renderUnlockDialog={(props) => <UnlockDialog {...props} />}
    />
  );
}
