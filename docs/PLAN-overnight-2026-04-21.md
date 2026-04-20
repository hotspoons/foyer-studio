# Overnight Push — 2026-04-21

**Prime directive:** keep moving. User is asleep. Read all docs,
identify the biggest remaining user-facing gaps, ship.

Previous push
([PLAN-overnight-2026-04-20.md](PLAN-overnight-2026-04-20.md))
landed most UI polish — waveforms (Ardour's connected-line algorithm
ported to Canvas2D + viewport cropping), track editor modal, plugin
picker, plugin param live signals, MIDI skeleton, dock panels, modal
themes, paired-edge resize. The user's verdict:
*"It is finally starting to feel like a $2000 DAW console."*

After docs review, the highest-impact remaining gaps are:

1. **Transport UX completeness.** Undo / Redo don't have dedicated
   buttons (only the keyboard chords are bound). The Session menu
   items for save-as / export are stubs.
2. **MIDI flow.** The piano roll component landed but the shim
   doesn't emit real notes yet — opening a MIDI region shows the
   skeleton with no data. The Ardour side can iterate
   `MidiModel::Notes` per region and emit them inline on the
   `regions_list` envelope.
3. **Busses and groups.** TODO.md flags both as outright missing.
   Shim emits track kinds (audio/bus/master/monitor) but group
   membership and send routing aren't exposed in the schema.
4. **Session file operations.** "Open Session" opens a picker;
   "Save" works. Save-As and Export land in the shim as log-only
   warnings. These are small but visibly-dead menu entries.
5. **Diagnostics polish.** User has a "Clear peak cache" button
   already. A running-tests panel + an "inspect shim state" view
   would make pair-debugging with the user faster.

## This push

Tackle these in order, small-to-medium scope first, biggest-unlock
last. Skip any that hit a research blocker and park in Deferred.

### Phase A — Transport UX (Undo/Redo buttons + menu polish)

TODO.md line 274: *"add undo and redo… keyboard chords wired…
Dedicated buttons still TODO in transport-bar."* Same pattern for
Save — the menu item exists, a toolbar button would make it a
single-click op. Add a small "edit" cluster to the transport bar:
Undo, Redo, Save (dirty-aware).

### Phase B — MIDI note emission from the shim

Schema has `MidiNote`. Shim's `encode_regions_list` emits
audio-region metadata only. Extend it to MIDI regions: iterate
`MidiModel::notes()` on each `MidiRegion` and emit notes inline.
Client-side, plumb `region.notes` into the MIDI editor so the piano
roll shows real data.

Non-blocker for this phase: note-level edits (drag, velocity scrub)
stay read-only. Edits are a follow-up once the renderer is proven.

### Phase C — Session file operations (save-as, export)

Save-as = prompt modal + `Session::save_state(path)`. Export =
inform the user we don't support export yet and point at Ardour's
native export. A toast saying "Export goes through Ardour's native
dialog for now" is better than silence.

### Phase D — Bus / group support (structural — sketched)

Introduce `Session.groups: Vec<Group>`, `Track.group_id:
Option<EntityId>`, `Track.sends: Vec<Send>`. Shim populates these
from Ardour's `RouteGroup` + `Send` objects. Web-side: group rows
in the mixer (collapsible), send strips beneath the fader.

Big scope — expect to stub out most of this and ship just the
read-only fields if time is tight.

### Phase E — Diagnostics polish

Add "Inspect shim state" panel: dumps the shim's `SNAPSHOT:` state
strings, the last 100 control events, current open egress streams.
Useful for the next round of bug reports. Lives in the existing
diagnostics tile.

### Phase F — Docs refresh

README + HANDOFF + TODO + DECISIONS all need a pass to reflect the
two-sessions-worth of shipping. Specifically:

- README's status table should flip waveforms / track editor / plugin
  param live updates from "planned" → "shipped."
- HANDOFF gets a new "2026-04-21 overnight push" section with the
  deltas.
- TODO closes items that shipped; opens items that fell out of the
  waveform + track-editor + plugin-signals work.
- DECISIONS gets an ADR for the Ardour-algorithm port (why Canvas2D
  beat WebGL for us, what the GPL boundary is given we port only
  the algorithm).

---

## Deferred / noted blockers

- **M6a shim RT audio tap — SHIPPED (2026-04-21 afternoon).**
  Went with the `ARDOUR::Processor` subclass approach
  ([shims/ardour/src/master_tap.cc](../shims/ardour/src/master_tap.cc)).
  Audio thread copies samples into a `PBD::RingBuffer`, non-RT
  drain thread emits `FrameKind::Audio` frames. See DECISIONS.md
  entry #19 for the tradeoff analysis.
- **Session-opens-rolling regression** — needs a live-running app
  to trace; no ControlSet arrives in the daw.log so Ardour is
  transitioning from external state. Low priority until the user
  can reproduce on demand.
- **M7 multi-user collab, M8 MCP agent round-trip** — schedule-wise
  these are still multi-week undertakings, not single-session wins.

---

## Execution order

A → B → C → D → E → F. Each phase ships independently. If phase D
slides (busses/groups is genuinely big), move to E + F rather than
halt.
