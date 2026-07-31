# How anchoring works

**Part of [`@r3lab/web-review`](https://github.com/R3-Lab/web-review/blob/main/README.md)** — an
in-page review overlay for React and Next.js apps that ships no server and no
database. This page explains the part that makes a pin stick: what gets
recorded when a reviewer drops one, how it's found again on the next render,
and what the **drifted** badge means when it can't be. You don't have to
configure any of this to use the package — the
[README](https://github.com/R3-Lab/web-review/blob/main/README.md) has the
wiring — but it's worth reading before deciding how much to trust a pin on a
page that has since changed.

---

<img src="https://raw.githubusercontent.com/R3-Lab/web-review/main/docs/images/text-anchor.png" width="892" alt="The word 'unlimited' highlighted with its pin — the anchor follows an exact text selection, not just an element.">

*Text-selection anchoring: the pin follows the exact words, not just the
element that contains them.*

Capture, at pin-drop, records a **layered** anchor, not just a selector: a
CSS selector (id or `data-testid` preferred, else a `:nth-of-type` path from
the nearest stable ancestor), a text hint (first 120 characters of
`innerText`), a stable subset of class names (hashed/utility/Tailwind-ish
classes filtered out), an 8-hop ancestor tag path, a document-coordinate
rect, and a viewport snapshot.

Resolve, on every render, tries the exact selector first — a unique match is
confidence `1`. Otherwise a weighted fuzzy scorer runs over same-tag
candidates (text-hint similarity 0.4, class overlap 0.2, ancestor-path
overlap 0.25, scaled rect proximity 0.15) and picks the best score. At or
above a confidence threshold of `0.5` it's a confident bind; below that, the
pin still renders — at its last known rect, badged **drifted** — rather than
being dropped or silently misplaced.

Drift happens: a copy edit, a markup refactor, a class-name change can all
push a pin below the threshold. The badge is the signal, not a bug — there's
no anchoring strategy that survives an arbitrary rewrite of the page.

`normalizeUrl` (the default `urlKeyFromHref`) deliberately does **not** strip
a locale path prefix — `/about` and `/tr/hakkimizda` are different pages
with independently-written copy, and a pin on one locale's wording should
never surface on another's.

---

The captured anchor is stored as opaque, client-owned JSON: your database
persists and returns it verbatim and never introspects it, which is exactly
what lets the strategy above evolve — a new selector heuristic, a new
highlight kind — with no migration. See
[the `anchor`/`viewport` columns](https://github.com/R3-Lab/web-review/blob/main/docs/api.md#two-deliberate-design-decisions).
