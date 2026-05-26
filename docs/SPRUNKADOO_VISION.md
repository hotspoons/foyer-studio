# Sprunki Beats — vision + interaction design

## Arrangement editor (planned, not yet shipped)

Captured 2026-05-25 from a live design pass with Rich. The
default Sprunkadoo UI stays as it is today — **one** 4-bar
arrangement that loops forever. The arrangement editor is a
discoverable but hidden affordance for kids who want to write
longer-form songs.

### The dial

A small unobtrusive button — call it **"Arrange…"** — lives in
Settings → Advanced (alongside the per-sprunki instrument
override). Clicking it opens a same-style modal as the
sequencer interior + settings panel: full-screen overlay,
backdrop dismiss, big red close X.

Inside the modal the kid sees a **horizontal track of
arrangement chips**, one chip per arrangement. Each chip is a
colored square (no name — the color IS the identity). The
chip-strip is the "song" — chips play in left-to-right order,
each chip = one 4-bar block of the current 7-slot stage's
sequencer authorings.

Affordances:
- **Add chip** (+ at the right end): spawns a new arrangement
  with a fresh color.
- **Reorder**: drag a chip horizontally.
- **Delete**: red X on hover (matches the per-sprunki
  send-home gesture for visual consistency).
- **Recolor**: tap a chip → tiny color palette pops; pick a new
  swatch.
- **Picker**: outside the modal, a small color-dot strip lives
  at the top edge of the stage (same row as the toolbar). Each
  dot = one arrangement chip. Tap a dot to switch the active
  arrangement — the kid edits THAT arrangement's beats /
  costume placements in the stage. Loop range stays 4 bars but
  cycles through the chip-strip in order during playback.

### Default-collapsed mode

When the kid has only ONE arrangement (the default), the
chip-strip on the stage is hidden entirely — no clutter. The
"Arrange…" button in Settings still exists; clicking it opens
the editor with one chip + the "+ Add" affordance.

The moment the kid creates a second arrangement, the
on-stage color-dot strip appears (animates in from the top
edge). It only goes away if they delete all but one
arrangement.

### Data model

Lives entirely client-side until it stabilizes (then we promote
it to a schema field on the wire). In `state-store.js`:

```js
{
  arrangements: [
    { id: "arr.0", color: "#a45fc9", boards: {/* per-slot, per-row step arrays */} },
    { id: "arr.1", color: "#ff9933", boards: {/* … */} },
    …
  ],
  activeArrangementId: "arr.0",
}
```

The current `slot.boards` field becomes a function of
`activeArrangementId` — when the kid switches arrangements,
the sequencer-bridge rebuilds the SequencerLayout for every
slot using the new arrangement's boards, pushes via
`pushAllLayouts`.

Playback order: arrangements play left-to-right (= insertion
order) and loop back to the first one after the last one
finishes. **No section labels, no naming, no per-arrangement
length** in v1 — every arrangement is 4 bars. A "set this
arrangement to 8 bars" knob is a future iteration.

### Backend wiring (v1)

The simplest correct model: switch arrangements = re-push every
slot's SequencerLayout with the new authorings. The MIDI
already in the region gets replaced via the existing
`replace_region_notes` path; no schema changes needed.

For continuous looping multi-arrangement playback (without the
kid manually clicking each dot), we set the loop range to the
TOTAL number of arrangements × 4 bars and concatenate the
authoring along the region's timeline. That's more involved
(the region-length grows; SequencerLayout payload gets bigger);
v1 ships with **one arrangement audible at a time**, kid taps a
color-dot to switch.

### Why no names

Rich's call: names introduce a typing surface (no keyboard for
a 5yo on a phone) and an "is it intro? is it chorus?" mental
load. Colors are zero-typing, zero-vocabulary, and the kid
already associates colors with characters / genres / FX so
they extend the existing language naturally.

### What's NOT in v1

- Multi-arrangement continuous playback (one chip plays at a
  time; manual switch via the color-dot strip)
- Per-arrangement length (everything is 4 bars)
- Genre-per-arrangement (current dial is global)
- Cross-arrangement copy/paste (kid duplicates by creating a
  new chip + re-tapping the same step pattern; cheap because
  default beats are seeded from the patch)
- Wire-format arrangement schema (lives in localStorage only)

Open: should the color-dot strip on stage also serve as a
"song progress" indicator during multi-arrangement playback?
Probably yes once v2 lands continuous concat; the current
chip's dot pulses on every beat. Adding that mid-design is
cheap.

---



Captured 2026-05-25. Rich is the design lead; this doc preserves
the agreed direction across context compactions. When something
here is contradicted by reality in the code, the code wins for
now and this doc gets updated next pass.

The variant lives under `web/ui-sprunki/`. The OG game we're
reinterpreting is Sprunki Phase 1 (the archive.org build we ship
as an optional asset pack); the screenshots in the original
brainstorming sessions are the visual reference.

## The core flip

We are NOT building "OG Sprunki, but with a DAW under it." We are
building **a kid's-first DAW where every UI surface is mediated
by a character**. Sprunki Phase 1 is the closest visual reference
point because (a) the brand is familiar to the target user and
(b) "stage full of characters, palette of costume tiles, kid
drags tiles onto characters" turns out to be the most intuitive
DAW-arrangement metaphor anyone has shipped to kids. The rest of
the design is ours.

> The sprunkis aren't just buttons — they're the UI for
> everything. No mixer panel: drag two sprunkis closer together =
> they pan toward each other. No transport bar: a conductor
> sprunki waves a baton. No project picker: a backstage door
> opens a list of past songs. Every DAW UI thing we have hides
> behind a character interaction.

## The mental model (band metaphor)

- A **sprunki** is a *performer*: a character with a costume, a
  face, an animation rig, a personality. The sprunki itself
  doesn't know how to play anything.
- A **patch** is *what they're performing*: 1+ MIDI tracks with
  the right instruments + a default loop. Patches are pure data.
- The **stage** is the band: anyone you put on stage is in the
  song right now. Anyone off stage is silent (their loops
  preserved for later).
- The **palette** below the stage is the costume rack from OG
  sprunki, except each "costume" is a patch. Drag a tile onto a
  performer → they perform that patch.

Swap a performer's costume, the patch keeps playing. Swap their
patch, the performer keeps their costume + their dance moves.
Move the performer across the stage, both their patch and
costume follow. Position on stage maps to mix (left-right = pan,
front-back = level, two sprunkis pinched together = sidechain or
harmonic lock).

## Data model

```
Patch {
  id:                string             // "kick", "synth-bass", "drum-kit"
  label:             string             // "Kick", "Synth Bass", "Drum Kit"
  decoration_icon:   string             // SVG / emoji for the palette tile
  color:             string             // accent color
  mode:              "drum" | "pitched"
  tracks: [
    {
      internal_id:       string         // unique within patch
      instrument_uri:    string         // LV2 URI; fallback chain runs if it misses
      gm_program:        u8             // 0..127
      gm_channel:        u8             // 0..15
      label:             string         // "Kick", "Hat", "Crash" inside a Drum Kit
    }
  ]
  default_loop:        // 1 bar at 16 steps, per-track. Drum patches
    {                  // emit cells; pitched patches emit free_notes
      [internal_id]: [{ scale_degree?, chord_tone?, octave_offset?, step, velocity? }]
    }
}

Costume {
  id:                  string           // "default-1", "demon", "phantom"
  name:                string           // "Boomer", "Demonic", "Phantom"
  art:                 {                // SVG paths under the asset pack
    idle: string[],
    play: string[],
    alternate: string[]                 // "evil" variant for drops / phase-2
  }
  color:               string
  anim_profile:        "chill" | "bouncy" | "wild" | "phantom"
}

Stage {
  slots: [
    {
      x: number, y: number              // 0..1 normalized stage coords; free-form
      costume_id: string
      patch_id: string | null           // null = empty performer; visible but silent
      muted: boolean                    // optional manual mute
    },
    …
  ],
  default_slot_count: 7                 // shown empty on first boot
}
```

Tracks live under the slot, not under the patch. A patch
*assignment* loads the patch's instrument(s) onto the slot's
existing track(s); swapping a patch reuses the same track. This
avoids the create_track storm we saw in early iterations and keeps
Ardour's session shape stable.

## The interaction patterns

### Stage as a 2D performance space

- The stage is a freely-positioned 2D area, not a row of fixed
  slots. Every sprunki has `(x, y)` coords.
- Drag a sprunki anywhere on stage. Position persists.
- Position semantics (mapping to mix params):
  - **X axis → pan** (left half = pan L, right half = pan R, center = mono).
  - **Y axis → level** (front / lower = louder, back / higher = quieter).
  - **Distance to another sprunki** is reserved for sidechain
    pairing in a later phase.
- 7 sprunkis is the **hard cap** on the cast (was: "guideline,
  not a cap"). Past ~7 the bodies pile on top of each other on
  most viewports and the metaphor of a discrete band falls apart.
  Enforced at the store boundary (`MAX_STAGE_SLOTS` in
  `state-store.js`); UI dispatch sites flash a red border when a
  drop on bare stage is rejected at the cap. The kid still has
  full freedom to drag sprunkis off-stage via the palette drop
  zone, so the 7-count is a working set, not a permanent roster.

### Patch palette + drag-to-assign

- A horizontally-scrolling rack at the bottom of the screen
  shows every available patch. Each tile = one patch.
- Drag a tile onto a sprunki → that sprunki now performs that
  patch. The sprunki keeps its costume.
- Drop a tile on empty stage → spawn a new sprunki at that spot
  carrying that patch, using a default costume.
- The same patch tile can be on multiple sprunkis (layering — a
  second snare-tile-on-stage doubles the snare).

### Click → zoom-in interior view

- Click an occupied sprunki → animate them growing to fill the
  screen.
- The sprunki **becomes a faded / semi-transparent background**
  behind their patch editor. Sprunki stays present + alive
  during edit, not gone. Their idle animation keeps playing
  behind the grid.
- The editor surface is the patch's grid(s) — one per track for
  composite patches.
- ESC or click outside → animate back down to the stage.
- The grid editor that exists today is what gets shown here, but
  scoped to ONE patch's tracks (not "every category at once").

### Section evolution (Phase 2B)

- Per-sprunki `section_availability: { intro, verse, chorus, drop }`.
- Transport crossing a section boundary triggers walk-on / walk-off
  animations. Off-stage sprunkis are skipped during layout build.
- Replaces the current pattern-tab UI; a thin horizontal "score"
  strip at the top of the stage shows who's on each bar, with a
  play-head sweeping through.

### Sprunkis swallow the rest of the UI (Phase 2C)

- **Conductor Sprunki** = transport bar. Click baton = play/stop.
  Hat tilt or staff height = tempo.
- **Maestro Sprunki** = the agent (Foyer's Claude integration).
  Drops onto the stage; click to type prompts; he edits patches.
- **Mic Boi** = audio ingress sprunki. Hold the mic to record into
  a loop slot.
- **Performer Sprunki** = Web MIDI ingress with auto-snap to key +
  grid (the "no wrong notes" idea). Tuner-style overlay shows
  played → snapped → Δ.
- **Backstage Door** at stage-right opens the "my songs" gallery.

## Phase plan

### Phase 2A — Patches, decoupled (the rebuild)

Status: **proposed, not started.** Builds on the Phase 1 chord
strip + the existing 7-slot stage component.

1. `web/ui-sprunki/patches.js` — the library: ~10 atomic patches
   (Kick, Snare, Hat, Clap, Crash, Synth Bass, Pluck Bass, Pad,
   Square Lead, Riser). Composites come later as a Patch with
   `tracks: [...]` of length > 1.
2. `web/ui-sprunki/costumes.js` — the costume library, decoupled
   from patches entirely. OG sprunki art slots in here when the
   asset pack is downloaded.
3. `web/ui-sprunki/state-store.js` — replace the named-character
   `boards` model with `stage: [{ x, y, costume_id, patch_id, muted }]`.
   Provide migration from the old format so existing kids' work
   doesn't get nuked.
4. `web/ui-sprunki/components/sprunki-stage.js` — switch to free-
   form 2D positioning. Drag-to-move. Default starting positions
   spread across the stage as a row.
5. `web/ui-sprunki/components/patch-palette.js` — new component:
   bottom-of-screen scrolling rack of patch tiles. Drag → drop on
   sprunki.
6. `web/ui-sprunki/components/sprunki-interior.js` — new component:
   the zoom-in editor view with the sprunki as a faded background
   layer behind the patch's grid.
7. `web/ui-sprunki/setup.js` — provision 7 (configurable) generic
   MIDI tracks named "Sprunki Slot N". Patch assignment ⇒ load the
   patch's instrument(s) onto the slot's track(s). Add an
   instrument-verification pass: if a slot's track has no plugin
   matching its patch, run the URI fallback chain to repair.
8. `web/ui-sprunki/sequencer-bridge.js` — `buildSlotLayout(slot,
   harmony)`. Reads the slot's patch + the slot's authored notes.
   Replaces the current category-scoped layout builder.

Phase 2A success criteria:
- Drag a kick tile onto a sprunki, hear kicks.
- Drag the same sprunki across stage, it stays kicks.
- Drag a snare tile on top of an existing kick sprunki, it swaps to
  snare without spawning a duplicate sprunki.
- Click a sprunki, the editor appears with that sprunki faded
  behind the grid.

### Phase 2B — Sections become entrances

- Per-slot `availability: { intro, verse, chorus, drop }`, default
  all-true.
- Walk-on / walk-off animations across section transitions.
- Pattern-tab UI removed; section timeline strip added.

### Phase 2C — Sprunkis swallow the rest

Conductor, Maestro, Mic Boi, Performer, Backstage Door, Genre Dial.
Each one is independently shippable.

## Open questions

- **How does layering work visually?** If two snare-patch tiles are
  on two different sprunkis, they're two voices playing the same
  pitch. Is the "same patch on multiple sprunkis" affordance
  encouraged (= unison thickening) or discouraged (= we want kids
  to pick variety)?
- **Costume randomization on tile-drop.** When a tile is dropped on
  empty stage, which costume does the new sprunki wear? Random
  pick from the costume library, vs always the "default" costume,
  vs determined-by-patch (the kick patch always spawns Boomer)?
- **Bring-your-own-patch.** Long term: drag a `.wav` from your
  desktop onto an empty sprunki → new patch built from that sample.
  Foyer's existing media-ingress path supports this; not in scope
  for 2A but worth keeping in mind.
- **Composite-patch editing UX.** A drum-kit patch holds 4 tracks.
  When the kid clicks into the sprunki interior, do they see 4
  stacked grids? A track-picker tab? A unified grid with row =
  drum? Likely tabbed-grids, but TBD.
- **2D position fallback for keyboard / touch.** Drag-and-drop is
  the primary affordance. Touch should work natively; keyboard nav
  needs an explicit fallback (arrow keys to move selected sprunki?).
- **Stage zoom level + sprunki size.** As we add more sprunkis,
  do they shrink? Stay fixed and let the kid scroll the stage?
  Probably auto-shrink with a min size, then scroll past that.

## Bug + polish backlog noticed during the design pass

These belong with Phase 2A — clean them up while we're rebuilding
the surface anyway. The current variant is partly broken because
of pre-rebuild state.

1. **Audio regression on bass / chords / lead / fx tracks.** Most
   likely the live session has those tracks with `instrument_uri`
   that landed before we fixed the canonical LV2 URI (the bare
   string `"gmsynth"` failed silently; we since switched to
   `http://gareus.org/oss/lv2/gmsynth`). Add a verification step in
   setup.js: if a slot's track has zero plugins, run the URI
   fallback chain to repair. Cheap.
2. **Sprunkis don't visibly react to audio.** The CSS `--meter`
   var is wired but only on `data-cat="<category>"` selectors. When
   the slot-based rewrite lands, the per-slot meter routing needs
   to come with it (slot ↔ slot's track ↔ track's meter id).
3. **Idle behavior is too still.** Add a slow CSS-only blink + sway
   so sprunkis feel alive even with no audio. Should be hidden behind
   a `prefers-reduced-motion: reduce` query for accessibility.
4. **Asset-pack base probe 404 noise.** Probe order swapped so the
   working path (`/asset-packs/sprunki/assets/`) is tried first; the
   wrapped layout stays as a fallback. Long term: server publishes
   the extracted subpath in `AssetPackInfo` and we skip the probe.
5. **Stage default state.** Today we seed 3 sprunkis (kick / snare /
   hat) at boot — but with patches decoupled, these become "3 sprunkis
   wearing default costumes with kick / snare / hat patches assigned."
   Keep the same audible default; just decompose the seed.

## Decisions already locked in

- **Composites from day one.** A patch can hold 1+ sequencer rows on
  the same backend track + instrument. Atomic = 1 row; Drum Kit = 4
  rows on one avldrums instance; Warm Pad = 3 chord-tone rows on one
  gmsynth pad voice. The composite-ness lives at the *row* level, not
  the track level — keeps the slot ↔ track mapping 1:1 and keeps the
  sequencer-layout shape we already ship.
- **Costume coupled to patch.** A "Drum Kit" tile arrives with its
  own face, its own dance style, its own idle/play art. Swapping
  costumes independently is *not* a feature; the patch IS the
  character. The exception is the future kid-performer sprunki class
  (mic / MIDI-ingress), which has live audio + a fixed special look
  that overrides whatever patch it's holding.
- **Patches as schema-driven data**, not hardcoded characters.
- **Patch palette = two-row scrolling rack at the bottom**, OG-style.
- **Free-form sprunki positioning** with `(x, y)` coords on the stage
  area. No snap-to-grid. Drag anywhere, before or after a patch is
  assigned. X = pan, Y = level — but the *gestural* freedom is the
  point; mix-mapping is a side effect.
- **Click → zoom-in** with the sprunki rendered as a faded /
  semi-transparent background behind the patch editor (sprunki stays
  present + animated during edit).
- **One slot ↔ one backend track.** Slot owns its track's lifecycle.
  Patch assignment swaps the instrument + loads the patch's default
  rows. Switching patch on an occupied slot reuses the track.
- **Section availability per sprunki** rather than per-pattern boards.
  Pattern tabs are going away in Phase 2B.

**The design bar:** Rich's 5-year-old's eyes light up when he sits
down at the music computer. Every interaction we add gets measured
against that. If it makes the kid hesitate, it's wrong. If it makes
the kid grin, ship it.

## Bigger ideas captured for upcoming phases

### Per-sprunki S / M / × (solo / mute / delete)

OG sprunki has these three buttons on every on-stage character.
We get S + M for free — every backend MIDI track already has
`<track-id>.mute` and `<track-id>.solo` controls; we just bind a
button to `ws.controlSet`. Delete = remove the slot entirely
from the stage (distinct from "clear patch" which keeps the
performer in place with no instrument).

UX placement: a thin three-button ribbon that fades in when the
kid hovers a sprunki (or always-on for touch). Solo + mute are
visual too — a soloed sprunki gets a spotlight halo; muted ones
go grey + still.

### 20-channel homage with drum layering

OG has ~20 channels. Half of them are drum-related and they
*layer* — drop the "Robot" (full Drum Kit composite) on stage
and the kit drives the groove; then drop individual Kick / Snare
/ Hat / Maracas / Cowbell tiles on top to thicken or vary the
groove with stronger sample variants. Two drum kits in play at
the same time (one full-kit "robot," one piecewise) is the OG
secret to a fat-sounding beat.

For us:
* Expand `patches.js` to ~20 patches matched to OG character
  archetypes (5 drums atomic + 1 full kit + 1 alt kit + bass +
  6 melody variants + 4 vocals + 2 fx + 1 phantom).
* Atomic drum patches use a *heavier* avldrums kit (RedZeppelin
  is louder than BlackPearl) — they're meant to be accent / fill
  voices layered on top of the main kit, so they should *hit*.
* The main Drum Kit composite stays on BlackPearl (the groove
  driver) — softer + tighter, the foundation for the layered
  accents.
* Composite editing still allows the kid to author / customize
  the kit's loop voice-by-voice (kick / snare / hat / crash) —
  the per-row interior editor already does this.

### Auto-captured loops as the arrangement palette

The Intro / Verse / Chorus / Drop pattern-tabs are doing the
*wrong job*. A kid doesn't think in formal song-structure terms
— they think "play that thing I just made, then the other
thing I just made." The verse/chorus/drop UI is forcing a music-
theory hat onto a fundamentally improv-driven activity.

Replacement: **auto-capture loops** as the kid plays. Every time
the active loop plays through end-to-end *with no authoring
changes mid-bar* (≥ one stable bar), snapshot it. Maintain a
rolling palette of the last 10–20 stable snapshots.

Each snapshot is a tile (like the patch palette, but on a
different rack: a "moments" rack). Drag a snapshot onto an
arrangement timeline to drop it as a clip. The kid composes a
2-minute song by dragging four snapshots in a row, no formal
sections required.

DAW under the hood does most of the work:
* Snapshot = clone of every slot's current per-section board +
  the live chord context.
* Drag-to-arrange = `create_region` on the arrangement timeline
  + `replace_region_notes` from the snapshot's expanded MIDI.
* Playback = the existing transport sweeping the arrangement.

This + the patch palette + the per-sprunki interior = three
distinct racks the kid can drag from, each capturing a
different layer of composition (instrument / loop / song).

### Style / genre dial (re-stated)

After the above lands, a single rotary at the top of the stage
flips every instrument's patch (e.g. "Synthwave" → all gmsynth
programs swap to 80s analog presets; "Lofi" → tape-saturated
drums + Rhodes pad), the chord progression's mood (major ↔
minor / dorian ↔ mixolydian), the background art, and the
dance-anim profile. Same authored song, completely different
vibe. The kid hands their composition to a "DJ Sprunki" who
spins it.

When this doc and the code disagree, the code is right and this doc
is wrong — update the doc to match, never the other way around.
