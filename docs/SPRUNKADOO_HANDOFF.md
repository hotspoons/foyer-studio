# Sprunkadoo — session handoff (2026-05-25, eleventh pass)

## Arrangement model aligned with main-UI reference

Rich's catch: "there's a fully functioning version of this for
reference in the main UI." Pulled up
[web/ui-full/components/timeline-view.js](../web/ui-full/components/timeline-view.js)
and [beat-sequencer.js](../web/ui-full/components/beat-sequencer.js) —
they already use the schema's `layout.patterns[]` + `layout.arrangement[]`
model. Backend's `expand_sequencer_layout` walks the arrangement
slots and emits notes per placed pattern, so continuous concat
playback is FREE if you build the layout right.

Refactored sprunkadoo to match:

- Each arrangement **chip becomes one pattern** in
  `layout.patterns[]`. Pattern id = chip id (no extra mapping).
- `slot.boards` is now keyed **by chip id**, not by the legacy
  intro/verse/chorus/drop. Toggling a cell while chip A is
  active writes into `slot.boards[A.id][rowId]`.
- `layout.arrangement[]` is built cursor-summed: chip 0 at
  bar 0, chip 1 at bar `chip0.length_bars`, chip 2 at bar
  `chip0+chip1.length_bars`, … The whole song plays end-to-end
  with NO manual switching.
- Loop range = total song bars (sum of `length_bars` across
  every chip), no longer pinned to the active chip alone.
- `pattern_steps` = the LONGEST chip × `STEPS_PER_BAR` so all
  chips fit the shared grid; shorter chips leave their high-
  numbered steps empty.

### Active dot = editor focus, not playback gate

The on-stage color-dot strip now controls only which chip the
**interior editor paints into** — the audible song still plays
every chip in chip-strip order. Tap a dot to switch which chip
you're editing.

`setActiveArrangement` no longer captures-then-syncs the live
slot.boards (that was a leaky abstraction); slot.boards is
already keyed by chip id directly so a switch just changes
which key the editor reads/writes.

### Verified end-to-end (`/tmp/sprunkadoo-concat-probe.js`)

After assigning Drum Kit + adding a 2-bar chip:
- `patterns` = 2 (one per chip) ✓
- `arrangement` = `[{pattern_id: "arr.0", bar: 0}, {pattern_id: "arr.X", bar: 4}]` ✓
- `set_loop_range` covers 6 bars (4 + 2) × samplesPerBar ✓

The backend's expander now walks both chips and emits the kid's
authored notes per chip, so transport playback hits chip A's
beats for bars 0-3, then chip B's beats for bars 4-5, then loops.

### Migration

v6 → still v6 (the schema bump from the prior pass already
discards old saved stages). New `slot.boards` keys are chip
ids; v5 saves had pattern_id keys ("intro" etc.) but the
version bump already drops them. Existing chips' `boards`
field on the arrangement object is gone — `sanitizeArrangements`
strips it on load.

---

# Sprunkadoo — session handoff (2026-05-25, tenth pass)

## Arrangement editor — shipped

Rich's call: pull the entry-point out of Settings and make it a
persistent toolbar affordance + add per-arrangement length
1..4 bars.

### Toolbar
- **"Arrange…" button** between BPM slider and the on-stage dot
  picker. Glyph is a tricolor 3-block strip (`GLYPHS.arrange`)
  reading "song with multiple parts". Same chrome as the
  flag / pause / stop / hamburger glyphs.
- **On-stage color-dot picker** auto-appears between the
  Arrange button and the hamburger when ≥2 arrangements
  exist. Hidden at 1 arrangement so the default UI stays
  clutter-free. Each dot is the arrangement's color; active
  dot wears a white ring. Tap to swap which arrangement is
  on stage.

### Modal — `<sprunkadoo-arrangement-modal>`
Same dimmed-backdrop + big-red-X visual language as the
sequencer interior + settings panel. Backdrop click + ESC
dismiss.

Inside:
- **Chip strip** — one chip per arrangement, displays its
  length number ("4 BARS" or "2 ● Live" if active). "+ Add"
  button at the right end.
- **Two-click model**: 1st click selects (detail panel
  refreshes); 2nd click on the same chip OR clicking "Use on
  stage" in the detail swaps the active arrangement. Prevents
  the kid from accidentally swapping the stage mid-edit.
- **Color palette** (8 swatches from `ARRANGEMENT_COLORS`) —
  tap to recolor the selected chip.
- **Length picker** — 1 / 2 / 3 / 4 bars (default 4).
- **Delete** — red button. Greys out when only one
  arrangement remains (we always keep ≥1).

### Data model — `state-store.js` v5 → v6

```js
arrangements: [
  { id: "arr.0", color: "#a45fc9", length_bars: 4, boards: {/* per-slot per-row step arrays */} },
  …
],
activeArrangementId: "arr.0",
```

Switching the active arrangement:
1. `_captureLiveBoardsToActive` snapshots the live `slot.boards`
   into the OUTGOING arrangement so in-progress edits are kept.
2. `_syncActiveBoardsToStage` mirrors the INCOMING arrangement's
   boards onto each live slot.
3. Dispatches `arrangements-changed` (kind=active-changed) +
   `board-changed` (kind=arrangement-switch).

`toggleCell` also captures-to-active on every write so the
chip the kid is authoring stays durable across switches.

### Loop range follows arrangement length

`_startAlwaysOnLoop` now reads
`this._store.activeArrangement.length_bars` instead of the
hardcoded `LOOP_BARS = BARS_PER_PATTERN = 4`. Same for the
tempo-debounce re-pin. Picking a 1-bar chip = the loop is 1
bar; tempo / position recalcs use the same value.

### Verified end-to-end

`/tmp/sprunkadoo-arranger-probe.js`:
- Default: 1 arrangement, dots hidden, Arrange button present ✓
- Click → modal opens with 1 chip + Add button ✓
- Add chip → 2 chips, on-stage dots appear ✓
- Resize chip to 2 bars + switch active → loop re-pins from
  end=384000 (4 bars × 120bpm × 48k) to end=192000 (2 bars) ✓

### What's NOT in v1 (deferred)

- Multi-arrangement continuous concatenated playback — kid
  manually taps a dot to switch. v2 would concat boards along
  the timeline and grow the region length.
- Per-arrangement genre / tempo override — current dial is
  global.
- Drag-to-reorder chips — `moveArrangement` exists in the
  store but the UI doesn't expose it yet (was on the wishlist
  but cut for this push).

---

# Sprunkadoo — session handoff (2026-05-25, ninth pass)

## Genre Dial + tempo-follows-genre

- 9 dial pills above the patch palette (was 6): **All**,
  **Beats**, **Bass**, **Melody**, **Voice**, **FX**, **Spooky**
  (instrument families) + **Punk**, **Dance**, **Metal** (style
  filters per Rich's 2026-05-25 ask).
- Each genre has a `defaultBpm` in
  [genres.js](../web/ui-sprunkadoo/genres.js). Picking a non-
  "All" pill sets the transport tempo via the debounced apply
  path, so the loop snaps to a sensible speed for the vibe.
  "All" preserves whatever tempo was set.

| Pill   | BPM | Notes                                       |
|--------|-----|---------------------------------------------|
| Beats  | 110 | hip-hop / pop drum focus                    |
| Bass   | 100 | groove-anchored                             |
| Melody | 96  | piano-loop tempo                            |
| Voice  | 92  | choir-friendly                              |
| FX     | 120 | neutral                                     |
| Spooky | 80  | drag, ominous                               |
| Punk   | 170 | fast + aggressive                           |
| Dance  | 128 | four-on-the-floor                           |
| Metal  | 180 | heavy + driving                             |

Patches are tagged with multiple genres (`PATCH_GENRES` map);
a drum-kit tile shows up under Beats, Punk, Dance, AND Metal
because that's how percussion actually works across styles.
Verified via `/tmp/sprunkadoo-tempo-probe.js`:

- Punk → 7 tiles + 170 BPM ✓
- Dance → 9 tiles + 128 BPM ✓
- Metal → 10 tiles + 180 BPM ✓
- Spooky → 3 tiles + 80 BPM ✓
- All → 21 tiles, tempo preserved ✓

## Arrangement editor — plan landed, build deferred

Full design captured in
[docs/SPRUNKADOO_VISION.md](SPRUNKADOO_VISION.md) under
"Arrangement editor". Highlights:

- Default UI stays unchanged — one 4-bar arrangement on loop.
- New **"Arrange…"** button in Settings → Advanced exposes the
  longer-form composer (gated behind the existing parental
  click, so the kid sees a deliberate "this is more advanced"
  path).
- Arrangement = one 4-bar block of the current 7-slot stage's
  authorings. Identified by COLOR, not by name (no typing
  surface for non-readers).
- Chips reorder by drag, delete via the same red-X gesture used
  everywhere else.
- On-stage color-dot strip appears only when ≥2 arrangements
  exist (auto-hides at 1 to keep the default UI clean).
- Data model: `arrangements: [{id, color, boards}]` +
  `activeArrangementId` in `state-store.js`. Switching an
  arrangement = rebuilds + re-pushes every slot's
  SequencerLayout via the existing path.
- v1 ships **one arrangement audible at a time** (kid switches
  manually via the color-dot strip). Continuous concatenated
  playback is a v2 follow-up — requires growing the region
  length + concatenating authorings, more involved.

This pass shipped the **entry-point button** in
[preferences-modal.js](../web/ui-sprunkadoo/components/preferences-modal.js)
Settings → "Song arrangement" section, plus a "coming soon"
toast wired in `_onOpenArranger`. The editor modal itself is
the next chunk of work.

---

# Sprunkadoo — session handoff (2026-05-25, eighth pass)

## Audio + MIDI ingress — both now work end-to-end

Phantom + Mr Fun Computer are the two ingress sprunkis. Earlier
attempts wired Phantom into its own slot's track (which is MIDI
and can't process audio inputs) and only fired the ingress
bootstrap on the drag-from-palette event (not on programmatic
`assignPatch`). Refactor in this pass:

- **`_reconcileIngressForSlot`** is now the single source of
  truth, called from `_onStageChanged` so both drag AND probe
  paths reach it.
- **Phantom audio ingress** routes to a dedicated AUDIO sidecar
  track named **"Sprunkadoo Mic"** (lazy-created on first
  placement). Slot tracks stay MIDI — the mic track is a
  separate audio bus. FX rail on Phantom's interior targets
  this track via the new `_fxTrackIdForSlot(slot)` resolver.
- **Performer (Mr Fun Computer / `mfc-keys`)** = Web MIDI ingress.
  On placement: `webMidi.armTrack(slot.track_id)` so the kid's
  keyboard plays through the slot's `gmsynth`.
- **Auto-snap to scale** — `_installAutoSnapTap` mutates every
  outgoing Note On/Off byte through foyer-core's WebMidiService
  `setTap` hook. Each note's pitch class is checked against
  `pitchClassesForKey(harmony.key)` from
  [theory.js](../web/ui-sprunkadoo/theory.js); out-of-scale
  notes shift to the nearest scale tone (ties favor the lower
  pitch — less startling than jumping up). Velocity + channel
  preserved. The "no wrong notes" promise from the vision doc.

### Verified end-to-end via `/tmp/sprunkadoo-ingress-probe.js`

- Phantom drop → Sprunkadoo Mic track created (kind: audio) →
  `audio_ingress_open` fires → `update_track` patches the mic
  track's `input_port` with the engine port name ✓
- Performer drop → `webMidi.armedTrackId` matches the slot's
  track ✓ + `autoSnapInstalled: true` ✓
- Auto-snap math: Note 61 (D♭, off-scale in C major) → 60 (C)
  via the tap, status + velocity bytes preserved ✓

### FX routing for audio-ingress sprunkis

`_enabledFxFor(slot)` and `_onInteriorToggleFx` now both go
through `_fxTrackIdForSlot(slot)` which returns:
- `_micTrackId` when the slot's patch declares
  `accepts_audio_ingress`
- `slot.track_id` otherwise

So toggling Reverb on a Drum Kit slot lands the plugin on the
drum's MIDI track (as before); toggling Autotune on Phantom
lands it on the Sprunkadoo Mic audio track (where it can
actually process the mic signal).

`_anyIngressOnlyFxStillOn` gates the `audio_ingress_close` —
the browser mic indicator only goes off when the LAST ingress-
only FX (autotune / vocoder) leaves the chain.

### Cleanup on disassign

- Clearing the last `accepts_audio_ingress` slot →
  `stopAudioIngress` on the mic track. Browser mic light off.
- Clearing the last `accepts_midi_ingress` slot →
  `webMidi.disarm()`. Keyboard no longer routes anywhere.

---

# Sprunkadoo — session handoff (2026-05-25, seventh pass)

## UX polish — Rich's mid-session round

### Red-X "send home" badge replaces drag-to-palette
Kids were triggering the drag-down-to-palette gesture by accident
while reaching to drag a sprunki for volume. Replaced with an
explicit, visible affordance:

- Each costumed sprunki gets a bright red circular X badge in
  its top-right corner on hover (and on focus-within, for keyboard
  / touch).
- Click → dispatches `stage-clear`; slot goes back to gray Polo.
- Empty (gray) slots don't render the badge — there's nothing to
  send home.
- The `_overPalette` hit-test code in `_onPointerMove` /
  `_onPointerUp` is retired; only click-to-open and pure
  position-update survive on the drag path now.

[sprunki-stage.js .send-home](../web/ui-sprunkadoo/components/sprunki-stage.js)

### Sequencer interior — less twitchy dismiss + visible X
The interior closed on any click outside a cell, including the
dead space between bar blocks. Now:

- `_onBackdropClick` only dismisses if the click landed
  **outside the body's bounding rect** (e.g., header dead
  space, bottom strip below the grid). Clicks anywhere inside
  the body — including gutters between bar blocks and voice
  rows — are kept.
- `.stage` got `padding-bottom: 36px` + `display: flex` so a
  deliberate dismiss strip exists below the last bar block.
  Without this the body filled the whole stage and the kid
  had nowhere to "click outside" without hitting the grid.
- Close-X is now the same bright red as the new send-home
  badge (matching visual language: every dismiss / clear
  gesture wears the same color).

[sprunki-interior.js _onBackdropClick](../web/ui-sprunkadoo/components/sprunki-interior.js)

### Settings panel — backdrop dismiss + visible X
Opposite problem from the interior: settings only dismissed via
the X, which used to blend into the toolbar's hamburger sitting
behind it.

- Click anywhere on the dimmed backdrop (= the host element
  outside `.panel`) → dismiss.
- ESC → dismiss.
- `.panel` swallows its own clicks so taps inside don't fire
  the host listener.
- Close X is now red + bordered + drop-shadowed (same look as
  the interior X + the send-home badge).

[preferences-modal.js _onBackdropClick](../web/ui-sprunkadoo/components/preferences-modal.js)

## Phantom / Performer ingress — refactor in progress

The audio-ingress path was wired in `_onStageAssignPatch` which
only fires on the DRAG-FROM-PALETTE event, not on programmatic
`assignPatch`. Rich's cursory test of Phantom didn't work
because his manual probe didn't trigger the drag event AND
Phantom's slot track is a MIDI track that can't process audio
inputs anyway.

Refactor in flight (`/workspaces/foyer-studio/web/ui-sprunkadoo/app.js`):

- New `_reconcileIngressForSlot(slotId)` runs from
  `_onStageChanged` (kind=assigned/cleared/spawned) so both
  drag and programmatic paths trigger.
- **Phantom audio ingress** now routes to a dedicated AUDIO
  track named "Sprunkadoo Mic" (lazy-created on first audio-
  ingress patch placement). Slot tracks stay MIDI; the mic
  track is a sidecar so the autotune / vocoder FX rail still
  has somewhere to land plugins.
- **Performer (Mr Fun Computer)** = MIDI ingress. New patch
  `mfc-keys` with `accepts_midi_ingress: true`. On placement,
  arms Web MIDI on the slot's existing MIDI track (foyer-core's
  `webMidi.armTrack`) and installs an auto-snap tap that
  rewrites incoming note-on/off pitches to the nearest scale
  tone of the active key — the "no wrong notes" promise.
- New helper `pitchClassesForKey(key)` in
  [theory.js](../web/ui-sprunkadoo/theory.js) drives the snap.

**Not yet verified end-to-end** with real Ardour — paused for
this UX round. Probe + ingress lifecycle test is the next
pickup point.

---

# Sprunkadoo — session handoff (2026-05-25, sixth pass)

## Consistency bugs — fixed

Rich flagged: "mystery gray sprunki running in the background"
and "dragging a costume onto a gray slot overwrites another
track." Both traced to localStorage carryover from before the
parallel-provisioning race fix.

### Storage version bump (v4 → v5)
[state-store.js STORAGE_KEY](../web/ui-sprunkadoo/state-store.js)
bumped + multi-key legacy migration. v4 stages saved during the
window between the rename and the race fix have **all slots
sharing slot 0's track_id** — a patch assignment on slot 3
visually overwrites slot 0's audio. Forcing a fresh provision
breaks the poisoned cache. Prefs (scary mode, asset source,
parental consent) migrate.

### `dedupeStage` on load
New helper collapses duplicate slot ids (the "mystery extra
gray sprunki" — Lit keys by id, dupes render TWICE) AND clears
track_id / region_id mappings that multiple slots claim. Trims
to MAX_STAGE_SLOTS. Defense-in-depth on top of the version
bump.

## Beat-locked animation (was: meter-driven, frozen)

Audio meter is unreliable as a transient signal: AvlDrums + the
GM kit both maintain a sustained peak between hits (probe
showed `_lastLevel.slot.0 = 0.875` for SIX SECONDS straight),
so the old delta-on-intensity transient detector almost never
fired and sprunkis looked frozen.

Switched to a **transport-position-locked quarter-note tick** in
[sprunki-stage.js `_bpmTickShouldFire`](../web/ui-sprunkadoo/components/sprunki-stage.js):
- Reads `transport.position` / `audio.sample_rate` / `transport.tempo`
  every animation tick
- Computes `floor(position / samplesPerBeat)`; fires on edge
- Per beat: advances every costumed slot's `_playFrameIdx` by 1
  AND triggers the `.bounce` keyframe (visible bob)

Result: the cast dances cleanly in time with the tempo set on the
slider, regardless of how Ardour's PeakMeter behaves. Matches
the kid's mental model ("dance to my BPM"), survives JS event-
loop hiccups (anchored on playhead, not wall clock), and is
deterministic enough to test.

The `--meter` CSS var (which drives the continuous scale + glow
+ brightness pulse) now uses a **fast-attack / fast-release
envelope** computed client-side rather than streaming the raw
sustained value. Without that, sustained drum activity left
every sprunki pumped-up at 24% bigger + 48% brighter for the
entire loop. The envelope rises immediately on any new sample
above the current displayed value, but falls 12 % per meter
tick (~33 ms) — settles to <0.05 within ~600 ms of silence, so
each beat shows a visible fresh pulse.

## Polish

- **Sprunki anchoring**: `SPRUNKI_CLIP_PCT` lowered 22 → 14.
  Necks fully visible; only the hip / lower-leg band sits behind
  the grass. Rich's call.
- **Drag-Y scale range**: `0.6×..1.4×` → `0.85×..1.15×`. Y-axis
  gain is still a clear ±dB gesture, but the visual is a nudge
  rather than the previous distracting balloon. Rich's call.
- **Per-slot default gain** trimmed to **-15 dB** (`SLOT_GAIN_FLOOR_DB`
  in [sprunki-stage.js](../web/ui-sprunkadoo/components/sprunki-stage.js),
  imported by setup.js's `createSlotTrack`). Keeps a 7-strong cast
  comfortably under the master ceiling AND exposes the meter dips
  between drum hits (still useful for the envelope, even though
  the play-frame advance is now beat-locked).

Probe: `/tmp/sprunkadoo-final-probe.js` — confirms 7 unique
slots / tracks / regions, no shared track_ids after a fresh
boot, drum-kit landing ONLY on the assigned slot's track,
storage key `foyer.sprunkadoo.v5` active.

## Flower patch wired

(Held over from the fifth pass.) Asset agent added a 21st
character (`flower`, purple disgusted face per Rich's 8yo).
[`flower-chime`](../web/ui-sprunkadoo/patches.js) patch with GM
Celesta (program 9) on a two-row tonic+third structure.

## Asset redo coming

Rich said another agent will redo the assets. Notes I left in
[`/tmp/agents/lead-to-asset.md`](/tmp/agents/lead-to-asset.md)
flagging:
- Empty Polo color too close to gray-bass body color (already
  on their radar)
- idle vs play frames need to read at-a-glance — currently look
  near-identical so the beat-locked play-frame advance is
  visually subtle
- horror variants all share one face; would help if each kept
  per-character silhouette
- backdrop's grass-line silhouette should sit at 78% from top
  (matches the new 14% clip — off by ±3% and a seam shows)

---

# Sprunkadoo — session handoff (2026-05-25, fifth pass)

## Audio is alive — drum-kit playback fixed

Root-caused the dead-drums bug. Two compounding races in
[setup.js](../web/ui-sprunkadoo/setup.js):

1. **`createSlotTrack` byDelta race.** All 7 slots' provisioning
   ran in parallel via `Promise.all`. Each call captured its own
   `before = Set(track ids)` then dispatched create_track with a
   unique name and waited via `byDelta` ("any track id not in
   `before`"). As soon as the FIRST track landed in the snapshot,
   EVERY parallel waiter saw it (no-one was in `before`) and
   returned it. All 7 provisionSlot calls ended up with the SAME
   trackId. Subsequent `create_region` calls all landed on slot
   0's track, stacking 6+ empty MIDI regions there; Ardour's
   playback picked the topmost (= newest = empty) one, so the
   kid heard one initial pop and silence forever. Fix: match
   by NAME only in `createSlotTrack` — names are unique per
   slot, so name-only matching is correct AND race-safe.

2. **`ensureSprunkiStage` re-entrancy.** `_onStageChanged` fires
   for every patch assignment, kicking off a fresh
   `ensureSprunkiStage` without awaiting the previous one. With
   a stale or empty snapshot, the second call's region check
   sees "no Sprunki region exists yet" and creates another one
   on top of the first. Fix: module-level mutex serializes
   re-entry; later calls await earlier ones.

Defense in depth: provisionSlot now also DELETES any extra
"Sprunki" regions found on a track after picking the live one
(handles state inherited from before the fix).

Verified end-to-end (`/tmp/sprunki-listen.js`): drum-kit slot
produces real, varying meter activity (peak 1.37 → decaying
through 0.7 → 0.4 → 0.08) instead of the previous "one pop then
stuck at 0." Audio path works.

## FX URI server-side verification

All 4 base FX plugins land in the Ardour chain
(`/tmp/sprunkadoo-fx-verify.js`):

| FX     | URI                                              | Lands as          |
|--------|--------------------------------------------------|-------------------|
| Echo   | `urn:ardour:a-delay`                             | ACE Delay         |
| Chorus | `http://calf.sourceforge.net/plugins/MultiChorus` | Calf Multi Chorus |
| Reverb | `urn:ardour:a-reverb`                            | ACE Reverb        |
| Filter | `urn:ardour:a-eq`                                | ACE EQ            |

Chorus needed a URI swap — Ardour's `a-*` kit has no built-in
chorus, so we fall through to system LV2 (`calf-plugins` package,
already installed in all three Dockerfiles). Updated in
[fx-catalog.js](../web/ui-sprunkadoo/fx-catalog.js).

## Flower character — patch wired

Asset agent added a 21st character to Foyer Originals (`flower`,
purple body + disgusted side-eye face — Rich's 8yo's pick).
Wired a `flower-chime` patch in
[patches.js](../web/ui-sprunkadoo/patches.js) with GM Celesta
(program 9) on a two-row tonic+third structure. Falls back to
the no-art chip in OG-pack mode since the OG manifest has no
flower character.

---

# Sprunkadoo — session handoff (2026-05-25, fourth pass)

## Horror variants wired

Scary-mode flip now actually changes what the stage paints. Pulls
from the alternate buckets the asset agent shipped (Foyer
Originals + OG project's idle2 / alternate):

- **Backdrop**: `backdrop.svg` → `backdrop-horror.svg` (or the OG
  `backdropevil` md5 when source = og)
- **Empty Polo**: cycles gray's anim frames normally; flips to a
  static `empty-horror.svg` in scary mode
- **Costumed sprunki idle**: `idle_alternate[0]` if present, else
  graceful fallback to the regular idle (so a half-skinned pack
  doesn't render blanks)
- **Costumed sprunki play frames**: `alternate[]` cycle on beat
  hits; falls back to `play[]` when no horror frames exist for
  that character

Plumbing:
- New `allAlternatePlayCostumeUrlsFor(sprunkiId)` in
  [sprunki-assets.js](../web/ui-sprunkadoo/sprunki-assets.js)
- `emptySprunkiUrl({ scary })` and `backdropUrl({ scary })` now
  take an explicit flag (default false → existing behavior)
- `<sprunki-stage>` gained a `scaryMode` property; app pushes
  `.scaryMode=${this._store.scaryMode}` from
  [app.js](../web/ui-sprunkadoo/app.js)
- `_currentIdleUrl` branches on `this.scaryMode` to pick the
  right URL family

Verified via `/tmp/sprunkadoo-horror-probe.js` — toggling
scaryMode swaps backdrop to `backdrop-horror.svg`, drum-kit slot
to `fun-bot-horror-idle.svg`, empty slot to `empty-horror.svg`.

## Switch to Foyer Studio (settings → parental gate)

Settings now has a "Switch to Foyer Studio" row that bumps the
user out of Sprunkadoo into the full DAW UI. Gated behind the
same parental math quiz as scary mode:

- Locked → click dispatches `request-parental-gate`, the modal
  fires
- Unlocked → confirm dialog ("…your stage stays saved…"), then
  `setUserVariantPreference("full")` lands and `location.replace`
  reloads without the `?ui=` override so the variant resolver
  picks "full" on boot

Code: [preferences-modal.js `_onSwitchToFoyer`](../web/ui-sprunkadoo/components/preferences-modal.js)

Verified via the same probe — locked click DID dispatch the gate
event.

---

# Sprunkadoo — session handoff (2026-05-25, third pass)

## Renamed: sprunki → sprunkadoo

Rich's 8-year-old picked the name. Done in this push:

- Directory: `web/ui-sprunki/` → `web/ui-sprunkadoo/` (git mv,
  history preserved)
- Variant id: `sprunki` → `sprunkadoo`; label "Sprunkadoo"
- Legacy `?ui=sprunki` URLs still resolve via a new `aliases`
  field on the variant registry
  ([web/core/registry/ui-variants.js](../web/core/registry/ui-variants.js))
- Storage key: `foyer.sprunki.v2` → `foyer.sprunkadoo.v4`. The
  v3→v4 schema bump was already going to discard the stage; we
  pull scary-mode + asset-source + asset-pack consent off the
  legacy key on first boot, then drop it
  ([state-store.js loadFromStorage](../web/ui-sprunkadoo/state-store.js))
- Build scripts: `build-sprunki-manifest.py` → `build-sprunkadoo-manifest.py`
- Internal element tags (`<sprunki-app>`, `.sprunki-toolbar`, …)
  stay sprunki on purpose — shadow-scoped, no user-visible
  benefit to churning every file. Re-revisit if a future
  variant ever conflicts.

Verified end-to-end with `/tmp/sprunkadoo-rename-probe.js`:
both `?ui=sprunkadoo` and `?ui=sprunki` (alias) boot to
`status=ready`, new storage key is active, no legacy key
lingers.

## Audio engine — half working, more digging to do

Drum playback is half-working. AvlDrums Black Pearl loads
correctly (verified URI:
`http://gareus.org/oss/lv2/avldrums#BlackPearl`),
`set_sequencer_layout` is pushed with the right cells (44 in
"intro" pattern: kick 16, snare 8, hat 16, crash 4), the server
runs through `expand_sequencer_layout` →
`backend.replace_region_notes`. BUT meters show positive-dBFS
spikes at transport start then drop to silence, and the .mid file
on disk has bank+program changes but no note events.

Open questions for next session:
- Does `replace_region_notes` with hardcoded notes actually drive
  audible audio (test in isolation)? If yes, the bug is in
  `expand_sequencer_layout`'s arrangement/cell-offset math. If no,
  it's in the shim's `apply_diff_command_as_commit` path or the
  region's playback wiring.
- Soundfonts are already in the container Dockerfiles
  (`.devcontainer/Dockerfile`, `Dockerfile.source`, `Dockerfile.prebuilt` —
  all install `fluid-soundfont-gm`, `fluid-soundfont-gs`,
  `fluidr3mono-gm-soundfont`, `timgm6mb-soundfont`,
  `avldrums.lv2-soundfont`). No package change needed.

## Asset-agent collab

A parallel agent shipped a "Foyer Originals" in-tree asset pack
alongside the OG download (toggle in Settings → Character art) +
horror variants for scary-mode (`idle_alternate` + `alternate`
buckets populated, ~80 new SVGs under `builtin-assets/`).
Consumer wiring (`alternateIdleCostumeUrlsFor` lookup when
`scaryMode` is on, in `sprunki-stage.js`) is still open. See
`/tmp/agents/asset-agent-status.md`.

---

# Sprunkadoo — session handoff (2026-05-25, second pass)

## What shipped in the 2026-05-25 second pass

### Visual / chrome
- **Toolbar glyphs un-buttoned.** Flag / pause / stop / hamburger are
  bare SVGs with transparent backgrounds; only a hover halo. Matches
  OG sprunki's `.control-button-highlight` pattern. See
  [styles.js](../web/ui-sprunki/styles.js) `.toolbar-glyph`.
- **Sprunki sizing + anchoring.** Switched from fixed-pixel
  (170×310) to PERCENT-OF-STAGE units (17% width × 1.82 aspect,
  22% clip below grass) using `container-type: size` on the stage
  host. Cast now scales with the backdrop and the lower bodies
  sit naturally hidden behind the OG SVG's grass hills. Rich's
  before/after screenshots showed our sprunkis floating above the
  grass; now they're rooted. See
  [sprunki-stage.js](../web/ui-sprunki/components/sprunki-stage.js)
  `SPRUNKI_W_PCT`, `SPRUNKI_H_PCT`, `SPRUNKI_CLIP_PCT`.

### Animation
- **BPM-driven fallback dance.** Sprunki play-frame advance was
  meter-driven only — if the audio engine produced silence (e.g.
  fluidsynth missing a drum preset, MIDI region not yet loaded)
  the cast looked frozen even with transport rolling. Added a
  half-beat ticker (`_bpmTickShouldFire`) that advances every
  costumed slot's frame once per eighth-note WHEN no meter hit
  has bumped it in the last 600 ms. Live meters always win; this
  is a backstop. See
  [sprunki-stage.js](../web/ui-sprunki/components/sprunki-stage.js)
  `_animTick`, `BPM_TICK_FALLBACK_MS`.
- **Animation logic verified end-to-end** via direct meter
  injection probe. The bounce + play-frame-advance fires when
  meters report transients above -38 dB; the issue with the real
  Ardour was that fluidsynth was producing sustained 0 dBFS
  (clipping) with no transient deltas — not a UI bug.

### Boot speed
- **Parallel track provisioning.** `ensureSprunkiStage` now creates
  all 7 backend tracks via `Promise.all` instead of serial. On a
  cold boot this drops the wait from ~14 s → ~3 s (each
  create_track round-trip is independent). Real fix is still the
  template-project boot (deferred); this is the interim. See
  [setup.js](../web/ui-sprunki/setup.js) `ensureSprunkiStage`.

### Per-costume FX
- **FX rail in the sequencer editor.** Each open interior gets a
  left-side rail (below the bar selector) listing the costume's
  available effects: Echo / Chorus / Reverb / Filter for every
  costume, plus Autotune / Vocoder on `accepts_ingress`-flagged
  costumes (currently just Phantom). Toggle dispatches `add_plugin`
  / `remove_plugin` on the slot's track; the toggle's "on" state
  is computed from the live session snapshot (NOT localStorage —
  backend is the source of truth). See
  [fx-catalog.js](../web/ui-sprunki/fx-catalog.js),
  [sprunki-interior.js](../web/ui-sprunki/components/sprunki-interior.js)
  `.fx-rail`, [app.js](../web/ui-sprunki/app.js)
  `_enabledFxFor` / `_onInteriorToggleFx`.
- **Plugin URI catalog** prefers Ardour's built-in `a-*` plugins
  (a-delay, a-modulation-chorus, a-reverb, a-eq) so the FX work
  on any Foyer-bundled Ardour build. Autotune falls back through
  `http://gareus.org/oss/lv2/fat1` → x42-autotune.

### Audio ingress (Phantom = the mic costume)
- **Phantom on stage → mic ingress.** `accepts_ingress: true`
  added to the Phantom patch. When the kid drops Phantom on a
  slot, `_onStageAssignPatch` schedules
  `_maybeStartPhantomIngress` once the track id has landed; on
  removal `stopAudioIngress` clears the input_port.
  [patches.js](../web/ui-sprunki/patches.js),
  [app.js](../web/ui-sprunki/app.js).
- **Thin wrapper over foyer-core's `AudioIngress`.** Per Rich's
  pointer, reuse the canonical implementation from
  [web/core/audio/audio-ingress.js](../web/core/audio/audio-ingress.js)
  (AudioWorklet, sample-rate handshake, latency compensation, port
  name negotiation) instead of hand-rolling a ScriptProcessor +
  WS pipeline. Our wrapper just tracks per-trackId lifecycles +
  fires `update_track { input_port }` after start.
  [audio-ingress.js](../web/ui-sprunki/audio-ingress.js).
- **One-shot permission gate.** First Phantom placement prompts
  for mic via the browser's permission dialog; subsequent
  placements reuse the OS grant + our `localStorage` consent
  flag. Verified end-to-end with a fake-mic Playwright run —
  `ingressState(trackId)` returns `{ connected: true, portName:
  "foyer-ingress-browser-…" }` after Phantom drop.

### Advanced settings (per-slot GM program override)
- **Per-sprunki instrument selector** under the settings panel's
  new collapsible "Advanced" section. One row per stage slot
  with a `<select>` of GM favorites (Acoustic Grand → Steel
  Drums). Picking a program sends
  `set_track_midi_patch { track_id, channel, bank: 0, program }`.
  Drum sprunkis (gm_channel = 9) are visually locked because
  channel 9 is GM percussion — changing program on it doesn't
  swap the kit, it picks a drum within the kit. Empty slots are
  greyed. See
  [preferences-modal.js](../web/ui-sprunki/components/preferences-modal.js)
  `GM_FAVORITES`, `_renderAdvanced`,
  [app.js](../web/ui-sprunki/app.js) `_onSlotInstrumentChange`.

### Verified end-to-end (real Ardour)
Probe at `/tmp/sprunki-full-probe.js` (auto-grants mic permission
via Chromium flags) covers: status=ready boot → 3 patch
assignments (drum-kit + gray-bass + black-phantom) → interior
open → 4 FX tabs present → toggle Reverb → settings open →
advanced expand → Music Box pick on gray-bass slot → Phantom
ingress start. Result: clean run, port allocated, plugin sends
visible in the ws.send hook, screenshots saved to
`/tmp/sprunki-full.png` + `/tmp/sprunki-phantom-interior.png`.

### Save-session light template (Rich's #1 ask)
- **The first boot persists itself.** After
  `ensureSprunkiStage` lands the 7 tracks, [app.js `_boot`](../web/ui-sprunki/app.js)
  compares pre/post track counts and fires `save_session` 1.5 s
  later if new tracks were provisioned. The .ardour XML on disk
  IS the template — generated on demand, reused forever. No
  separate template file shipped in the repo.
- **Measured win:** cold boot 12.2 s → warm boot 0.99 s
  (≈12× faster) on the verifier probe. `Routes` count goes
  from 0 → 8 (Master + 7 Sprunki Slots) on cold save; subsequent
  boots find them via the by-name dedupe in
  [setup.js](../web/ui-sprunki/setup.js) `ensureSprunkiStage`
  and skip every `create_track` call. `save_session` only fires
  when new tracks were provisioned — warm boots are idempotent.
- Probe: `/tmp/sprunki-template-probe.js` runs the
  cold-then-warm comparison.
- **FluidSynth drum preset missing.** During the lifecycle probe
  `daw.log` showed `fluidsynth: warning: No preset found on
  channel 9 [bank=128 prog=0]` repeatedly. That's why drum
  meters reported sustained 0 dBFS — fluidsynth was outputting
  clipping noise (no actual drum samples to play). The template
  project should pre-load a working drum soundfont; without it
  the kid hears garbage when they drop a drum kit. Workaround
  for now: the BPM fallback keeps the cast visibly dancing.
- **Backend wiring for FX plugins not yet verified.** The UI
  side fires `add_plugin { plugin_uri: "urn:ardour:a-reverb" }`
  and the toggle visually flips. The shim's add_plugin handler
  may or may not actually land the plugin depending on whether
  the URI resolves in the running Ardour's LV2 catalog — needs
  a probe that watches for `track_updated` with the new plugin
  in the chain. Falls out naturally on first real use.

---

# Sprunki Beats → Bandlings — session handoff (2026-05-25, late)

Picked up from the prior handoff; cleared the full punch list +
shipped a big design pass from a live review with Rich. The
sprunki experience is now: 7 fixed slots, always-looping 4-bar
play, by-bar interior editor, OG-art everywhere, hamburger/flag/
pause/stop chrome lifted verbatim from the asset pack.

**Read this first**, then [docs/SPRUNKI_VISION.md](SPRUNKI_VISION.md)
for the full design + ADR trail.

## What shipped in the late-2026-05-25 pass

### Game-feel changes
- **Single 4-bar loop, always playing.** Section concept
  (Intro/Verse/Chorus/Drop) retired from the UI; data model
  keeps `DEFAULT_PATTERNS` for compatibility but only `intro` is
  used. Boot now controlSets `transport.playing=true` +
  `set_loop_range` covering one pattern's bars
  ([app.js `_startAlwaysOnLoop`](../web/ui-sprunki/app.js)).
- **7 sprunkis, fixed cast.** The stage is always 7 slots. Drag a
  costume tile from the palette onto an existing sprunki to
  assign; drag a sprunki down onto the palette to send it home
  (clears the patch → gray Polo, slot stays). Bare-stage drops
  are rejected with a red flash — the kid has to target a
  performer.
- **Top toolbar**, all OG chrome glyphs, no text in the main
  game:
  - Green flag → start (auto-fires on boot too)
  - Yellow pause → pause
  - Red stop → stop + position 0
  - BPM slider (horizontal, 40–300, drag any direction, no
    arrows)
  - Hamburger → settings panel
  Glyphs are lifted **verbatim** from
  `/home/vscode/.local/share/foyer/asset-packs/sprunki/index.html`
  (the TurboWarp packager's chrome SVGs) — viewBox /
  fill / path d= byte-for-byte. "When I said original, I meant
  original" — Rich, 2026-05-25.
- **Settings panel** now hosts key / mode / progression /
  per-section chord pills + scary mode + reset (via embedded
  `<sprunki-chord-strip>`). Was previously a permanent strip
  under the header.

### Sequencer rewrite (interior)
- **By-bar grouping** for the "All" view (was: by-voice). Each
  bar is its own card; inside the card the voices are rows with
  the instrument label pinned on the LEFT (Kick / Snare / Hat /
  Crash). 16 cells per voice row. Cells use
  `max-height: clamp(16px, 3.6vh, 44px)` so a 4-voice composite
  fits a 900 px viewport with room to spare.
- **Single-bar view** (clicking Bar 1/2/3/4 in the rail) keeps
  the legacy by-voice layout with bigger cells for focused
  authoring.
- **Section tabs in the interior header retired** (Intro/Verse/
  Chorus/Drop). Just the patch title + close X.

### Animation rewrite (per OG Scratch project blocks)
A background research agent dug through the asset pack's
`project.json` and the OG game's animation blocks to figure out
the actual per-character behavior. Key findings + the new wiring
in [sprunki-stage.js](../web/ui-sprunki/components/sprunki-stage.js):
- **Gray (empty) slots cycle continuously through gray's anim
  frames** (anim/anim2…anim11, 11 frames total) at 180 ms
  intervals — the "alive but waiting" twitch the OG game gives
  every empty Polo. Drives `_grayFrameIdx[slot.id]` from the
  shared 80 ms animation tick.
- **Costumed slots advance ONE play frame per audio transient**
  on the slot's own track (NOT continuous cycling). OG's
  "Loop 1/2" broadcast steps each character's frame once per
  sampled hit; we mirror this in `updateLevels` —
  delta-on-intensity above the threshold bumps
  `_playFrameIdx[slot.id]` exactly once and arms a 250 ms hold
  before reverting to idle.
- **`_currentIdleUrl` is the single source of truth** for which
  frame each slot shows: gray → grayFrames[idx]; costumed +
  recent hit → patch's play[idx]; costumed + idle → patch's
  idle[0]. The glance / blink-flicker hack is gone.

### Audio engine pain
- **Ardour SIGABRT fix landed earlier in the session** (see
  prior "Hard crash" section below) — flips
  `Config->ask_replace_instrument` and `ask_setup_instrument`
  to false at shim attach so AvlDrums multi-out doesn't pop a
  GTK dialog off-thread.
- **Backend-lost retry UI:** [app.js _onRetryBackend](../web/ui-sprunki/app.js)
  listens for the `backend_lost` envelope (emitted by
  [foyer-server lib.rs `emit_backend_lost`](../crates/foyer-server/src/lib.rs))
  and shows an error card with a "Try again" button. Retry
  re-runs `_ensureSessionLoaded` + `_boot`. Verified end-to-end
  with a synthetic event in the Playwright probe.
- **Tempo storm fix:** dragging the BPM slider now coalesces
  through `_applyTempoDebounced` (100 ms window) instead of
  firing controlSet on every pointer-move. Each tempo change
  re-pins the loop range too (samples-per-bar shifts with BPM).
- **Layout-push debounce** (120 ms) from the earlier pass still
  in place — handles board-changed + harmony-changed flurries.

### Patches
- **fun-bot-break retired.** Drum Kit already styles after
  Fun Bot, and Rich asked for 20 unique characters / no reuse.
  Patch count is now 20.
- **Emoji field removed** from every patch; the fallback chip
  (rendered when the asset pack isn't downloaded) uses the
  patch's label initial + color circle.

### Polish
- **Stage fixed aspect ratio (2.1:1)** via
  `aspect-ratio: 2.1 / 1` on the stage host + container queries
  on `.sprunki-main`. Stage scales up to viewport height OR
  width OR 1400 px, whichever is smallest.
- **Sprunki necks visible.** `SPRUNKI_CLIP_OFFSET_PX` dropped
  from 100 → 60 so the neck + upper chest stay above the grass
  line.
- **Backdrop gradient** colors sampled from the actual OG
  backdropcute SVG (`#66e6ff` → `#88f0ff` → `#00e613` →
  `#00800b`), matching the SVG's bright cyan sky + bright/dark
  hill greens so there's no seam where the SVG hills meet the
  gradient.
- **Staggered palette** — 2 rows of 80 px tiles with row 2 offset
  by 46 px (half tile + half gap) for the OG "shelf of plushies"
  brick pattern. Hover lifts tiles 6 px / 110 % scale.
- **`.sprunki.dragging` class wired** so the dragged sprunki
  rides on z-index 100. Verified with a real mouse drag.
- **Chord pill** is now a proper `<button>` with right-click =
  step-back.
- **Spawn cap = 7** (was earlier this session). Bare-stage drops
  now refuse-and-flash instead of creating an 8th slot. The
  cast is fixed.

### Open follow-ups (next session)
- **Template-project boot.** Rich called out that boot currently
  rebuilds the Ardour session from scratch each time (~15 s
  added) because it creates 7 tracks dynamically. The new
  Ardour crash this session (SIGSEGV in
  `IOButton::update → Bundle::connected_to → Port::connected_to(string)`,
  full stack in the old core dump) is in the GUI thread reacting
  to those track creations — so a pre-built template session
  with the 7 tracks already provisioned would both speed boot
  AND sidestep the race. Plan:
  - Ship a `sprunki-template.ardour` (XML-only, no audio) in
    the repo.
  - `just run` recipe copies it to the dev session dir on
    first boot.
  - `just rebuild-sprunki-template` regenerates it from the
    current `ensureSprunkiStage` output.
  - App's `launch_project` uses the template path when present.
- **Audio egress force-reset.** The foyer-server already has
  desync detection but the connection sometimes hangs in
  "no such stream after 6 s" without recovery. Need a forced
  reset path that kicks in when the audio_ws hasn't seen a
  packet in N seconds. C++ / Rust work in
  `crates/foyer-server/src/audio_ws.rs` (approximately).
- **Audio + MIDI ingress.** Mentioned in the vision doc's Phase
  2C (Mic Boi + Performer Sprunki); no design yet. Open
  question: which sprunki's track owns the ingress audio, and
  how does the kid pair it?
- **Channel effects per costume** (sequencer editor →
  per-instrument FX slots). Captured as a future TODO. Each
  costume's sequencer editor would get a row of small FX
  knobs / chips above the step grid (compressor / reverb /
  filter cutoff per voice).
- **Per-bar chords.** Settings still surfaces 4 chord pills
  (one per former section). With sections retired, the
  natural mapping is per-bar chords inside the single 4-bar
  loop, but the bridge currently applies one chord per
  pattern. Mapping change needed in
  [sequencer-bridge.js](../web/ui-sprunki/sequencer-bridge.js).
- **Rename pass** (still pending — Rich opted out earlier this
  session). Bandlings is the front-runner. Touch points listed
  in the top-of-doc rename section.

## Rename (still pending — Rich's call)

Default in the prior session was **Bandlings**. Asked Rich again
this session; he chose **Skip rename for now**. Names still on the
table: Bandlings, Stagelings, Beatlings, BopBuddies, Foyer Jam.

When the rename happens it touches:

- [web/ui-sprunki/package.js](../web/ui-sprunki/package.js) — variant
  label + id (renaming the directory itself also requires updating
  `/variants.json` discovery).
- [web/ui-sprunki/app.js](../web/ui-sprunki/app.js) — header literal
  still reads "Sprunki Beats".
- [web/ui-sprunki/state-store.js](../web/ui-sprunki/state-store.js)
  — `STORAGE_KEY = "foyer.sprunki.v2"` and the v3 version flag.
- This doc + [docs/SPRUNKI_VISION.md](SPRUNKI_VISION.md).

Emoji strip **landed** this session — see "What shipped" below.

---

## Where the variant code lives

```
web/ui-sprunki/
├── app.js                      # top-level shell, boot flow, event wiring
├── state-store.js              # SprunkiStore — v3 slot-based stage, MAX_STAGE_SLOTS=7
├── patches.js                  # 21 patches; emoji field has been retired
├── sequencer-bridge.js         # buildSlotLayout + pushAllLayouts
├── setup.js                    # ensureSprunkiStage — provisions per-slot tracks
├── sprunki-assets.js           # OG art bridge (idle/play/icon/backdrop urls)
├── sprunki-assets.json         # canonical OG manifest (re-extracted)
├── theory.js                   # keys, chords, scale degrees, resolveNote
├── styles.js                   # shared Lit styles
├── package.js                  # variant manifest + registerUiVariant
└── components/
    ├── sprunki-stage.js        # 2D free-form stage; drag-back-to-palette; size-cap
    ├── patch-palette.js        # staggered OG-style 2-row rack; drag-remove drop zone
    ├── sprunki-interior.js     # zoom-in editor; bar-rail navigator; click-drag paint
    ├── chord-strip.js          # key + 4-chord progression UI (pill is now a <button>)
    ├── transport-bar.js        # play / stop / loop + BPM drag adjuster
    ├── preferences-modal.js    # scary mode + reset
    ├── asset-pack-modal.js     # consent flow for OG sprunki art
    ├── parental-gate-modal.js  # math-quiz gate for scary content
    └── sound-catalog.js        # DEFAULT_PATTERNS + GM_PRESETS only
```

Manifest re-extraction script: [scripts/dev/build-sprunki-manifest.py](../scripts/dev/build-sprunki-manifest.py).
Re-run after any OG project.json refresh.

---

## What shipped this session ✅

### Sequencer scales (was punch #3 — "the grid runs off the bottom")

- **Bar-rail navigator** in [sprunki-interior.js](../web/ui-sprunki/components/sprunki-interior.js).
  The interior now renders **one bar at a time** with a vertical
  rail on the left holding 4 bar tabs. For a 4-voice composite
  (Drum Kit) the visible grid is 4 rows × 16 cells = 64 cells
  instead of the prior 256. Cells are bigger (76 px max) and
  tappable; truncation is structurally impossible regardless of
  voice count. Selecting bar 3 shows steps 32–47 per voice; bar
  data uses the same `boards[patternId][rowId]` shape, just
  filtered by `_activeBar * STEPS_PER_BAR`.
- Picked **Option B** from the prior punch list (single visible
  bar, vertical tabs) over Option A (transposed 4×N grid). Option
  A keeps the cell count the same and doesn't fix the truncation
  — only reducing visible cells does. Logged in code comment +
  this doc; if a kid playtest reveals "I can't see the whole
  loop," the bar-rail can grow into a mini-map preview.

### Click-drag paint (was punch #2)

- [sprunki-interior.js](../web/ui-sprunki/components/sprunki-interior.js)
  `_onStepPointerDown` + `_onPaintMove` + `_onPaintEnd`. First
  cell toggles (its new state defines paint mode); drag through
  subsequent cells in the same voice row, each cell snaps to that
  mode if it doesn't already match. Single tap still toggles one
  cell. Paint stays in the row where the gesture started — diagonal
  drags don't bleed into neighboring voices. Uses pointer capture
  + `renderRoot.elementFromPoint` to walk shadow DOM.

### Drag-back-to-palette (was punch #1)

- [sprunki-stage.js](../web/ui-sprunki/components/sprunki-stage.js)
  `_onPointerMove` hit-tests the pointer against the palette's
  bounding rect (looked up via `getRootNode().querySelector` —
  stage + palette are siblings in app's shadow). When the kid
  drags a sprunki down into the palette area, the palette pulses
  red with a "Drop here to remove" label
  ([patch-palette.js](../web/ui-sprunki/components/patch-palette.js)
  `:host(.drag-remove-target)`). Releasing over the palette
  dispatches `stage-remove-slot` instead of the usual click /
  position-update.

### Stage occupancy cap (Rich flagged this session)

- `MAX_STAGE_SLOTS = 7` in [state-store.js](../web/ui-sprunki/state-store.js).
  `spawnSlot()` returns `null` when the stage is full. Drop-on-
  blank-stage in [sprunki-stage.js](../web/ui-sprunki/components/sprunki-stage.js)
  `_onDrop` flashes a red border (`.stage-surface.full-reject`)
  when the cap is reached so the kid sees the drop didn't take.
  Replacing a patch by dropping on an existing sprunki still
  works at any cast size.

### OG-style staggered palette (was punch #5)

- [patch-palette.js](../web/ui-sprunki/components/patch-palette.js)
  now renders two `.rack-row`s in a horizontal scroll. Tiles are
  80 × 80 px (was 56), gap 12 px (was 4), `.row-2` padding-left
  46 px (half-tile + half-gap) for the brick offset. Hover lifts
  tiles 6 px / scales to 1.10 for the OG "shelf of plushies" pop.

### Stage cap + sprunki size (was punch #4)

- `.sprunki-main sprunki-stage` capped at `max-width: 1400px`
  with `justify-content: center` on the parent — wide monitors
  no longer stretch the cast ridiculously thin.
- Sprunki bodies stay fixed at 170 × 310 px so they read
  consistently regardless of viewport.

### Dragging-class wiring (was punch #6)

- The CSS rule `.sprunki.dragging { z-index: 100 }` existed but
  no template ever added the class. Now `_renderSprunki` sets
  `isDragging = (this._dragSlotId === slot.id)` and adds the
  class. Confirmed via probe — `classes: "sprunki   dragging  "`
  and `zIndex: 100` mid-drag.

### Chord-pill harden (was punch #7)

- Could **not reproduce** the original "pills don't cycle" bug —
  probe (both `.click()` and real `page.mouse.click`) shows the
  store updates as expected. As a robustness pass converted
  `<div>` → `<button type="button">` for proper focus / keyboard
  / touch behaviour, and added a right-click handler that mirrors
  Shift-click (step back). If the bug re-appears, the suspect is
  whatever was overlapping the pill at click time — not the
  handler itself.

### Emoji strip

- [patches.js](../web/ui-sprunki/patches.js): `emoji` field
  removed from all 21 patches; JSDoc typedef updated.
- Three fallback consumers — [patch-palette.js](../web/ui-sprunki/components/patch-palette.js),
  [sprunki-stage.js](../web/ui-sprunki/components/sprunki-stage.js),
  [sprunki-interior.js](../web/ui-sprunki/components/sprunki-interior.js)
  — render a `.tile-chip` / `.sprunki-chip` (colored circle with
  the patch label's first letter) instead of a pictograph.
- [app.js](../web/ui-sprunki/app.js): header literal "🎵 Sprunki
  Beats" → "Sprunki Beats"; toolbar 🧹 / ⚙ → "Clear" / "Settings"
  text buttons (new `.sprunki-text-btn` style in styles.js);
  boot-screen 🔌 / 🎛 / ⚠ prefixes stripped.
- [transport-bar.js](../web/ui-sprunki/components/transport-bar.js):
  🔁 → "Loop". Geometric arrows ▶ ⏹ ⏮ ▲ ▼ left in place as
  conventional transport icons; flag if they read as emoji on
  Rich's display.
- [parental-gate-modal.js](../web/ui-sprunki/components/parental-gate-modal.js):
  👋 stripped.

Confirmed via probe: no pictograph-range codepoints anywhere
in the rendered shadow trees.

---

## Audio engine pain — `set_sequencer_layout` hammering 🔥

Rich flagged that Ardour was "crashing after a little usage" this
session. Pulling `~/.local/state/foyer/daw.log` showed:

- **10,314 `DummyMidiBuffer: it's too late for this event N > M`
  warnings** — events scheduled past the current MIDI buffer end.
- 42 `Stacktrace Thread: UI:FoyerShim` blocks — these are
  intentional `PBD::stacktrace(...)` diagnostic logs from the
  shim's `SignalBridge::on_transport_state_changed()`, not actual
  crashes. Worth noting how chatty the trace is though.
- **No SIGSEGV / SIGABRT / hard-crash markers in the log.** The
  engine wasn't crashing in the usual sense; the "crashing" feel
  came from these MIDI buffer overruns causing dropouts /
  glitches.

**Root cause identified this session:** `_onBoardChanged` in
[app.js](../web/ui-sprunki/app.js) re-pushed the *full* 64-step
SequencerLayout for the slot on every single cell toggle. The
new click-drag paint amplifies this — a 16-cell drag stroke fires
16 board-changed events in < 200 ms. Each `set_sequencer_layout`
makes the shim wipe + rebuild the region's MIDI; any events
prefetched into the audio buffer become stale and trigger the
"too late" warnings.

**Fix landed this session:**
[app.js `_scheduleLayoutPush`](../web/ui-sprunki/app.js) coalesces
all board / harmony changes within a 120 ms window into a single
push. 16 paint cells → 1 push instead of 16. The kid doesn't hear
the new state until the next loop pass anyway, so 120 ms is
imperceptible. Same coalescing applies to `_onHarmonyChanged`
(chord-pill cycling).

**Still potentially problematic (next session):**

- **`set_sequencer_layout` is not atomic against the audio
  thread.** Even with debouncing, *one* layout swap during
  playback can still leave a small batch of stale MIDI events in
  the prefetched buffer → a handful of "too late" warnings per
  edit. Real fix is shim-side: when the region's MIDI is rebuilt
  on a layout swap, the shim should flush the affected portion of
  the audio buffer too. C++ work in
  `shims/ardour/src/sequencer_expander.cc` (or wherever
  set_sequencer_layout lands the MIDI).
- The 42 `PBD::stacktrace` blocks per session are noise. If
  someone is reading the daw.log for an actual crash, these
  bury the signal. Either gate the stacktrace behind a debug
  build flag or rate-limit it.

## Hard crash — SIGABRT on AvlDrums instrument add 🔥🔥

Rich also hit a hard Ardour crash this session (SIGABRT, 964 MB
core dump in `core` at the repo root). Crash stack:

```
SIGABRT
abort()
CairoWidget::set_dirty()                     ← libgtkmm2ext
ArdourWidgets::ArdourDropdown::ArdourDropdown
PluginSetupDialog::PluginSetupDialog
Editor::plugin_setup                          ← fires on PluginSetup signal
Route::add_processors
Route::add_processor
lambda in shims/ardour/src/dispatch.cc:5215   ← our add-plugin path
AbstractUI<FoyerShimUIRequest>::handle_ui_requests
```

**Root cause:** `Route::add_processors` (in
`ext/ardour/libs/ardour/route.cc:1140`) fires the global
`PluginSetup` signal when a new instrument is added and either
(a) an existing instrument could be replaced, or (b) the plugin
has multi-output presets. The mask is gated by
`Config->ask_replace_instrument` and `Config->ask_setup_instrument`,
**both default `true`** in
`ext/ardour/libs/ardour/ardour/rc_configuration_vars.inc.h:258-259`.

The Editor connects its `plugin_setup` slot to that signal — and
that slot creates a `PluginSetupDialog`, which constructs an
`ArdourDropdown`, which calls `CairoWidget::set_dirty()`. The
signal is emitted on **our shim's FoyerShim UI thread**, not the
Ardour GTK thread. GTK widget construction off-thread fails the
internal "is this the GTK thread?" check and aborts.

In normal Ardour use the GUI thread is the one adding plugins so
the signal fires on the right thread. The shim breaks that
assumption.

**Fix landed this session:** `shims/ardour/src/surface.cc`
`FoyerShim::set_active(true)` now sets:

```cpp
ARDOUR::Config->set_ask_replace_instrument (false);
ARDOUR::Config->set_ask_setup_instrument (false);
```

…in-memory at shim attach. With both flags off, the mask filters
the `PluginSetup` flags down to `None`, the signal is never
fired, the editor's dialog handler never runs, no crash. The
Config object isn't auto-persisted (only saved via explicit
`save_state()`), so the user's saved RC prefs aren't touched —
standalone Ardour without Foyer restores the original prompts.

**To pick up the fix:** rebuild + reinstall the shim, then
restart Ardour. The repo's helper does both:

```bash
just ./scripts/dev/shim.sh install   # rebuilds + copies to ~/.config/ardour9/surfaces
# then kill + relaunch ardour
```

(Done this session — `libfoyer_shim.so` at `~/.config/ardour9/surfaces/`
is dated 2026-05-25 16:46 with the fix.)

## Still open 🛠

### Backdrop polish (was punch #8) — partial

The stage-width cap removes the worst case. The deeper concern in
the prior handoff — that the OG `backdropcute` SVG might show
empty side bands on tall/narrow viewports because of bottom-
anchored `object-fit: cover` — is **not actually verified one way
or the other**, because the dev probe doesn't load the OG asset
pack without a real Ardour boot. The base gradient is still
`#67c0ed → #87ceeb → #6bbf6b → #4ea854` at 0/50/50/100%; if the
SVG's bottom edge color drifts from `#4ea854` you'll see a seam.

Once verified visually, two options:
- **(a)** duplicate-mirror the SVG horizontally to extend the scene.
- **(b)** tune the gradient grass color to match the SVG's bottom
  edge more precisely (cheaper).

### Rename (still pending — Rich skipped this session)

See top of doc.

---

## How to run

```bash
# 1. cleanup
just kill-daws        # WARN: this kills Rich's Ardour too if he has one running
rm -rf /workspaces/sprunki-claude-scratch /tmp/foyer/ardour-*.{sock,json}

# 2. boot foyer (port 3839 to avoid clashing with Rich's 3838)
DISPLAY=:99 \
  FOYER_ARDOUR_DEV_TREE=/workspaces/foyer-studio/ext/ardour \
  FOYER_ARDOUR_SHIM_DIR=/workspaces/foyer-studio/ext/ardour/build/libs/surfaces/foyer_shim \
  XDG_STATE_HOME=/tmp/foyer-test/state \
  XDG_DATA_HOME=/tmp/foyer-test/data \
  /workspaces/foyer-studio/target/debug/foyer serve \
    --listen 127.0.0.1:3839 \
    --web-root /workspaces/foyer-studio/web \
    --backend ardour \
    --ardour-path /workspaces/foyer-studio/ext/ardour/build/gtk2_ardour/ardour-9.5.0 \
    >/tmp/foyer-claude.log 2>&1 &

# 3. (optional) boot the verifier probe (full ANIM/METER/TRANS event capture)
bun /tmp/foyer-test/sprunki-ardour-log-probe.js > /tmp/foyer-test/log-probe.out 2>&1 &

# 4. visit http://127.0.0.1:3839/?ui=sprunki in a browser to drive it manually
```

### Fast UI-only iteration (no Ardour)

The stub backend boots fast but can't service `launch_project`
the sprunki app requires. For UI-only verification (DOM/CSS/
gesture changes, no audio reactivity) the probe pattern in
`/tmp/sprunki-test.js` is:

```js
await page.evaluate(() => {
  const app = document.querySelector("sprunki-app");
  app._store.removeEventListener("stage-changed", app._onStageChanged);
  app._store.removeEventListener("board-changed", app._onBoardChanged);
  app._store.removeEventListener("tracks-invalidated", app._onTracksInvalidated);
  app._onTracksInvalidated = () => {};
  app._advanceToProvisioning = () => {};
  app._status = "ready";
  app.requestUpdate();
});
```

After that the stage / interior / palette render and you can
exercise patches via `app._store.assignPatch(...)`. Meter-driven
animation still requires Ardour.

**ALWAYS kill your DAWs / dev foyers before ending the session** —
Rich runs his own on :3838 and orphan instances collide.

---

## Audio reactivity — verified before, watch for these gotchas

- `meter_batch` envelopes only fire during **transport playback**.
  Without rolling transport, no meter pulses, no audio-driven dance.
- Stub backend does NOT emit `transport.playing` echoes after a
  client-side `controlSet`, so meter-driven verification needs a
  real Ardour boot.
- `transport.playing` flapping: foyer-core's store re-emits the
  `control` event for `transport.playing` on every meter tick.
  Don't assume that event fires only on state transitions — gate
  on actual value-changed-since-last-time.

---

## Recurring gotchas (sticky — carry forward)

1. **Lit `css` tagged templates**: backticks inside CSS comments
   end the template literal early. No raw backticks inside `css\`\`\``
   blocks — paraphrase.
2. **foyer-core `control` event** fires with `ev.detail` set to the
   control ID **string**, not an object. Re-read the value from
   `store.get(id)`.
3. **Always run `just fmt-check` after any Rust edit.** CI gates on
   it. (No Rust changed this session.)
4. **`just kill-daws` kills Rich's xpra/Ardour too.** Don't run it
   without checking `pgrep -af "xpra start :99"` first.
5. **Polo costume "0" vs "13":** the project.json's `currentCostume:
   13` is a saved game-state, NOT the boot visual. The mid-gray
   idle Polo is costume `"0"`.
6. **localStorage v3 migration:** older v1/v2 saved stages are
   discarded on boot.
7. **Spawn cap is now a hard limit.** `spawnSlot()` returns `null`
   past 7 — UI dispatch sites get a visual "full" pulse. If you're
   adding a code path that spawns, propagate the null return.
8. **Bar-rail state in interior is component-local.** The kid's
   active-bar selection lives on the `<sprunki-interior>` instance
   (`_activeBar`) which is re-mounted each open, so it always
   starts on bar 1. Section (Intro/Verse/etc.) switching doesn't
   reset the bar — by design; can revisit if confusing in play.
9. **Drag-back-to-palette uses cross-shadow DOM lookup.** Stage
   queries `this.getRootNode().querySelector("sprunki-patch-palette")`
   to find its sibling. If the app shell ever moves the palette
   under a different parent, that lookup breaks; emit a custom
   event instead.

---

## First three things for the next session

1. **Rename pass** — Rich opted out this session; will likely come
   up again. Touch points listed at top of doc. Plan the work as a
   single PR so the variant id / storage key / docs migrate
   together.
2. **Backdrop polish** — verify against a real Ardour boot whether
   the OG `backdropcute` SVG still shows side bands at the new
   `max-width: 1400px` stage cap. If yes, tune the gradient grass
   color or duplicate-mirror.
3. **Composite-patch editing UX** — the bar-rail covers per-voice
   step authoring but the "interior shows 4 stacked grids" feel
   may be heavy on small viewports. If kid-test reveals it, the
   natural next step is a voice-picker tab inside the interior
   (kid picks Kick / Snare / Hat / Crash → single big strip per
   voice across bars). Mentioned as an open question in the
   vision doc.

---

## Files touched this session

```
M  web/ui-sprunki/state-store.js                 (MAX_STAGE_SLOTS=7, spawn refuses)
M  web/ui-sprunki/patches.js                     (emoji field removed)
M  web/ui-sprunki/styles.js                      (stage max-width, .sprunki-text-btn)
M  web/ui-sprunki/app.js                         (emoji strip, header/toolbar literals)
M  web/ui-sprunki/components/sprunki-stage.js    (drag-back, dragging class, spawn-cap UX, chip fallback)
M  web/ui-sprunki/components/sprunki-interior.js (bar-rail, click-drag paint, chip fallback)
M  web/ui-sprunki/components/patch-palette.js    (staggered rack, drag-remove drop, chip fallback)
M  web/ui-sprunki/components/chord-strip.js      (pill <div> → <button>, contextmenu)
M  web/ui-sprunki/components/transport-bar.js    (🔁 → Loop)
M  web/ui-sprunki/components/parental-gate-modal.js (👋 strip)
M  docs/SPRUNKI_HANDOFF.md                       (this doc)
M  docs/SPRUNKI_VISION.md                        (slot-count language)
```

`git status` will show the live edits. Nothing committed yet — Rich
hasn't asked for a commit.

When this doc and the code disagree, the code is right and this
doc is wrong — update the doc to match, never the other way around.
