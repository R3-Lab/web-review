# Keyboard and accessibility

**Part of [`@r3lab/web-review`](https://github.com/R3-Lab/web-review/blob/main/README.md)** — an
in-page review overlay for React and Next.js apps that ships no server and no
database. This page is the overlay's keyboard contract and its accessibility
behaviour: every shortcut, where each one is advertised, and how focus is
handled. It's also the reference to read before writing a custom `Panel`,
since a replacement surface inherits none of this for free — see
[Customizing a surface](https://github.com/R3-Lab/web-review/blob/main/docs/customizing.md).
If you landed here from a search engine, the
[README](https://github.com/R3-Lab/web-review/blob/main/README.md) introduces
the package.

---

- **`c`** toggles pin-drop mode, and does nothing else — in particular it
  does not open the panel, the mirror image of the launcher opening the panel
  without arming pin-drop mode. Ignored while a form field or any
  `contenteditable` element has focus, while a draft composer is open, and
  while Ctrl/Cmd/Alt is held; Shift is *not* excluded, so `Shift+C` toggles
  too.
- **Arrow keys** dock the launcher against the left, right, top, or bottom
  edge — while the launcher itself has focus, not globally. This is not a
  convenience for keyboard users: WCAG 2.5.7 (Dragging Movements) requires a
  non-drag path to anything a drag can do, so it is part of the launcher's
  contract rather than a nicety layered on top of it.
- **Escape** unwinds one layer at a time, in this order: an open unlock
  dialog, then pin-drop mode, then an open draft composer, then the thread
  panel.
- All three are listed in a strip pinned to the bottom of the panel, present
  in both its list and detail views and outside the scrolling body, so a long
  thread list can't push them out of reach. They need that home now: the
  launcher's accessible name used to advertise `c` and no longer does — it
  says only what pressing it does (*Open the review panel*, plus the
  open-thread count when there is one) — and the arrow keys never had one.
- The composer, thread panel, and unlock dialog each run a **focus trap**
  (`useFocusTrap`) — Tab cycles within the open surface, and focus returns
  to whatever had it before on close (only if that element is still in the
  document). It's a *soft* trap: the keydown listener lives on the
  container, not `document`, so a mouse click elsewhere on the page still
  frees the reviewer — the right shape for a side panel read alongside the
  host page. The panel deliberately does not pull focus in when it opens,
  for the same reason: it's a surface a reviewer may only want to glance at,
  and grabbing focus would move their place on the page (and a screen
  reader's cursor) to do it.
- A polite ARIA live region (`role="status" aria-live="polite"`) announces
  pin-drop mode changes, pin drops, saved feedback, replies, and
  resolve/reopen actions.

---

The launcher's docked position (which edge, and how far along it) survives
reloads via one `localStorage` key — see the
[configuration reference](https://github.com/R3-Lab/web-review/blob/main/README.md#localstorage-keys).
