# Sprunki Beats — session handoff (2026-05-25, overnight pass)

Rich left the previous session running with a heavy backlog from
the handoff + vision docs. This update captures everything that
landed overnight so the next session doesn't redo it.

**TL;DR shipped overnight:**

- Sprunkis bumped to 170×310 px and aspect-matched to the OG
  SVGs. Default x-spread tightened to 0.12..0.88 so edge slots
  no longer clip off-stage.
- Visual clip rewritten in pixel terms — container hangs 100 px
  past the stage bottom (via `translateY`), so the lower-body
  hide-in-grass effect stays consistent across stage heights.
  Scale anchor follows in element coords (`calc(100% - 100px)`).
- New headline patch `drum-kit` — composite kick / snare / hat /
  crash on a single BlackPearl track, styled after Fun Bot.
  Designed for layering with the atomic RedZeppelin drums.
- Audio-reactivity cycler bug fixed — the `control` event's
  `detail` is the id string, not `{id,value}`. Subscription now
  re-reads the value from the store on each notification.
  Verified via a probe that calls `_applyTransportPlaying(true)`
  directly: anim SVGs advance frame-by-frame on every tick.
- Empty stage on boot (7 plain-gray Polo silhouettes — OG accurate)
  using the canonical `Polo` costume "0" from project.json.
- Stage backdrop swapped to OG `backdropcute` (sky / clouds / hills).
- S / M / × ribbon now uses the OG `Mute Buttons` SVG icons
  (headphones / speaker / X), not glyphs.
- 20-tile palette using the OG `Icons` chibi heads (variant `a`
  for normal, `c` for "already on stage" dim). Patches.js rewritten
  1:1 against the 20 OG characters.
- Audio reactivity: play-frame cycler ties to `transport.playing`
  so sprunkis dance their actual `anim` cycle while audio plays;
  meter pulse drives scale + brightness + glow per slot; transient
  spikes fire a discrete bounce keyframe.
- Scale anchor moved to `center 60%` so shrinking a sprunki no
  longer hides the head — the visible bottom (grass-line) stays
  planted.
- Pattern length quadrupled — each pattern is now 4 bars / 64
  steps; arrangement is 16 bars total. The interior editor's
  step grid wraps to 4 visual rows of 16 cells.
- Manifest re-extracted with proper bucketing (`idle` safe /
  `idle_alternate` scary / `play` / `alternate`) plus icon md5s,
  via [scripts/dev/build-sprunki-manifest.py](../scripts/dev/build-sprunki-manifest.py).

Open work that still wants Rich's eyes:

- Visual verification against a real Ardour boot. Tonight's
  screenshot ran against the stub backend with status forced to
  `ready`; the meter-pulse + play-frame cycler only kick in once
  real `meter_batch` envelopes are flowing.
- Sprunki size on stage feels small against the OG backdrop —
  could bump `SPRUNKI_W_PX` / `SPRUNKI_H_PX` if it reads as too
  thin once Rich sees it on a normal-sized window.
- "Defer arrangements" — once the auto-captured-loops palette
  lands (Phase 2B), drop the Intro / Verse / Chorus / Drop tabs
  in favour of a single 8-bar loop + a "moments" rack.
- Project rename. Default suggestion still **Bandlings**.

**Read this first, then [docs/SPRUNKI_VISION.md](SPRUNKI_VISION.md)
for the full design + decision log.**

The project name is going to change ("Sprunki Beats" collides
with the OG game and many clones) — Rich was about to pick from
a short list but never confirmed. Default to leaving the current
name until he picks; candidates included: **Bandlings** (lead
suggestion), Stagelings, Beatlings, BopBuddies, Foyer Jam.

---

## Where the variant code lives

```
web/ui-sprunki/
├── app.js                      # top-level shell, boot flow, event wiring
├── state-store.js              # SprunkiStore — v2 slot-based stage
├── patches.js                  # the patch library (12 patches today, growing to 20)
├── sequencer-bridge.js         # buildSlotLayout() + push helpers
├── setup.js                    # ensureSprunkiStage() — provisions 7 slot tracks
├── sprunki-assets.js           # OG art bridge (idle/play frame URLs)
├── sprunki-assets.json         # reverse-engineered OG character manifest
├── theory.js                   # keys, chords, scale degrees, resolveNote()
├── styles.js                   # shared app-level Lit styles
├── package.js                  # variant manifest + registerUiVariant()
└── components/
    ├── sprunki-stage.js        # the 2D free-form stage (drag, blink, S/M/×, meter pulse)
    ├── patch-palette.js        # bottom rack of patch tiles, dragsource
    ├── sprunki-interior.js     # zoom-in editor (sprunki as faded BG)
    ├── chord-strip.js          # key + 4-chord-progression UI
    ├── transport-bar.js        # play / stop / loop
    ├── preferences-modal.js    # slimmed (scary mode + reset)
    ├── asset-pack-modal.js     # consent flow for OG sprunki art download
    ├── parental-gate-modal.js  # math-quiz gate for scary content
    └── sound-catalog.js        # ONLY DEFAULT_PATTERNS + GM_PRESETS now
                                # (the old characters / categories model is GONE)
```

**Backend touch points** the variant uses:
- `create_track { name: "Sprunki Slot N", kind: "midi" }` — provisions slot tracks
- `add_plugin { track_id, plugin_uri }` — lands the patch's instrument
- `set_track_midi_patch { track_id, channel, bank, program }` — GM program
- `create_region { track_id, name: "Sprunki", ... }` — per-slot region
- `set_sequencer_layout { region_id, layout }` — the authored loop
- `control_set("track.X.gain"|".mute"|".solo", value)` — Y-axis → gain + S/M ribbon

Backend code that matters:
- `crates/foyer-server/src/asset_packs.rs` — sprunki SVG download whitelist
- `crates/foyer-schema/src/midi.rs` — `SequencerLayout` shape + `expand_sequencer_layout`
- `shims/ardour/src/dispatch.cc` + `schema_map.cc` — actual region+track manipulation
- `crates/foyer-cli/src/runtime/ardour.rs` — Ardour spawn/bootstrap pipeline

---

## OG asset wiring (new — added overnight)

The variant now uses these OG SVGs directly out of the asset
pack instead of synthesising look-alikes:

- **Empty slot body** → Polo costume "0"
  `65c6f48ea19105ebd99a6b53e24842f3.svg`. Gray-only torso (`#808080`)
  with no accessories. Surfaced via `emptySprunkiUrl()` in
  [sprunki-assets.js](../web/ui-sprunki/sprunki-assets.js).
- **Stage backdrop** → Stage "backdropcute"
  `1c282eae03a608f17b842c01ceacf74e.svg` (680×321). Surfaced via
  `backdropUrl()`, rendered as a positioned `<img>` underneath
  the stage surface.
- **S / M / × icons** → "Mute Buttons" costumes Solo / Mute /
  Remove. Surfaced via `muteButtonUrl(kind)`.
- **Palette tile art** → "Icons" 01-a through 20-a (variants
  a / b / c for normal / pressed / dimmed). Indices 1:1 with the
  20 OG character order (verified by colour spot-check —
  01-a uses `#ff6f00` = Oren orange, 02-a uses `#b30000` = Raddy
  red, etc.). Surfaced via `iconUrlFor(sprunki_id, variant)`.

The manifest extractor at
[scripts/dev/build-sprunki-manifest.py](../scripts/dev/build-sprunki-manifest.py)
bakes the icon md5s into each character entry under
`character.icon = { normal, pressed, dimmed }`. Re-run it any
time the OG project.json refreshes.

## What's working RIGHT NOW (just verified)

The variant boots cleanly against a fresh Ardour session and:
- Renders a free-form 2D stage with 7 EMPTY (gray Polo) slots by
  default. The kid drags character tiles to activate them —
  matches the OG game's boot state exactly. Activated sprunkis
  use the named OG character (Oren / Raddy / …); empty ones use
  the canonical Polo "0" gray silhouette.
- Stage backdrop is the OG `backdropcute` SVG (sky / clouds /
  hills), rendered behind the sprunkis. The legs intentionally
  clip past the stage bottom so the visible character "stands
  in" the grass strip.
- Drag sprunkis around freely. X-axis is free positioning; the
  Y-axis nudges visually a sliver but mostly drives **size +
  gain** (raised = bigger + louder, lowered = smaller + quieter).
  Scale anchors at `center 60%` so the visible chest/upper-torso
  stays planted when shrinking.
- Drag a tile from the bottom palette onto a sprunki → assigns
  that patch (swap instrument + load default 4-bar loop). Drop
  on empty stage → spawn a new sprunki carrying that patch.
- Disabled palette tiles for patches already on stage (uses the
  OG dimmed icon variant `c`).
- Click an occupied sprunki → zooms into the interior view
  (sprunki becomes a faded backdrop; the per-row step grid edits
  the loop, now 4 rows × 16 cells = 64 steps = 4 bars).
- S / M / × ribbon on each occupied sprunki using the OG
  Mute Buttons SVGs (headphones / speaker / X). Hooks into
  `${track_id}.solo` / `.mute` controls and `clear_patch` on
  remove.
- Audio reactivity: when transport plays, every occupied slot
  cycles through its OG `anim*` play frames at ~12 FPS; per-slot
  `meter_batch` envelopes drive a CSS `--meter` var that scales,
  brightens, and glows the art; a discrete bounce keyframe
  fires on transient hits.
- The chord strip retunes every tonal sprunki when the chord
  changes; section tabs (Intro / Verse / Chorus / Drop) each
  cover 4 bars of the 16-bar arrangement.
- 20 patches in `patches.js`, mapped 1:1 to the OG character
  cast. Drum atomics on RedZeppelin (heavier kit, designed for
  layering), tonal voices on gmsynth with character-appropriate
  GM programs, vocals on GM 52–54 (choir / voice / synth voice),
  phantom (Black?) gated behind scary mode.
- BPM display rounds to an int and is itself a click-and-drag
  adjuster (drag up = speed up, ~3 px per BPM).
- localStorage v3 migration: anything older (v1 or v2) gets
  discarded; v3 hydrates the new empty-stage default.
- The race that was producing duplicate Sprunki tracks every boot
  is fixed (idempotency guard on `_advanceToProvisioning` + session-id
  watchdog that only invalidates on real session change + wait-for-
  master in `ensureSprunkiStage`).

---

## What's in flight / pending

In the order Rich has the most thinking-equity in:

### 1. Visual bottom-anchor verify (RIGHT BEFORE SESSION POISONED)

I made the sprunkis significantly larger (`SPRUNKI_W_PX=150`,
`SPRUNKI_H_PX=230`), then a screenshot showed the **HEADS were
cut off** — the OG SVGs are bottom-anchored in their viewBox, so
my `object-position: top center` was clipping the wrong end.

**Fixed but not yet visually verified** (Ardour died mid-shot):
- `sprunki-stage.js` now uses `object-fit: contain` +
  `object-position: center bottom` — whole character visible.
- `state-store.js` defaults `y: 0.85` (feet on grass).
- `sprunki-stage.js` `STAGE_BASELINE_Y = 0.85` (matches).

**First thing to do in the next session:** re-run the smoke and
confirm sprunkis have HEADS + bodies visible, feet on grass.
Smoke script: `/tmp/foyer-test/phase2a-defaultshot.js`. Boot
recipe in [Justfile](../Justfile) under `template-rebuild` —
just adapt the port to 3839.

### 1b. Horror-frame leak in the idle cycler — FIXED (2026-05-25)

Rich noticed scary sprunkis flashing in between cheerful ones.
Root cause: the earlier machine-generated manifest treated the
project's `idle2` costume as a blink frame, but `idle2` is in
fact the scary-mode resting pose (Raddy's idle2 is built from
`#1a0c12` / `#4d2637` over a `#660000→#000` gradient; Oren's
is gradients of `#331600`). Cycling through it mixed horror
into the default cast.

Fix: extracted the canonical names from the OG project at
[ext/sprunki-website/assets/project.json](../ext/sprunki-website/assets/project.json)
and rebuilt the manifest. New buckets:

- `costumes.idle`           — safe resting pose
- `costumes.idle_alternate` — scary-mode resting pose (`idle2`)
- `costumes.play`           — safe play loop (`anim`, `anim2`, …)
- `costumes.alternate`      — scary-mode play loop (`anim???`, …)

Re-run [scripts/dev/build-sprunki-manifest.py](../scripts/dev/build-sprunki-manifest.py)
whenever the OG project.json is refreshed. The stage's idle
cycler stays inert while there's only one safe idle frame and
wakes up automatically once additional safe frames land in
`costumes.idle`. To get OG-style aliveness back today, the next
step is to briefly flash a `play[]` frame during idle (eye/peek
look-around) — the OG game does this in-script and the assets
are already loaded.

### 2. Audio reactivity (overnight) — needs real Ardour to confirm

Rewired tonight. Three layers stacked:

1. **Play-frame cycler.** When `transport.playing` flips true, the
   stage starts a 12 FPS interval that bumps each occupied slot's
   `_playFrameIdx`. `_currentIdleUrl` now returns the next anim
   frame from `allPlayCostumeUrlsFor(sprunki_id)` while cycling
   is on, and falls back to `idle[0]` when transport stops. This
   matches the OG behaviour reverse-engineered from project.json
   (each character target runs `costume → wait 0.04 → costume →
   …` while `"Is active?" == 1`).
2. **Meter pulse.** `app.js _absorbMeterBatch` → stage
   `updateLevels(bySlot)` → CSS `--meter` var on each
   `.sprunki-art`. The CSS multiplies into `transform: scale` and
   `filter: brightness + drop-shadow`, so a hot channel grows +
   glows in its character colour.
3. **Bounce on transients.** When `--meter` jumps by more than
   0.30 in a frame and crosses 0.40, the art's `.bounce` class
   retriggers a 280 ms hop keyframe. Picks out drum hits visually
   even when the loop's average level is moderate.

If a slot doesn't react after this, walk this list:

- `slot.track_id` populated for every occupied slot?
  (`window.__foyer.store.state.sprunkiStage` mirrors them.)
- `meter_batch` envelopes arriving? Check the WS frame log; they
  only fire during transport playback.
- `transport.playing` propagating? `_subscribeToTransport` in
  [sprunki-stage.js](../web/ui-sprunki/components/sprunki-stage.js)
  listens for `control` events.
- The `<sprunki>` element has `data-slot="${slot.id}"`?

### 3. Rich's big new ideas (captured in SPRUNKI_VISION.md, not built)

**A. 20-channel homage with drum layering.** OG has ~20 patches.
Half are drum-related and *layer* — a full-kit "Robot" patch
drives the groove, and atomic drum patches with stronger samples
sit on top to thicken / vary it. Plan:
- Expand `patches.js` to ~20 patches matched to OG character
  archetypes (5 atomic drums + 1 full Drum Kit + 1 alt kit +
  bass + 6 melody + 4 vocals + 2 fx + 1 phantom-gated).
- Atomic drums should use **avldrums RedZeppelin** (heavier kit)
  while the full Drum Kit composite stays on **BlackPearl** (tighter
  groove driver). Their layered combo is the OG secret to fat beats.
- The "kids edit their own composites" feature already works via
  the existing per-row sprunki-interior editor.

**B. Auto-captured loops → arrangement palette.** Throw out the
verse/chorus/bridge tabs entirely. Instead:
- Every time a loop plays through end-to-end without authoring
  changes, snapshot it.
- Keep a rolling palette of last 10–20 snapshots (a "moments" rack).
- Kid drags a snapshot onto an arrangement timeline → that
  snapshot becomes a clip on the timeline.
- DAW does the heavy lifting (create_region + replace_region_notes
  per snapshot, transport sweeps the arrangement).
- Three racks total: **patch palette** (instruments), **moments
  rack** (your stable loops), **arrangement timeline** (your song).

**C. Solo / Mute / Delete on every sprunki.** SHIPPED — see
"Working" list above. Each sprunki now has a hover ribbon with
S / M / × buttons; solo + mute go straight to `control_set` on
the slot's track. Visual: soloed sprunkis get a golden halo,
muted ones go grey + still.

**D. Style / genre dial.** Future. A rotary at the top of stage
that flips every instrument's patch, the chord-progression mood,
the background art, and the dance-anim profile.

**E. Kid-performer sprunki (autotuned voice + auto-quantized MIDI).**
Future. A special sprunki class — drag onto stage, hold the mic
to record, voice gets autotuned to the current key + quantized
to the grid. Same idea for MIDI input from a hardware keyboard
(snap to nearest in-key note + nearest grid step). Tuner-style
overlay shows `played → snapped (Δsemitones)` so the kid learns
the key.

### 4. Open visual polish

- BPM display now rounds to int and the readout itself is a
  click-and-drag adjuster (drag up = speed up, ~3 px / BPM). The
  ▲/▼ buttons are still there for fine touch use.
- Background is decent but could be improved further — OG sprunki
  has a much more vibrant 2D illustrated sky-and-hills look.
- The interior overlay's faded sprunki may need fine-tuning of
  scale/opacity once we see it against real OG art.

---

## How to run

```bash
# 1. wipe any stale ardour / scratch session
just kill-daws
rm -rf /workspaces/sprunki-scratch /tmp/foyer/ardour-*.{sock,json}

# 2. boot foyer (port 3839 to avoid clashing with user's 3838)
DISPLAY=:99 \
  FOYER_ARDOUR_DEV_TREE=/workspaces/foyer-studio/ext/ardour \
  XDG_STATE_HOME=/tmp/foyer-test/state \
  XDG_DATA_HOME=/tmp/foyer-test/data \
  /workspaces/foyer-studio/target/debug/foyer serve \
    --listen 127.0.0.1:3839 \
    --web-root /workspaces/foyer-studio/web \
    --backend ardour \
    --ardour-path /workspaces/foyer-studio/ext/ardour/build/gtk2_ardour/ardour-9.5.0

# 3. visit http://127.0.0.1:3839/?ui=sprunki in a browser
#    OR run the headless probe:
bun /tmp/foyer-test/phase2a-defaultshot.js
# screenshot lands at /tmp/foyer-test/phase2a-default.png
```

**Always kill DAWs before ending the session** — Rich runs his
own foyer on :3838 and orphan Ardours on :99 collide with it.

---

## Recurring bugs / gotchas

1. **Lit `css` tagged templates**: backticks inside CSS comments
   end the template literal early. Bug bit me twice this session.
   No raw backticks inside `css\`\`\`` blocks — paraphrase.
2. **Ardour route names sanitize `/` to `_`** — using `·` (middle
   dot) instead so the by-name lookup in setup.js works.
3. **Race that produced duplicate tracks** — fixed via idempotency
   guard + session-id watchdog + wait-for-master. See state-store.js
   `_installSessionWatchdog`.
4. **`session_opened` envelope fires AFTER our own initial spawn**,
   not only on cross-session swap. Watchdog tracks
   `session.id` and only invalidates on actual change.
5. **localStorage version bump (v1 → v2)** loses any saved boards.
   Acceptable for now; one-line warning if we ever ship the v1
   blob restoration upgrade.
6. **`_advanceToProvisioning` is double-called** by both
   `_afterWs` and `_onAssetSkip` in fast boots. Idempotency guard
   (`this._provisioning`) in `app.js` line ~196.
7. **Ardour process orphans** — every probe leaks an Ardour if
   killed mid-flow. `just kill-daws` is the cleanup hammer.

---

## Files touched this session (high-churn)

```
M  Justfile                                          (template-rebuild recipe)
A  docs/SPRUNKI_VISION.md                            (full design doc — read it)
A  docs/SPRUNKI_HANDOFF.md                           (this file)
A  crates/foyer-cli/templates/sprunki-beats.zip      (15K — pre-built session)
A  crates/foyer-cli/templates/README.md
A  scripts/dev/seed-template.js                      (used by `just template-rebuild`)

# Variant — substantially rewritten this session
M  web/ui-sprunki/app.js                             (boot + event wiring)
M  web/ui-sprunki/state-store.js                    (v2 slot-based stage)
A  web/ui-sprunki/patches.js                         (the new library)
A  web/ui-sprunki/theory.js                          (key/chord resolveNote)
M  web/ui-sprunki/sequencer-bridge.js                (buildSlotLayout slot-based)
M  web/ui-sprunki/setup.js                           (ensureSprunkiStage slot-based)
M  web/ui-sprunki/sprunki-assets.js                  (allIdleCostumeUrlsFor)
M  web/ui-sprunki/styles.js                          (5-row grid layout)
M  web/ui-sprunki/components/sound-catalog.js        (slimmed to constants only)
M  web/ui-sprunki/components/sprunki-stage.js        (entirely new — 2D drag + blink + S/M/×)
A  web/ui-sprunki/components/patch-palette.js
A  web/ui-sprunki/components/sprunki-interior.js
A  web/ui-sprunki/components/chord-strip.js
M  web/ui-sprunki/components/preferences-modal.js   (slimmed)
D  web/ui-sprunki/components/character-board.js     (replaced by stage + interior)

# Rust — modest changes
M  crates/foyer-cli/src/main.rs                      (split into modules)
A  crates/foyer-cli/src/{cli,serve,web_bundle,mcp_probe,runtime/{mod,ardour}}.rs
M  crates/foyer-cli/src/serve.rs                     (linter touched — see system reminder)
```

`git status` will reflect all of this. Last commit is whatever
Rich's tree was at before this session started — nothing is
committed yet from this session's work.

---

## First three things for the next session

1. **Boot Ardour + take a screenshot** to confirm tonight's full
   visual rebuild lands against real audio. Stub-backed shots
   from tonight:
   - `/tmp/foyer-test/sprunki-tonight.png` — empty default stage
     (7 gray Polos, OG backdrop, 21-tile palette).
   - `/tmp/foyer-test/sprunki-playing.png` — three sprunkis mid-
     dance with anim frames advancing (drum-kit / Oren / Vineria).
   - `/tmp/foyer-test/sprunki-interior.png` — 4-row × 16-cell
     step grid in the detail editor.
   The probes that took these (`sprunki-shot.js`,
   `sprunki-play-shot.js`, `sprunki-interior-shot.js`) live in
   `/tmp/foyer-test/`; re-run any of them against your usual
   `:3838` foyer by editing the URL.
2. **Verify audio reactivity end-to-end** — drop a drum sprunki
   on stage, press play, confirm the anim frames advance AND the
   `--meter` glow pops on transients. Tonight's probe confirmed
   the cycler logic correctly by force-firing
   `_applyTransportPlaying(true)`, but stub doesn't echo
   `transport.playing` so the full round-trip needs Ardour.
3. **Drum-layering pass** — drop both `oren-kick` (atomic) and a
   future composite `drum-kit` on stage at once and verify the
   RedZeppelin atomics sit on top of the BlackPearl groove
   correctly. Two atomic drums of the same role doubled = the
   thickening OG relies on for fat beats.

After those, the next big builds:

- **Composite drum-kit patches** (the "Robot" pattern Rich
  pointed at in the vision doc). Currently every drum patch is
  atomic; we want a "Drum Kit" composite that drops kick / snare
  / hat / crash voices on one BlackPearl track.
- **Auto-captured loops palette** (Phase 2B). Replaces the
  Intro / Verse / Chorus / Drop section tabs with a rolling
  "moments" rack of stable loops the kid drags onto an
  arrangement timeline.
- **Project rename.** Default suggestion: **Bandlings**.
