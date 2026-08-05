# Customizing a surface

**Part of [`@r3lab/web-review`](https://github.com/R3-Lab/web-review/blob/main/README.md)** — an
in-page review overlay for React and Next.js apps that ships no server and no
database. This page is about the overlay's *look*: which components you can
replace, where to import them from, and the exact render-prop contracts a
replacement has to satisfy to actually drive the overlay rather than merely
look like it does. If you landed here from a search engine, the
[README](https://github.com/R3-Lab/web-review/blob/main/README.md) is where the
package is introduced and mounted.

**On this page:** [What's exported, and from where](#whats-exported-and-from-where) ·
[Replacing a surface](#replacing-a-surface) ·
[Upgrading a custom surface](#upgrading-a-custom-surface) ·
[Wrapping a stock surface](#wrapping-a-stock-surface)

---

## What's exported, and from where

`ReviewOverlay` is the only mount point the main `.` entry exports as a
value. `OverlayRoot` (its internal shell) is exported as **types only**
(`OverlayRootProps`, `ComposerRenderProps`, `PanelRenderProps`,
`UnlockRenderProps`, `ShotState`) — `import { OverlayRoot }` will not
compile, deliberately: `ReviewOverlay` owns the mount gate and the lazy-load
boundary (see [Bundle cost](https://github.com/R3-Lab/web-review/blob/main/README.md#bundle-cost)), and there's no supported way to
render the shell outside of it.

The four default UI surfaces — `Composer`, `Panel`, `ThreadDetail`,
`UnlockDialog` — **are** exported as values, from **`@r3lab/web-review/surfaces`**
— a separate subpath from `.`, not the main entry — so you can replace just
one and keep the rest stock via `renderComposer`/`renderPanel`/`renderUnlockDialog`.
Replacing one doesn't require importing the others at all: leave a `render*`
prop unset and `ReviewOverlay` wires in its own stock default for it, same as
always. The subpath split exists purely for bundle size — see
[Bundle cost](https://github.com/R3-Lab/web-review/blob/main/README.md#bundle-cost) — not because the customization story changed.

## Replacing a surface

<img src="https://raw.githubusercontent.com/R3-Lab/web-review/main/docs/images/composer.png" width="493" alt="The default Composer surface: a category picker for Design, Copy, Bug, and Other, plus title, comment, and name fields.">

*The stock `Composer` — one of the four default surfaces you can replace
individually via a `render*` prop.*

```tsx
import { createHttpAdapter, ReviewOverlay } from "@r3lab/web-review";
import { MyBrandedComposer } from "./my-branded-composer";

<ReviewOverlay
  config={{ adapter: createHttpAdapter() }}
  renderComposer={(props) => <MyBrandedComposer {...props} />}
/>;
```

`props` is typed `ComposerRenderProps` (or `PanelRenderProps` /
`UnlockRenderProps` for the other two) — imported from the main `.` entry
like any other type (types are erased at compile time, so they carry none of
the bundle-size cost that moved the surfaces themselves off `.`) — to build a
component against the exact contract `OverlayRoot` calls it with. A
replaced surface receives the **same** props `OverlayRoot` passes the stock
one — the same `onSubmit`/`onCancel` for the composer, `onReply`/
`onToggleStatus`/`onSelect`/`onClose` for the panel, `onUnlocked`/`onClose`
for the unlock dialog. A custom surface has to call those to actually drive
the overlay's state machine; skip them and you get a form that looks right
and does nothing — creating a thread, replying, or resolving only happens
because the render prop was invoked, not because the surface merely rendered.

## Upgrading a custom surface

These contracts have gained required members twice.

**In 0.4.0**, `PanelRenderProps` gained `showPins`, `onToggleShowPins`, and
`unplaceableCount` — the panel's Pins checkbox and its summary of pins that
couldn't be placed (see [How anchoring
works](https://github.com/R3-Lab/web-review/blob/main/docs/anchoring.md)).
`onToggleShowPins` is deliberately not named `onTogglePins`, which would have
matched `onToggleHighlights`: this surface already has an `onTogglePinDrop`,
and two callbacks a character apart meaning "hide the markers" and "arm
picking" is a mistake waiting to be made.

**In 0.2.0**, when the launcher stopped arming pin-drop mode (see [Keyboard
and accessibility](https://github.com/R3-Lab/web-review/blob/main/docs/keyboard.md)),
`PanelRenderProps` gained `pinDropMode`, `onTogglePinDrop`, and `panelSide`;
`ComposerRenderProps` gained `panelSide`.

What either break costs at compile time is narrower than it sounds, and the
half it *doesn't* break is the dangerous one:

- Code that **constructs** one of these objects — a test harness, a story, a
  wrapper handing a stock surface hand-built props — stops compiling:
  `TS2739: … is missing the following properties from type 'PanelRenderProps':
  showPins, onToggleShowPins, unplaceableCount`. Add them and it builds again.
- A `renderPanel`/`renderComposer` **callback** that only destructures the
  members it uses keeps compiling untouched, because a function taking fewer
  properties is still assignable where one taking more is expected. So a
  custom panel written against the old contract type-checks — and then leaves
  a reviewer with no way to start a comment at all, since the launcher no
  longer arms pin-drop mode either.

A custom panel therefore needs its own arm/disarm control calling
`onTogglePinDrop` and reflecting `pinDropMode` (the stock `Panel` renders it
as one button whose `aria-pressed` carries the state and whose label changes
word).

The 0.4.0 additions have a milder version of the same silent half. A custom
panel that ignores `showPins`/`onToggleShowPins` still works — holding `h`
gives a reviewer a way past a pin regardless, since that lives in
`OverlayRoot` rather than in the panel — but it offers no way to hide the
pins for good, and nothing surfaces `unplaceableCount`, so a reviewer gets no
page-level account of pins that couldn't be placed. Both are worth
reimplementing; neither is load-bearing the way `onTogglePinDrop` is.

`panelSide` is `"left"` or `"right"` — which viewport edge the panel is
docked against right now, following the launcher — so a custom composer can
keep itself, and its submit button in particular, out from under it. Below
560px there is no side to avoid: the stock stylesheet turns the panel into a
full-width bottom sheet, and the stock composer reserves no horizontal space
for it at all. The prop still carries a value there; it just stops describing
a layout.

## Wrapping a stock surface

Wrapping a stock surface (rather than replacing it outright) is just as
supported — import the value from `./surfaces` alongside the type from `.`:

```tsx
import { createHttpAdapter, ReviewOverlay } from "@r3lab/web-review";
import type { ComposerRenderProps } from "@r3lab/web-review";
import { Composer } from "@r3lab/web-review/surfaces";

function MyBrandedComposer(props: ComposerRenderProps) {
  return (
    <div className="my-brand">
      <Composer {...props} />
    </div>
  );
}

<ReviewOverlay
  config={{ adapter: createHttpAdapter() }}
  renderComposer={(props) => <MyBrandedComposer {...props} />}
/>;
```

(Both samples above are checked against this package's own build output —
`Composer`'s destructured parameter type in `dist/surfaces.d.ts` is
`ComposerRenderProps`, so passing it straight through via `{...props}` and
via `ComposerRenderProps` imported from `.` type-checks exactly as shown.)
