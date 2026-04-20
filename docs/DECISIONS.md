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
- The in-tree wscript stays in `shims/ardour/wscript` and is used
  by `just shim-build`. It symlinks the shim dir into
  `/workspaces/ardour/libs/surfaces/foyer_shim`. Only touches the
  sibling clone, never upstream Ardour's committed files.

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
