# Conscious engineering decisions

Append-only log of design calls we've made, in the style of an ADR
(Architecture Decision Record) but terser. Every entry is a tradeoff we
chose, briefly justified, so we don't re-litigate it every six months.

Format:
- `## N. Decision title` (sequential number; never renumber past entries)
- **Date** (ISO)
- **Decision** in one sentence.
- **Alternatives** considered.
- **Why.**
- **Superseded by N** (only on entries that get overridden later).

Newer entries go at the bottom.

---

## 1. Keyboard-first window manager modeled on i3/Hyprland, not Enlightenment

**Date:** 2026-04-19

**Decision:** Foyer's window model is a tree of tiled panes with
first-class floating windows, Hyprland-style chord-driven keybinds, and
named workspaces tied to workflow verbs ("Tracking", "Mixing",
"Mastering"). Focus is click-to-focus — no focus-follows-mouse, no
auto-raise.

**Alternatives:** Enlightenment-style floating-only with per-window
chrome (what AVLinux ships); macOS Expose-style grid; single-window
tabbed model like Visual Studio Code; stacking WM with title-bar-driven
manipulation.

**Why:** Pro audio workflows spend hours in one layout; tiling makes
that reproducible, keybinds make it fast, and workspaces tied to
workflow let a tracking session snap back to its shape without clicking
through menus. Enlightenment in particular looked great in 2005 and has
not been "state of the art" since — AVLinux shipping it is a historical
accident we should not imitate. Click-to-focus is the modern default
because focus-follows-mouse on a touchscreen or tablet is nightmarish.

## 2. Leader-key chord system with live cheat-sheet

**Date:** 2026-04-19

**Decision:** Use leader-key chords (`Space` or `Ctrl+W` as leader) over
single-modifier-chord keybinds. On leader press, show a transient
cheat-sheet overlay of what keys are live. Modifier-chord keybinds are
supported for muscle-memory users but leader is canonical.

**Alternatives:** Pure modifier chords (Ctrl+Alt+letter) as in
Hyprland/i3/Blender; mode-based editing as in vim/Helix; menu bar as
primary surface.

**Why:** Modifier chords scale poorly past the first 20 bindings — past
that you run out of safe combos and start colliding with OS and browser
shortcuts. Leader keys sidestep both and get free discoverability via
the cheat sheet. Mode editing is powerful but hostile to occasional
users; leader + cheat sheet hits the sweet spot. Keep the existing
Ctrl+Alt+HJKL muscle-memory bindings too — cheap to support both.

## 3. Workspaces tied to workflow verbs, not sessions

**Date:** 2026-04-19

**Decision:** Workspaces are named configurations of
tiles+floats+dock+FAB-positions, keyed by workflow verb ("Tracking",
"Mixing", etc.), shared across all sessions. Loading a session doesn't
load a workspace; user picks workspace explicitly.

**Alternatives:** Workspace-per-session (each session file has its own
layout); workspace-per-project; layout-per-monitor.

**Why:** Most users have one mixing posture regardless of what song
they're on; tying layout to session forces re-setup per project. Keep
session data clean (what audio/regions/plugins exist) and workspace
data orthogonal (how to display it). If a user wants session-specific
layouts, they can already save a named layout and load it on session
open — this decision just picks the default.

## 4. Every new view defaults to tiled; floating is an explicit gesture

**Date:** 2026-04-19

**Decision:** When the user opens a view via menu, palette, or split
button, it lands as a tile. Floating requires an explicit gesture
(dock-target icon, tear-out drag, or `Float` hotkey). Exception: plugin
panels default to floating because their window-ness is the point.

**Alternatives:** Float-first (cleaner for beginners, messier at
scale); mode toggle in settings; per-view-type preference.

**Why:** Tiling is how pros work; messing with window positions burns
attention. Plugin panels are genuinely window-shaped — they're the one
case where "float by default, dock if you want" is the right call.

## 5. Context menu is hijacked globally; selection is opt-in

**Date:** 2026-04-19

**Decision:** A single document-level `contextmenu` listener
`preventDefault`s the native menu everywhere and routes to
[context-menu.js](/workspaces/foyer-studio/web/src/components/context-menu.js)'s
descriptor-driven menu. Items are registered per-region via a
`data-foyer-context` attribute or direct call. Text selection is
globally `user-select: none`; only elements explicitly tagged as text
surfaces (`input`, `textarea`, `[contenteditable]`, `.foyer-text`)
allow selection.

**Alternatives:** Leave native context menu on non-interactive surfaces
(mixes two menu styles, ugly); allow selection everywhere (drag-to-
select on a fader track ends the day with the whole mixer highlighted).

**Why:** Consistency. Users should never see the browser's right-click
menu in our app (no "Reload", "View page source" leaking through).
Selection anywhere-by-default is a misfeature on a DAW surface — it
makes drag gestures unreliable and produces visible highlighting on
panels that shouldn't be selectable at all.

## 6. Dock-target icon is a two-click operation

**Date:** 2026-04-19

**Decision:** Tile headers and floating-window headers carry a
dock-target icon (alongside close/float/split). Clicking it opens the
slot picker; the second click selects a slot. A hotkey shortcut
(`Space w d <slot-char>`) does the same in one stroke for keyboard
users.

**Alternatives:** Single-click-to-dock with long-press-for-picker (bad
for touch latency); dedicated modifier-drag (hidden); only-hotkey (bad
for mouse users).

**Why:** The slot system is already the canonical placement vocabulary
— the dock icon is just a mouse-affordance entry into it. Two clicks
is the right price for choosing a slot with a pointer; a hotkey keeps
keyboard users fast.

## 7. Automation language is AHK-flavored; embedded runtime in the browser

**Date:** 2026-04-19

**Decision:** Ship a small AHK-flavored scripting DSL and runtime
in-app, editable in a dedicated panel. Parser supports hotkey
definitions (`^!p::` etc), command verbs (`Action`, `ControlSet`,
`Layout`, `Float`, `Sleep`, `Msg`), and both single-line and
`Return`-terminated blocks. Scripts persist in localStorage and
activate on app load.

**Alternatives:** Lua (bigger, VM-heavy, but a lot of music-tech
precedent — Reaper, Ardour); a JSON rules engine (smaller, uglier,
doesn't scratch the "nerds will own this planet" itch); nothing
(force users to reach for external tools like BetterTouchTool or
keyboard mappers).

**Why:** AHK's hotkey-as-syntax is uniquely clear for this use case —
a hotkey + a command sequence is exactly what a DAW power user wants
to bind. The language is small enough to parse by hand without
dependencies (no-Node, no-vendored-libs rule). And Rich has a direct
stake: "Liam will be disappointed if I didn't add a little AHK into
this project." Ship a subset; grow it based on what people actually
write.

## 8. Foyer is a desktop environment, not "a web app"

**Date:** 2026-04-19

**Decision:** Foyer is designed first as a **full-screen desktop
environment for audio engineering** — the browser is the runtime, not
the frame. We don't respect browser chrome (we hide it via F11),
browser conventions (we hijack the context menu and right-click),
browser text-selection defaults (selection is opt-in per surface), or
browser window model (we run our own tiling + floating WM with
cross-monitor awareness). Running it as a webpage inside other browser
tabs is an accepted fallback, not a target.

**Alternatives:** "Respectful web app" mode where native behaviors pass
through (keeps it feeling web-native but blocks deep pro-audio UX);
hard-requiring a desktop shell (Tauri/wry) from day one (loses the
demo-in-a-browser superpower).

**Why:** Pro audio is one of the domains where "feels like a real
app" trumps "respects browser conventions." Nobody runs Pro Tools and
says "I wish it behaved more like Chrome." The browser is a delivery
channel; the experience is a DE. We keep the Tauri/wry wrapper on the
shelf for native packaging but we don't depend on it to ship good UX.

## 9. Menu items are tearable into the workspace

**Date:** 2026-04-19

**Decision:** Any menu that selects a view (the tile header's view
picker is the first instance) supports tear-out: pointer-down on an
item + drag past a threshold detaches it into a floating window and
hands the drag off to the drop-zone overlay. Below the threshold, a
release still triggers the item's click action. Same pattern will
apply to other view-picker surfaces (command palette, future plugin
browser, future preset library).

**Alternatives:** Separate "float" affordance per item (clutters
menus); modifier-click (undiscoverable); no tear-out (menus remain a
one-way click-and-dismiss surface).

**Why:** Matches the desktop-environment framing of #8 — menus
shouldn't be modal dead-ends when every surface can live in a window.
Below-threshold clicks still work, so nobody pays a cost for the
feature they don't use. The same tear-out mechanics power the tile
header drag and the plugin-strip row drag, keeping the gesture
vocabulary consistent.

## 10. FAB docking uses a shared registry on the layout store

**Date:** 2026-04-19

**Decision:** Any FAB (layout, agent, future ones) that wants to be
dockable registers itself with `LayoutStore.registerFab(id, meta)` at
connect time and exposes `openFromDock / closeFromDock / toggleFromDock`
methods. The right-dock renders a rail icon per docked FAB by querying
`layout.dockedFabs()` and dispatches clicks back through the registry.
The FAB's own `render()` hides the floating button when `isFabDocked()`
and re-anchors its panel next to the rail instead.

**Alternatives:** Each FAB component independently listens for
drop-on-rail events; a portal-based system that relocates the FAB DOM
into the rail's shadow tree; requiring every FAB to extend
`QuadrantFab` (blocks the agent which predates that base class).

**Why:** Decouples the right-dock from every FAB's internal renderer
— the rail just sees `{ id, meta: { label, icon, accent } }`.
Non-`QuadrantFab` components (the agent) can opt in with a handful of
methods without a full port. Matches the pattern we'd want for plugin
authors adding their own FABs later.

## 11. Drop-zone hit-testing is band-priority, not smallest-area

**Date:** 2026-04-19

**Decision:** The floating-tile drop overlay divides the viewport
vertically into three bands: top 25%, middle 50%, bottom 25%. Each
band surfaces a different set of drop targets: top/bottom bands
prefer quadrants + half rows; the middle band surfaces only
full-height thirds and halves. Hit-test within each band walks the
target list in priority order and takes the first containing target.

**Alternatives:** Smallest-area wins (original; meant quadrants
always beat thirds/halves even when dragging in the middle);
require modifier keys to select one tier vs. another (undiscoverable).

**Why:** Rich's exact report — dragging in the middle should show
full-height thirds/halves, not top-left or bottom-right quadrants.
Band-priority matches the mental model: "I'm near the top, so I
probably want a top-rooted placement." Also unlocks 1/3 layouts that
were technically present but practically unreachable under the
smallest-area rule.

## 12. Plugin windows live on their own layer, not in floating-tiles

**Date:** 2026-04-19

**Decision:** Plugin parameter panels do **not** share the tile grid
or the generic floating-window surface. They render on a dedicated
[`<foyer-plugin-layer>`](/workspaces/foyer-studio/web/src/layout/plugin-layer.js)
below the generic floating-tiles layer, with their own store state
(`layout.pluginFloats()`, `layout.openPluginFloat()` etc.), their own
auto-layout algorithm (shelf packing, see
[`plugin-packer.js`](/workspaces/foyer-studio/web/src/layout/plugin-packer.js)),
and a single global visibility toggle (Ctrl+Shift+P). Plugin floats
never snap to slot presets — position is owned by the packer and
computed fresh on every render. Users resize a plugin window's
dimensions; (x,y) comes from the packer.

**Alternatives considered:**
- Plugin panels as another view type inside `floating-tiles`
  (previous state — windows fought for space with mixer/timeline,
  had to be slotted manually, and there was no single "hide all
  plugins" gesture).
- Plugin panels as docked-into-tiles content (too invasive to the
  main workflow; mix view gets cluttered).
- Plugin panels in the right-dock (one at a time, too cramped for
  many-band EQs).

**Why:** Every major DAW distinguishes plugin GUIs from core UI —
Pro Tools' Plug-In Window Menu, Reaper's FX windows, Ableton's
device view. The set of open plugin windows is part of the
"working setup" separate from the workspace. Hiding all plugins to
A/B a mix is a common gesture that needed a dedicated toggle, not
N clicks. And auto-placement beats manual slotting for something
the user opens dozens of times a session — Rich's framing: "like a
3D slicer's auto-fill."

**Implications:**
- Saved layouts should record the set of open plugin IDs (not
  positions) so layout-load restores the same working set. (TODO
  — tracked in TODO.md.)
- `floating-tiles` retains the old `plugin_panel` view type as a
  dormant branch so users with legacy `floating[]` entries in
  localStorage still render until they close and reopen.
- Plugin windows have compact default sizes (320×360, tuned larger
  for dense plugins) because "fit to content" is the expected UX —
  they should never open at half the screen.

## 13. Floating windows carry first-class relative/absolute semantics

**Date:** 2026-04-19

**Decision:** Every floating window has a `slot` field that is either
a named slot id ("left-half", "tl", "center-third", …) or `null`. A
non-null `slot` means the window's position and size are **relative**
to the current workspace rect — whenever the workspace changes
(dock opens, window resizes, screen rotates), `_reflowSlots()` recomputes
the window's bounds from the slot's canonical function. A `null` slot
means **absolute** — the window carries a fixed `(x, y, w, h)` that
ignores workspace changes.

Transitions between the two modes:

- **Open from slot-picker / drop-zone / tear-out snap** → `slot = <id>`
  (relative).
- **Drag / resize within tolerance of a slot's canonical bounds** →
  snap to that slot's bounds and keep `slot = <id>` (relative). The
  tolerance is ~4% of workspace's shorter dimension, clamped 16–64 px.
- **Drag / resize past every slot's tolerance** → `slot = null`
  (absolute); the window now carries a literal rect.
- **Explicit slot change via slot-picker / re-slot menu** → overrides
  to the picked slot (relative).

**Alternatives:** always absolute (every drag commits a literal rect —
what we started with); always relative (user can never free-place a
window); a mode toggle per window (hidden, high cognitive cost).

**Why:** The user's mental model is binary — "this window is left-half
(follows me around)" vs "this window is at (x,y) with (w,h)". Making
the binary first-class means a dock-panel-open → right-half shrinks,
a workspace resize → everything reflows, and dragging a window to
left-two-thirds → it stays two-thirds. The tolerance-based transition
means users don't need to understand a "mode toggle" — small drags
keep the pin, big drags commit to absolute. This lines up with how
Rectangle / Magnet / fancyWM work but applies to in-app windows, not
OS windows.

**Implementation notes:**
- [`slotForRect(rect)`](/workspaces/foyer-studio/web/src/layout/slots.js)
  resolves a rect back to the best matching slot id (or null).
- [`floating-tiles.js`](/workspaces/foyer-studio/web/src/layout/floating-tiles.js)
  calls it in the resize-move handler (per-frame, so you see live snap
  to slot bounds during a compatible drag) and in the move-release
  handler (one-shot, after the drop-zone check).
- [`foyer:dock-resized`](/workspaces/foyer-studio/web/src/components/right-dock.js)
  event fires on any right-dock width change; `_reflowSlots()` listens
  and re-applies every slot-pinned window's bounds.

## 14. Decisions live in this file, not in the conversation

**Date:** 2026-04-19

**Decision:** Any tradeoff we consciously pick — especially ones where
there are plausible alternatives — gets an entry here rather than a
comment in code or a line in chat history. New Claudes and new
contributors read this file to understand "why is it this way" without
having to excavate git log.

**Alternatives:** Comments in the affected files (invisible across
files); commit messages (noisy, not surface-able); nothing (lose the
reasoning the next time someone revisits).

**Why:** ADR-style decision logs are a well-proven pattern. The
marginal cost per entry is five minutes; the compound benefit over a
year is enormous.

## 15. Layer-scoped licensing with the shim as the GPL boundary

**Date:** 2026-04-20

**Decision:** Each layer of Foyer is licensed according to what it
actually links against:

- **`shims/ardour/`** is GPLv2+. It statically links `libardour`;
  Ardour is GPLv2; standard practice for anything inside the Ardour
  ecosystem is to match the host's license. Patches we upstream to
  Ardour itself are likewise GPLv2.
- **Rust sidecar + web UI** sit above a documented Unix-socket IPC
  protocol. They talk `foyer-schema` types, not `libardour` types,
  and don't share address space with any specific engine. They're
  licensed separately (exact terms TBD; permissive).
- **Future shims** (Reaper SDK, JUCE-based engines, commercial DAW
  bindings) each carry whatever license terms their SDK requires
  for static linking.

**Alternatives considered:**

1. *Everything GPL* — would match the Ardour project's own preference
   and remove the "is the sidecar a derivative work?" debate. Cost:
   users and contributors (and future commercial-engine shims) can't
   reuse Foyer's sidecar / web UI in permissively licensed projects,
   which foreclosed partnerships we want to keep open.
2. *Shim-is-permissive via LGPL-style shim* — requires dynamically
   loading `libardour` and hoping no GPL'd types cross the boundary.
   Practically impossible with how Ardour exposes its public API
   (templates, shared_ptr of GPL'd classes everywhere). Rejected.
3. *Hosted-only, never ship the shim binary* — avoids the question.
   Rejected: we want Foyer to be installable locally.

**Why:** The shim-as-boundary pattern is how every other
audio-controller ecosystem (MCP control surfaces, OSC bridges,
plugin wrappers) handles the same tradeoff. It keeps the per-engine
translation code under its host's license while letting the editing
surface above be reusable across engines. This is an engineering
accommodation, not a political stance — without Ardour's decades of
audio-engine work, nothing above the shim would exist or be worth
building.

**Implementation notes:**
- `shims/ardour/**/*.cc` and `*.h` carry a GPLv2+ header, matching
  Ardour's own files.
- `crates/**/*` and `web/src/**/*` carry the Foyer project header
  (once decided); no file outside `shims/` should include a GPL
  header.
- If we add a second shim (e.g. `shims/reaper/`), give it its own
  directory, its own license header, and its own build/recipe. Keep
  the wire format on the other side identical — that's the whole
  point.
