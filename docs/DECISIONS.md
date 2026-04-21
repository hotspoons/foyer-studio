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

## 16. Waveform renderer is a JS port of Ardour's WaveView algorithm, not a derivation of the code

**Context:** The first-pass waveform renderer was a GLSL fragment
shader that sampled an `RG32F` peaks texture per pixel. It looked
like a "stretched raster" at any real zoom — the bucket grid never
aligned with the pixel grid, so every column was a bilinear blend of
the two nearest min/max pairs, which read visually as blur. Users
expect pro-DAW waveform rendering: razor-sharp, continuous, per-pixel
accurate at any zoom including extreme.

**Decision:** Port Ardour's `WaveView::draw_image` algorithm
(libs/waveview/wave_view.cc, lines 684–702 as of Ardour 9.2) into
JavaScript, rendered via Canvas2D path strokes. Per pixel column we
decide between three draw cases:

1. Current bucket's top is below the next bucket's bottom in pixel
   Y → falling signal → draw a diagonal `bot → next.bot` connector.
2. Current bucket's bot is above next bucket's top → rising signal
   → draw a diagonal `top → next.top` connector.
3. Ranges overlap (signal stayed loud) or we're at the last
   column → vertical `top → bot` stroke.

This is the technique the 2013 LAC paper calls "connected segments"
(lac.linuxaudio.org/2013/papers/36.pdf, Fig. 3). A viewport-cropped
canvas avoids the browser's `MAX_TEXTURE_SIZE` ceiling at extreme
zoom — the component sizes its backing store to the visible slice
of its host region.

**Alternatives considered:**

1. *Keep the shader, switch to NEAREST filtering.* Fixes the blur
   but trades it for obvious pixel stair-step. Rejected because
   at 4000 px/s the stair-step is bigger than one pixel anyway.
2. *WebGL2 triangle-strip vertex geometry from the peaks array.*
   Works, but silent buckets with min=max=0 produce zero-height
   degenerate triangles and the strip visually breaks into lozenges
   with gaps between audio "hits." Keeping the strip continuous
   would require either a minimum-envelope fudge or the same
   decision logic we ended up porting anyway. Rejected once the
   Canvas2D path was proven.
3. *SVG paths.* Clean vector model but layout cost of thousands of
   `<path>` nodes blows out at extreme zoom. Rejected.

**GPL boundary:** We port the *algorithm* (a described decision
procedure, expressible in prose) from GPLv2+ code — not the code or
headers themselves. The drawing loop lives in
`web/src/viz/waveform-gl.js` alongside an explicit citation at the
file header and inline at the loop. No Ardour code or headers are
copied, imported, or linked. The waveform renderer is part of the
web layer which sits above the IPC boundary per decision 15.

Attribution citations are present for three reasons: (a) honest
acknowledgment of prior art, (b) a breadcrumb for future
contributors who want to understand *why* the decision logic looks
the way it does, and (c) a clear record that the algorithmic idea
pre-existed our implementation — useful context if the copyright
boundary is ever revisited.

**Why:** The "stretched raster" complaint was blocking the mental
model of Foyer as a pro DAW. Ardour's algorithm is 20+ years of
refinement for exactly this problem; reinventing it would be worse
and take a lot longer. Canvas2D's path-stroke primitive is hardware
accelerated on every modern browser (Chrome/Firefox via Skia), so
"use the GPU" and "draw vector paths" aren't in tension.

## 17. MIDI notes ship inline on the region envelope, not via a separate list

**Context:** The MIDI piano roll component needs per-note data, and
Ardour's `MidiModel` exposes it through `read_lock()` + `notes()`.
Two wire-shape options:

1. Emit notes inline on the `regions_list` / `region_updated`
   envelope — one round-trip covers both the region lozenges and
   the piano roll.
2. Emit regions without notes, add a separate `list_notes(region_id)`
   command, round-trip separately when the piano roll opens.

**Decision:** Inline. `RegionDesc` grows an optional `notes:
Vec<NoteDesc>` populated only for `MidiRegion`; the wire map sets
`notes` only when non-empty (existing serde skip-if-empty attribute).
Schema already had `Region.notes: Vec<MidiNote>` (introduced when
the piano roll was scaffolded).

**Alternatives considered:**

1. *Separate `list_notes` command.* Cleaner message-boundary sense,
   but doubles the round-trip cost for the 99% case where opening
   a MIDI region implies wanting the notes immediately. Also
   complicates coherence — notes that change between region and
   notes list arriving.
2. *Send notes only on explicit subscription.* Would defer the
   cost until the piano roll opens. Rejected: MIDI note payloads
   are small (~24 bytes per note, a typical region has < 1000),
   inlining them is cheap enough that the simpler protocol wins.

**Why:** The region envelope is the natural place to describe a
region's contents. Audio regions carry their source path (for
waveform peak extraction), MIDI regions carry their notes — same
shape, both optional, both populated by the shim. The read_lock
discipline keeps the shim read-safe; note edits are a separate
command set scheduled after the render path is proven.

## 18. Out-of-tree shim build is the shipping story; in-tree build stays for dev

**Context:** The shim was originally a directory under Ardour's
`libs/surfaces/` plus a one-line patch in `libs/surfaces/wscript` to
register it. That works for active development (sibling clone of
the Ardour repo, `just shim-build` recompiles everything) but is
operationally painful for end users — they'd need to rebuild Ardour
from source, or we'd need to distribute a patched Ardour binary.
The latter conflicts with Paul Davis's commercial model for Ardour
(the demo-timer on paid distributions funds ongoing development),
which we want to preserve, not cannibalize.

**Decision:** Add a CMake-based out-of-tree build as the **shipping**
artifact, keep the in-tree waf build as a **dev convenience**.

- [shims/ardour/CMakeLists.txt](../shims/ardour/CMakeLists.txt)
  builds `libfoyer_shim.so` against a sibling Ardour source tree
  (selectable via `-DFOYER_ARDOUR_SOURCE=…` or
  `$FOYER_ARDOUR_BUILD_ROOT`). Zero edits to anything under Ardour's
  `libs/`.
- The resulting `.so` gets installed into
  `~/.config/ardour9/surfaces/` (or any dir on
  `ARDOUR_SURFACES_PATH`) and Ardour `dlopen`s it at startup,
  identically to how Mackie / OSC / Generic MIDI load — Ardour's
  control-surface dispatch already does this, no new plumbing.
- Justfile recipes: `shim-cmake-build` for local compile,
  `shim-install` for installation to a user-scoped directory.
- The existing `shim-build` (waf, in-tree via symlink) recipe is
  preserved for quick iteration in the dev container — same sources,
  different build system.

**Alternatives considered:**

1. *Fork Ardour and maintain a downstream branch.* Rejected: fork
   tax, commercial implications (redistributing an unmodified
   Ardour fork would reset its demo timer, which would directly
   reduce Paul's revenue and violate the spirit of his licensing
   intent).
2. *Ship a patched Ardour binary.* Same rejection.
3. *Wait for Ardour to accept
   [PROPOSAL-surface-auto-discovery.md](PROPOSAL-surface-auto-discovery.md)
   upstream before building anything.* Rejected: we want to ship
   now. The CMake build is forward-compatible — once the proposal
   lands and Ardour ships `ardour-surface.pc`, we flip `FOYER_ARDOUR_SOURCE`
   to `find_package(Ardour REQUIRED)` and stop needing a sibling
   source tree.

**Why:** Keeping the shim as a standalone, GPL-contained `.so`
delivered separately from Ardour is the cleanest license + ecosystem
posture we can take. It preserves Ardour's commercial model, limits
our GPL surface to exactly the code that must link `libardour`, and
matches how every other mature plugin ecosystem works (LV2, VST3,
gstreamer, vim, VSCode).

**Implementation notes:**
- The CMake build uses `RPATH` pointing at the sibling tree's
  `build/libs/*/` so the produced `.so` loads cleanly in direct
  `dlopen` tests (independent of Ardour itself). When Ardour
  loads it, the host process's own library resolution kicks in
  first and the rpath is harmless.
- Output location: `shims/ardour/cmake-build/libfoyer_shim.so`.
  Install prefix convention: `${PREFIX}/surfaces/`, which matches
  Ardour's default scan paths.
- **(2026-04-20 update)** The in-tree waf path described originally is
  GONE. `just shim-link` / `shim-unlink` / the waf variant of
  `shim-build` have all been removed. Reason: keeping even a
  dev-convenience in-tree build meant you could accidentally ship /
  test against a modified Ardour binary (and that modified binary
  carried our shim inside it, which is exactly the GPL-containment
  anti-pattern Decision 15 warns about). The standalone CMake build
  is now the ONLY path. If you need faster iteration, the CMake
  build incrementally links against Ardour's pre-built libs in
  `build/libs/*/` — a first-touch rebuild is ~15 s, not the 30 min
  a full Ardour waf cycle costs, so the convenience trade-off
  evaporates in practice. See `shims/ardour/wscript` — kept only as
  a historical marker; it isn't invoked by any just recipe.

- **(2026-04-20 follow-up)** Both Ardour-side patches we'd carried
  have now been reverted, so Ardour's source tree is byte-identical
  to upstream except for the revert commits themselves:
    * `0030687bf8` (libs/surfaces/wscript foyer_shim auto-discovery)
      → reverted by `919f18ab48`
    * `546a702116` (headless: ARDOUR_BACKEND env var override)
      → reverted by `dcc6bb18e5`
  The ARDOUR_BACKEND patch had been used to let `shim-e2e` run
  hardour with "None (Dummy)" backend without a JACK server. That
  trade-off is no longer acceptable — the devcontainer now runs
  `jackd -d dummy` via `just jack-dummy` (added as a dependency of
  both `shim-e2e` and `ardour-hardev`). The container config was
  updated to `--privileged` + `--network=host` so jackd gets
  realtime scheduling and the sidecar's 127.0.0.1:3838 binds
  directly on the host. Net result: zero Ardour modifications,
  real JACK-driven audio path identical to what an end user would
  run on bare metal.

## 19. Master-bus audio tap lives in the shim as a Processor subclass, not a port insert

**Context:** M6a needed a way to get master-bus audio out of Ardour
and into the sidecar for WebRTC / WebSocket egress to browsers.
Three APIs fit the shape:

1. Subclass `ARDOUR::Processor`, insert on the master route via
   `add_processor`, copy samples in the RT `run()` callback.
2. Subclass `ARDOUR::PortInsert`, create a virtual port that Ardour
   treats as a hardware send. Audio routes through the port,
   visible in Ardour's own mixer UI.
3. JACK port-connection tap — connect a client port to the master
   output externally.

**Decision:** Option 1. `MasterTap` is a minimal `Processor` that
the shim installs via `master->add_processor(tap, PostFader, …)`
when the sidecar asks for egress, and removes on close.

- Audio path: `run()` copies interleaved samples from the
  `BufferSet` into a `PBD::RingBuffer<float>` (~200 ms capacity at
  48 kHz stereo). No allocations, no locks, no logging — RT budget
  respected.
- A non-RT drain thread wakes on a condvar every ~10 ms, reads
  whatever's in the ring, packs `[stream_id u32 LE][f32 LE PCM]`
  and calls `ipc().send(FrameKind::Audio, …)`. The sidecar's
  HostBackend decodes back into `PcmFrame` and routes to the
  existing `AudioHub` → Opus-or-RawF32 encoder → WebSocket
  fan-out.

**Alternatives considered:**

1. *`PortInsert` (shows up in Ardour's UI).* Rejected: we don't
   want the shim to introduce visible routing artifacts in Ardour's
   own mixer. Also heavier — the PortInsert model assumes a full
   send-return pair with latency compensation.
2. *JACK port-connection tap.* Rejected: Linux-only, ties us to a
   specific audio backend, breaks on ALSA / CoreAudio / WASAPI.
3. *Poll `master_out()` from the event loop at 5 ms cadence.*
   Rejected: master audio buffers are only valid inside the RT
   callback. Reading them from outside is unsupported and
   race-prone.

**Why:** The `Processor` subclass is the canonical Ardour extension
point for RT audio work — Mackie's meter readings, every plugin,
Ardour's own Send/Return all use it. Adding one more processor on
the master route is a well-understood operation the engine is
designed for. Passing data RT → non-RT via a lock-free ring is the
standard idiom (Ardour's own disk-thread does the same pattern in
reverse for record).

**Implementation notes:**
- Only `source=master` is wired today. Per-track taps land
  alongside the per-track preview feature — same pattern, just
  find the target route from the track id and `add_processor`
  there.
- Stereo is assumed (`channels=2` default). If the master has
  more / fewer channels we zero-pad up to 2, or truncate down.
  Real 5.1 / Dolby Atmos support is a future polish pass.
- The drain thread runs as a plain `std::thread`, not on the
  shim's event loop, because the event loop is busy handling IPC
  commands and we don't want audio to backpressure control.
- Sidecar-side fallback: if the backend can't produce audio (stub
  backend, or open_egress error), `ws.rs` falls back to the
  in-sidecar test tone so the "Listen" button keeps working. Real
  audio is an upgrade, not a prerequisite.

## 20. Opus encoder forces discrete stereo coding

**Date:** 2026-04-20
**Decision:** In `OpusFrameEncoder::new`, we pin `set_force_channels(Stereo)`
on every 2-channel stream. Default `Channels::Auto` is NOT acceptable for
the egress path.

**Superseded by 21** — `set_force_channels` only governs mono-vs-stereo
packet framing, not the MS/intensity coding that actually triggers the
decoder bug. Real fix is in Decision 21.

**Alternatives:**
1. *Leave as default* (`Channels::Auto`, libopus' stereo coupler
   enabled). Rejected: on perfectly-correlated L/R input (center-
   panned mono sources; a test sine; any mastered track with a
   strong mono element) Chrome's Opus decoder mis-reconstructs the
   intensity/MS-coded frame — output arrives one octave low at
   half amplitude. Verified empirically: peak drops from 0.4 to
   0.2, zero-crossings per 20 ms frame drop from ~18 to ~9.
   Other stereo masters played back cleanly, which is what made
   the bug hard to find — symptom looked intermittent.
2. *Slightly-decorrelate on the encoder input* (L×0.4, R×0.39).
   Rejected: band-aid. Production audio passes through unchanged,
   so any real track whose L/R are momentarily bit-identical
   trips the same decoder bug.
3. *Downgrade to mono on the server and up-mix on the client.*
   Rejected: the egress format is part of the wire contract; mono
   would also lose actual stereo separation for anything that has
   it, which is most of the content we care about.

**Why:** The bug lives in Chrome's decoder, not in our code path.
We can't fix the decoder, but forcing the encoder to emit two
genuinely-independent channels bypasses the broken path entirely.
Bitrate cost is negligible (we're already VBR and correlated
channels compress well even in discrete mode).

## 21. Opus encoder is CELT-only via `Application::LowDelay`

**Date:** 2026-04-20
**Decision:** Construct `OpusEncoder` with `Application::LowDelay`, which
disables SILK entirely. The encoder is CELT-only regardless of signal
content.

**Alternatives:**
1. *`Application::Audio` + `Signal::Music`.* Rejected: `Signal` is a
   hint, not a hard pin — the classifier still picks SILK for
   low-complexity / tonal / strongly-correlated input in early
   frames before VBR ramps up. Symptom observed: ~5 % of
   Listen sessions produce correct 440 Hz output, ~95 % produce
   octave-down half-amplitude output, with the same binary and
   same input. The lottery is which mode the classifier picks in
   the first few frames.
2. *`set_force_channels(Stereo)` on top of `Application::Audio`.*
   Tried, logged as Decision 20 — does NOT fix the bug. That CTL
   only affects mono-vs-stereo PACKET framing, not the stereo
   coupling that drives the decoder into its broken path.
3. *Different codec entirely (PCM, FLAC, AAC).* Rejected for now:
   Opus is the only widely-supported codec with sub-20 ms decode
   latency across WebCodecs implementations. Revisit if LowDelay
   introduces artifacts we can't live with.

**Why:** The symptom was specifically SILK-mode decoder behavior
in Chrome (SILK internally resamples to 8 / 12 / 16 kHz and the
upsampler mis-handles bit-identical L/R on some paths). Removing
SILK from the encoder removes the entire broken code path. We
stream mastered 48 kHz music; SILK's bitrate efficiency for
speech-like signals is irrelevant here.

**Tradeoff:** CELT-only has slightly worse compression for
speech-like content than Hybrid/SILK — we pay maybe 10-20 % more
bitrate on spoken-voice tracks. For an interactive monitoring
stream on a LAN that's a non-issue.

## 22. Shim CMakeLists MUST define `WAF_BUILD`

**Date:** 2026-04-21
**Decision:** `shims/ardour/CMakeLists.txt` passes
`-DWAF_BUILD` as a compile definition for every shim translation
unit. This is non-optional — without it, the shim is ABI-incompatible
with libardour.so at the struct-layout level and any method call that
touches a conditional Session/Route member will silently read garbage
memory.

**Why.** Ardour's headers (`session.h:34`, and many others under
`libs/ardour/ardour/`) guard `#include "libardour-config.h"` behind:

```cpp
#ifdef WAF_BUILD
#include "libardour-config.h"
#endif
```

`libardour-config.h` is the generated config header that defines
`USE_TLSF`, `LV2_SUPPORT`, `VST3_SUPPORT`, `HAVE_COREAUDIO`, and
dozens of other flags. Those flags gate conditional members inside
Session and Route with `#ifdef USE_TLSF` (session.h:66-70,
1666-1670) and similar. When libardour.so was built with those
defines set, its Session has one layout. When our shim compiles
against the same headers WITHOUT those defines, its Session has a
different layout — different offsets for `routes`, `_master_out`,
etc.

Concretely: the shim calls `session.get_routes()`. Under the hood
that's `routes.reader()` which dereferences `managed_object`.
libardour::Session has `routes` at offset ~12700 bytes; our
miscompiled Session has `routes` at a DIFFERENT offset (e.g. 12728
vs 12720). Our call reads from the wrong place, gets zero bytes,
dereferences a null atomic, SIGSEGV inside `RCUManager::reader()`.

**How we found it.** Every crash stack landed in
`RCUManager::reader` with `managed_object` somehow null, but
Ardour's own code at [session_state.cc:318] was using the same
RCU synchronously just moments before. The tell-tale sign was
`gdb -ex "x/4xg $rcu_addr"` showing all zeros at the RCUManager's
member location — bytes that in real libardour contained a vtable
and non-null atomic pointer. Those bytes were ZERO in our compile
because we were reading past the actual `routes` member, into
unused padding or an adjacent std::string. The six hours of
"RCU race" debugging we did before finding this — weak_ptr
caches, `session_loaded` signal timing, same-thread vs event-loop
handler dispatch — were ALL ghost chases. The bug was ABI
mismatch, not concurrency.

**Alternatives:**
1. *Forward-declare Session opaquely and call all methods through
   a PIMPL.* Rejected: would require a wrapper library maintained
   in Ardour's tree — that defeats the whole standalone-shim
   point (see Decision 18) and still requires matching flags on
   the wrapper side.
2. *Mirror libardour's exact set of defines explicitly in our
   CMakeLists.* Rejected: brittle. Ardour's flags depend on what
   was detected at Ardour's own configure time; we'd have to
   re-run the same detection or parse `libardour-config.h`.
   Defining `WAF_BUILD` lets Ardour's own generated header ride
   in with the correct flags for whichever build of libardour we
   link against.

**Tradeoff.** The `WAF_BUILD` name implies "we're being built by
waf." We're not — we're CMake. But it's the token Ardour's
headers chose to pivot on, and defining it in our CMake build
is the minimum-surface way to be compatible. Adds nothing else
to our compile.

**Failure mode if re-introduced.** Any future refactor that
splits the CMakeLists, moves the target_compile_definitions to a
different scope, or migrates to a `find_package(Ardour)` helper
must carry `WAF_BUILD` (or an equivalent Ardour-blessed include
trigger) forward. The failure is non-obvious: crashes look like
concurrency bugs, not ABI bugs, because the struct layouts are
plausibly close (just different by a few bytes).

## 23. Passive-tap Processors must `display_to_user() == true`

**Date:** 2026-04-21
**Decision:** `MasterTap` (and any future `ARDOUR::Processor`
subclass we install on a Route for a read-only audio tap) returns
`true` from `display_to_user()`. The processor shows up in Ardour's
GUI mixer as `"Foyer Studio Master Tap"`. Users who open the
native GUI see it; users running headless don't care.

**Why.** `Route::setup_invisible_processors()`
([route.cc:5591-5610](../../ardour/libs/ardour/route.cc#L5591))
is called from `configure_processors_unlocked`, which runs on
every `add_processor` cycle and every time the processor chain
is touched. It builds a fresh `new_processors` list and only
keeps:

- Processors where `display_to_user()` returns `true`
- Ardour's own hardcoded internal types (amp, meter, main_outs,
  trim, monitor_send, monitor_control, surround_send, foldback
  sends, beatbox)
- Foldback `Send` instances specifically

**Anything else with `display_to_user()==false` is silently
dropped.** Line 5873 then does
`_processors = new_processors;` — the DROP is the assignment;
nobody logs it, nobody returns an error. `Route::add_processor`
returns 0 (success), the processor passes initial insertion into
`_processors` at line 1205, then `setup_invisible_processors`
rebuilds the list without it. From our side we see: rc=0, no
err, but `foreach_processor` enumerates 5 items instead of 6.
Our tap's `run()` never fires because Ardour has no pointer to
it in the active chain.

**How we found it.** Instrumented the add flow with:
- `rc` from `Route::add_processor`
- `err.index / err.count` from the `ProcessorStreams` out-param
- A `tap_found_in_chain=0/1` boolean checking the chain
  post-add

Got `rc=0 err.index=0 err.count=(0,0) tap_found_in_chain=0`
— pointing the finger at a silent drop between insert-success
and post-add readback. Grep of Ardour's source for the code
between insert and readback led to `setup_invisible_processors`.

**Alternatives:**

1. *Pretend to be one of Ardour's hardcoded internal types.*
   Rejected: would require subclassing e.g. `Meter` or `Amp` and
   would tie our ABI to Ardour's internal class hierarchy. Also
   the hardcoded list lives in `_processors`-identity tests
   (`if (proc == _meter)`), not type checks — impossible to
   impersonate from outside.
2. *Install the tap via a mechanism that's not a `Processor`
   subclass on the Route* (e.g. an IO port connection at the
   JACK layer, or a hook in `Session::process`). Rejected for
   M6a: keeps the shim's GPL surface minimal and matches the
   Mackie/OSC idiom of "surface code lives in
   `libs/surfaces/...`." Revisit if we ever need a truly
   invisible tap.
3. *Extend Ardour to support third-party invisible processors.*
   Upstreamable in theory, rejected for now: Decision 18 keeps
   Ardour pristine.

**Tradeoff.** Users opening the GUI mixer will see the tap.
Informative ("Foyer Studio is monitoring this bus"); not
destructive (tap is pass-through, zero signal effect). Could
cause confusion for a user who doesn't know about Foyer. Fine
for now.

**Failure mode if re-introduced.** If someone flips
`display_to_user()` back to `false` thinking it's a cleanup, the
tap will silently stop working. No crash — just silent audio
egress. Test for this: after installing the tap, grep daw.log
for `foyer_shim: [audio] stream_id=<id> run=<N>` — if `run`
stays `0` while transport is rolling, we're back in this trap.

## 24. Audio ingress rides the active backend's soft-port API, not a custom backend

**Date:** 2026-04-21

**Context:** M6b needs the reverse of MasterTap — browser-captured
audio (mic, system audio, another client's push-to-talk) has to
land in Ardour as a recordable input. The wire path is already
half-built: `AudioSource::VirtualInput { name }` exists in
[foyer-schema/src/audio.rs:86](../crates/foyer-schema/src/audio.rs#L86),
`Command::AudioIngressOpen` flows through the IPC layer, and the
shim dispatcher has a stubbed `on_audio_frame` waiting for a
handler. The open question was *which Ardour extension point*
takes the incoming PCM and makes a Track see it as an input.

**Decision.** Register virtual input ports on whatever
`AudioBackend` is already active (JACK, ALSA, CoreAudio, WASAPI)
via the public
[`PortManager::register_input_port()`](../../ardour/libs/ardour/ardour/port_manager.h#L138)
API at runtime, then feed their buffers from the shim each
process cycle using the same IPC-drain pattern MasterTap uses in
reverse. The user's real audio device stays connected to its
real backend; our virtual ports are additional soft ports on the
same backend instance, indistinguishable to Ardour's track-input
routing from any other port.

**Alternatives considered:**

1. *Custom `FoyerAudioBackend` (full subclass of
   `ARDOUR::AudioBackend`).* Rejected: Ardour holds a single
   `shared_ptr<AudioBackend>` in
   [port_manager.h:278](../../ardour/libs/ardour/ardour/port_manager.h#L278)
   and `AudioEngine::set_backend()` calls `drop_backend()` before
   instantiating a new one. Picking our backend would lock the
   user out of their real audio I/O — a dealbreaker for a tool
   meant to ride alongside an existing Ardour setup.

2. *Subclass each of `JackAudioBackend`, `AlsaAudioBackend`,
   `CoreAudioBackend`.* Rejected: each backend ships as its own
   `.so` loaded via `Glib::Module`; we'd be maintaining three
   forks of fast-moving code that isn't designed for subclassing
   (not exported with extension in mind, no stable ABI). The
   maintenance tax scales linearly with backends — exactly the
   wrong direction.

3. *Decorator / wrapper backend that composes the real one.*
   Rejected as unnecessary: the public `register_input_port()`
   API already provides the exact hook a decorator would expose,
   without us having to implement an `AudioBackend` interface
   at all.

4. *Injection `Processor` mirrored from `MasterTap` (write audio
   into a track's buffer on `run()`).* Rejected for the
   recordable-input use case: Ardour's recording path reads from
   input ports *upstream* of the processor chain, so a
   processor-injected signal is monitorable and bounceable but
   can't be armed and recorded the normal way. Fine if we later
   want "route browser audio to a bus for live monitoring"; not
   the primary ingress path.

5. *`IOPlug` system.* Rejected: partially-implemented stubs in
   [session.h:1007-1020](../../ardour/libs/ardour/ardour/session.h#L1007),
   no working implementation in current Ardour — not production
   ground.

**Why.** Same logic as Decision 23 in spirit: find the Ardour
API that already does the thing, use it, don't fork. Soft ports
on the active backend give us exactly "a port the user can
assign to a track's input, fed by us" with none of the "which
backend is the user on" branching logic. Cross-platform falls
out for free — ALSA on Linux, CoreAudio on macOS, WASAPI on
Windows all go through the same `PortManager` public API.

**Implementation sketch** (for when this moves up the priority
queue):

1. **Shim side.** On `AudioIngressOpen { stream_id, source:
   VirtualInput { name }, format }`, call
   `AudioEngine::instance()->register_input_port(DataType::AUDIO,
   "foyer:" + name, …)`. Hold the returned `PortPtr` keyed by
   `stream_id`. Each process cycle, drain the IPC ring of incoming
   f32 PCM frames and write them into the port's buffer via
   `port->get_audio_buffer(nframes)`. Pattern mirrors MasterTap
   in reverse: non-RT IPC thread fills a `PBD::RingBuffer<float>`,
   a lightweight per-port callback on the RT thread pulls from
   the ring into the port buffer.

2. **Sidecar side.** `FrameKind::Audio` already flows from
   sidecar → shim (added for M6b scaffolding). Browser captures
   via `getUserMedia`, encodes in WebCodecs (same Opus path as
   egress, reused), sidecar decodes and forwards as PCM over IPC.

3. **Latency.** The schema already carries a `LatencyReport`
   type and `Backend::measure_latency()` trait method
   ([foyer-backend/src/lib.rs:248](../crates/foyer-backend/src/lib.rs#L248)).
   Actual implementation is TBD; rough ingress latency budget is
   browser-capture + network + sidecar-decode + one process
   period. Don't attempt sample-accurate multitrack overdubs in
   v1 — advertise ingress as "monitoring / scratch-take grade"
   until latency calibration lands.

**Tradeoffs.**

- Soft ports don't automatically appear in Ardour's hardware-port
  UI the way a dedicated backend's ports would. They show up in
  the input routing matrix as named Foyer ports, which is
  actually what we want (clearly labeled, attributable to Foyer).
- Backend-specific quirks (JACK's naming rules vs ALSA's period
  handling vs CoreAudio's HAL integration) are mostly abstracted
  by `PortManager`, but if a backend ever rejects a soft-port
  registration we need a fallback — so far no evidence that any
  of the three targeted backends do.

**Failure mode if re-introduced.** If a future contributor looks
at this and thinks "we should just write a custom backend,
that's the 'right' abstraction" — reread the first alternative
above. The custom-backend path is technically cleaner in the
abstract and operationally catastrophic because it displaces the
user's real audio device. Soft ports on the active backend is
the less-pretty, more-correct answer.

## 25. Beat-sequencer audio preview is a browser-side synth, not DAW-routed

**Context.** Users want audible feedback when they click a cell in
the beat sequencer (or a key in the piano roll) so they know which
drum they just placed without having to hit play. Rich's ask on
2026-04-21: "have a checkbox to enable/disable audio preview in
all piano rolls so when you click a note or drum, as long as the
channel is unmuted and bussed to output (not disk only) it plays".

**Decision.** The `Preview` toggle in the beat sequencer plays a
short WebAudio tone/drum synth in the browser, independent of the
DAW's actual instrument or mixer routing. State is stored in
`localStorage` at `foyer.beat.preview.v1`. The real DAW-routed
preview (hear the actual instrument, through the user's plugin
chain, respecting mute/solo/send state) is deferred.

**Why not DAW-routed.**

1. **No clean Ardour API for single-shot MIDI injection.** The
   obvious knobs (`Session::process_transport_fsm`,
   `MidiTrack::process_output_buffers`) are all hot-path RT code.
   Adding a soft MIDI port just for preview notes is a non-trivial
   slice (mirror of the ingress work called out in Decision 24).
2. **Latency of the IPC round-trip.** Even if we had the API, a
   click → IPC → shim → Ardour RT → audio out round trip is tens
   of ms — audible "click-then-sound" lag that defeats the point.
   The browser path is ~3 ms.
3. **Ship-first rule.** Rich asked for audio feedback; a browser
   synth meets the UX intent today while a DAW-routed variant can
   land alongside the ingress work (Decision 24).

**Tradeoffs.**

- Preview doesn't honor the track's plugin chain — kick clicks
  like a sine blip, not like the instrument on the track.
- Preview doesn't respect mute/solo — it always plays, since it's
  out-of-band.
- The checkbox is a UX promise we'll keep: when DAW-routed
  preview lands, the same toggle controls it; no user-facing
  change required.

**Failure mode if re-implemented as DAW-routed first.** The
feature would sit behind the ingress-slice blocker indefinitely.
A browser synth is the pragmatic stop-gap; it unblocks the "did I
just add a kick?" workflow without waiting on RT-discipline work.


## 26. Track monitoring (auto/input/disk) lands as a string field on TrackPatch, not as a Parameter

**Context.** Ardour has `ARDOUR::MonitorChoice` (`Auto`, `Input`,
`Disk`, `Cue`) on every track. Rich's 2026-04-21 ask: "Add disk
(play) and in (monitor) option on the mixer". The two natural
representations are:

1. **As a Parameter** — like `gain` / `mute` / `solo`, subscribe
   via `ControlController`, `ControlSet` messages both ways.
2. **As a string field** on `Track` (snapshot) and `TrackPatch`
   (mutate), going through `UpdateTrack` / `TrackUpdated`.

**Decision.** Option 2 — string field. The on-the-wire values are
`"auto" | "input" | "disk" | "cue"`. Schema path:
`Track::monitoring: Option<String>` +
`TrackPatch::monitoring: Option<String>`. Shim maps to / from
`ARDOUR::MonitorChoice` at the boundary.

**Why not a Parameter.**

1. **It's a 4-value enum, not a continuous control.** Parameters
   fit faders and toggles. A four-state radio group is awkward in
   the `ControlValue::Float|Bool|Int|Enum` vocabulary without
   leaning on the enum variant — which would mean burning a
   numeric id into the client wire protocol for an opaque
   MonitorChoice int.
2. **The UI is coarse.** A 3-button segmented control (AUTO / IN
   / DISK — we hide `cue` for now since Ardour's Cue mode is a
   monitor-section feature most users don't touch) is cleaner as
   a `TrackPatch` one-shot than as a fader-shaped parameter.
3. **Monitoring is stripe-level metadata, not a plugin-chain
   parameter.** It lives alongside `name`, `color`, `group_id` in
   the patch vocabulary, not alongside gain/mute/solo.

**Tradeoffs.**

- No per-value control-id, so the meter-batch pattern doesn't
  apply. But: monitoring state changes on the order of human
  clicks, not per-frame, so the patch path's granularity is fine.
- A future change to bring in `cue` is purely additive: the enum
  string gains a value, no breaking change.

**Failure mode if re-implemented as a Parameter.** The UI would
need bespoke dropdown rendering in `track-strip.js` keyed on the
parameter's `enum_labels`, and the wire format would carry
Ardour's numeric choice ids directly — a tighter coupling that
we'd eventually have to undo when another host with a different
monitoring vocabulary showed up.


## 27. Region creation is a dedicated `CreateRegion` command, not a generic "save empty region" via UpdateRegion

**Context.** Rich's 2026-04-21 ask: "Add 'add region' in midi
channel context menu (should add region at point where right
clicked)". Two shapes:

1. **`UpdateRegion` on a nonexistent id** — if the backend
   doesn't find the id, fall through to creating a region with
   that id + the patch's fields. Zero-new-schema approach.
2. **Dedicated `CreateRegion { track_id, at_samples, length_samples, kind, name }`**.

**Decision.** Option 2 — dedicated command. Shape matches
`DuplicateRegion` for symmetry; the sidecar forwards to the shim
which calls `Session::create_midi_source_for_session` +
`RegionFactory::create(source, plist, true)` +
`playlist->add_region(...)`.

**Why not UpdateRegion fall-through.**

1. **Id semantics become ambiguous.** `UpdateRegion` means "the
   region you're thinking of". Creating a region from a missing
   id silently would hide bugs (typo'd id? stale id after
   delete?) that we want to surface as errors.
2. **Kind is required at create time.** A MIDI region needs a
   MidiSource; an audio region needs an AudioSource + file path.
   `UpdateRegion` has no `kind` field and shouldn't — patches are
   "change what's there", not "construct new storage".
3. **The shim side is mechanically different.** `UpdateRegion`
   walks to a known region via `find_region`; `CreateRegion`
   picks a playlist off a track, allocates a fresh source,
   constructs the region with PropertyList defaults. Two paths
   in the handler with no shared code.

**Tradeoffs.**

- One more schema variant to maintain. Minor.
- Audio region creation is gated (kind != "midi" returns an
  error) until we wire a source-file picker — that's a separate
  UX slice we don't have today.

**Failure mode if re-implemented as UpdateRegion fall-through.**
Typos in a region-edit path would silently create phantom regions
on the timeline. The dedicated `CreateRegion` keeps the two
intents (create vs mutate) syntactically distinct and catches
those bugs at the wire level.


## 28. Sequencer/MIDI conversion uses an `active` flag on the layout, not separate regions

**Context.** Rich's 2026-04-22 ergonomic ask: opening a
sequencer-owned region in the piano roll should be read-only
(because manual edits would be clobbered by the next sequencer
regen), with a "Convert to MIDI" escape hatch; and opening the
sequencer on a regular MIDI region should warn about the
destructive overwrite, with an option to restore a previously
archived sequencer layout.

**Decision.** Add a single `active: bool` field on
`SequencerLayout` (default true). State machine:

- `active = true`: server regenerates notes on every
  `SetSequencerLayout`; piano roll boots read-only with a
  "Convert to MIDI" banner that flips the flag to `false`.
- `active = false`: server persists the layout metadata but
  skips `ReplaceRegionNotes`. The notes on the region are
  authoritative MIDI. Piano roll is editable. Beat sequencer
  shows an "Archived" banner with a "Restore sequencer" button
  that flips the flag back to `true` (and triggers a regen,
  overwriting the MIDI edits the user made in the meantime).

The layout is never deleted by the conversion — it's archived in
place on the region's `extra_xml`, survives save/load cycles,
and can always be restored from the piano-roll context menu's
"Restore beat sequencer…" option.

**Why not separate regions or `ClearSequencerLayout`.**

1. **Separate regions fragment the project.** "Sequencer region"
   and "MIDI region" as distinct types would mean the user has
   to split or merge regions to convert between them — which
   breaks the "my track is one region" mental model Hydrogen /
   FL Studio users bring. One region, one state flag, one place
   to toggle.
2. **`ClearSequencerLayout` throws away work.** The existing
   clear command drops the layout entirely. That's the *wrong*
   destructive semantic for "convert to MIDI" — the user almost
   certainly wants to come back to the sequencer later. An
   `active` flag preserves the layout while changing who owns
   the notes.
3. **Round-trip fidelity.** A single boolean round-trips through
   `extra_xml` with zero format churn. The stock Ardour
   save/load cycle preserves it for free.

**Tradeoffs.**

- One extra boolean on the wire. Negligible.
- Users can "edit the archive" in the sequencer UI without
  restoring it — valid for tweaking the layout ahead of a
  restore, but needs a banner so they don't wonder why their
  changes aren't playing. Banner cost is a few lines of CSS.
- Piano-roll edits during the archived window are mortal: they
  get overwritten by a restore. The warning in the "Restore
  sequencer" confirm dialog has to be unmistakable.

**Failure mode if re-implemented with separate region types.**
Conversion would require destructive region operations
(delete + re-create) and the user's fade/envelope/color metadata
would get lost on each flip. With an `active` flag, the region
identity is stable across every conversion cycle — the only
thing that changes is who's authoritative for the note list.
