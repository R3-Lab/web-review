# How anchoring works

**Part of [`@r3lab/web-review`](https://github.com/R3-Lab/web-review/blob/main/README.md)** — an
in-page review overlay for React and Next.js apps that ships no server and no
database. This page explains the part that makes a pin stick: what gets
recorded when a reviewer drops one, how it's found again on the next render,
and what the **Drifted** and **Not found** badges mean when it can't be. You don't have to
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
pin still renders — at the position it was dropped — rather than vanishing or
being silently misplaced.

### Three outcomes, not two

A resolve that fails can fail in two different ways, and the overlay says
something different about each. Until 0.4.0 both were badged **drifted**,
which told a reviewer their page had changed in cases where nothing of the
sort had been established:

| Outcome | Badge | What it means | What the overlay is entitled to say |
|---|---|---|---|
| Matched at or above `0.5` | none | Confident bind; the pin rides the live rect | — |
| Best candidate scored **below** `0.5` | **Drifted** | Something on this page still resembles what was pinned, but not enough to trust | That the page changed. The resolver found a weaker version of the thing, which is evidence the content moved or was edited |
| Nothing to score at all | **Not found** | The resolver searched and matched nothing | Only that it looked and didn't find it. **Not** that the page changed — the element may never have been on this page at all |

The distinction matters because the second failure has innocent causes the
first doesn't. An anchor that resolves to nothing can mean a copy edit — or
it can mean the thread belongs to a different route, or arrived from a page
scoped differently than you expected. Blaming content for what may be a
navigation or data-scoping mismatch sends a reviewer looking for a change
nobody made. So the **Not found** copy asserts nothing beyond *"the element
this was pinned to could not be found on this page, so the marker is shown
where the pin was dropped"*, while **Drifted** is allowed to say *"the page
changed since this was pinned"*.

Drift itself is not a bug: a copy edit, a markup refactor, a class-name
change can all push a pin below the threshold, and there's no anchoring
strategy that survives an arbitrary rewrite of the page. The badge is the
signal.

In the DOM, a pin carries `data-drifted` and `data-unplaceable` as two
independent booleans rather than one tri-valued attribute, so
`data-drifted="true"` keeps meaning drift and only drift. The thread panel
also summarises the second state across the page — *"3 pins couldn't be
placed on this page. They are shown where they were dropped."* — counting
**Not found** only, never **Drifted**, since one number covering both would
rebuild the conflation this split exists to end.

`normalizeUrl` (the default `urlKeyFromHref`) deliberately does **not** strip
a locale path prefix — `/about` and `/tr/hakkimizda` are different pages
with independently-written copy, and a pin on one locale's wording should
never surface on another's.

### Pins are scoped to the page they were dropped on

That `urlKey` is enforced on the way out as well as the way in. A fetched
thread list is stamped with the key it was fetched for, and the overlay draws
a pin only when both the list's stamp and the thread's own `urlKey` match the
page being rendered. Two consequences worth knowing about in a single-page
app, where the URL changes without the overlay ever unmounting:

- Navigating clears the previous page's pins in the same commit as the
  navigation, rather than leaving them painted over the new page until a
  fetch comes back.
- A request for a page the reviewer has already left is discarded when it
  lands, so a slow response can't replace the list for the page they're
  actually on. Requests don't resolve in the order they were sent, and on a
  slow connection that reordering is ordinary rather than rare.

Before 0.4.0 neither held, and pins from one page could paint on another.
If you see a **Not found** badge on a thread you're sure belongs elsewhere,
a custom `urlKeyFromHref` collapsing two pages onto one key is the first
thing to check.

---

The captured anchor is stored as opaque, client-owned JSON: your database
persists and returns it verbatim and never introspects it, which is exactly
what lets the strategy above evolve — a new selector heuristic, a new
highlight kind — with no migration. See
[the `anchor`/`viewport` columns](https://github.com/R3-Lab/web-review/blob/main/docs/api.md#two-deliberate-design-decisions).
