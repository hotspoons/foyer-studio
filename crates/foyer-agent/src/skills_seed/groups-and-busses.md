enabled: true

# Groups and busses

Two different concepts the agent should pick between deliberately.

## Group (gesture link, NO audio summing)

A group bundles tracks under one shared gesture: change gain on one
member, every member moves; mute one, all members mute. The audio
signal path is unchanged — each member still routes to wherever it
was routed before.

Tool: `groups`.

```json
{"subcommand": "create",
 "name": "Drums",
 "color": "#ffaa44",
 "members": ["track.kick", "track.snare", "track.hh"]}

{"subcommand": "list"}                                // survey
{"subcommand": "add_members", "id": "group.drums",
 "track_ids": ["track.ride"]}
{"subcommand": "update", "id": "group.drums",
 "link_solo": false}                                  // unlink one flag
{"subcommand": "delete", "id": "group.drums"}
```

Use a group when the user says:
- "make a group for the drums" / "link these tracks"
- "I want all backing vocals to move together"
- "solo'ing the lead should solo the doubles too" (link_solo: true)

## Bus (audio sum)

A bus is a separate TRACK of kind `bus` that other tracks route
their output to. Audio flows: track → bus → master. Insert a plugin
on the bus to apply it to the whole submix at once (drum bus comp,
vocal bus reverb).

Tools: `tracks.create` + `tracks.update`.

```json
{"subcommand": "create",
 "name": "Drum Bus",
 "kind": "bus",
 "color": "#aa3939"}
// → returns the new track id, e.g. "track.drum_bus"

{"subcommand": "update",
 "track_id": "track.kick",
 "bus_assign": "track.drum_bus"}
// repeat for each drum track
```

Pass `bus_assign: ""` (empty string) to clear the assignment and
restore routing to master.

Use a bus when the user says:
- "make a drum bus" / "send the drums through one compressor"
- "set up a vocal bus with reverb on it"
- anything that needs the SOUND of multiple tracks to flow
  through one DSP chain.

## Common mistakes

- **Confusing them.** "Group the drums" can mean either — when in
  doubt, ASK once: "Do you want them linked (move together but
  still go to master separately) or summed through a bus (audio
  passes through one chain)?"
- **Putting a plugin on a group**. Groups don't carry audio; they
  carry gestures. The plugin has to live on a real track (a bus
  if you want it applied to the sum).
- **Forgetting `bus_assign`**. Creating a bus track doesn't
  automatically route anything to it. You have to `tracks.update`
  each contributing track's `bus_assign` to point at the bus's id.

## Workflow: convert N tracks into a busmix

```json
{"subcommand": "list"}                              // tracks.list
// pick the contributing track ids; note their current bus_assign
{"subcommand": "create",                            // tracks.create
 "name": "Drum Bus", "kind": "bus"}
// remember the new track id
{"subcommand": "update", "track_id": "track.A",     // tracks.update
 "bus_assign": "track.drum_bus"}
// repeat for each member
{"subcommand": "insert",                            // plugins.insert
 "track_id": "track.drum_bus",
 "plugin_uri": "urn:ardour:a-comp"}
```

After that, the user can ride the drum-bus fader to balance the
whole kit, and the compressor applies to the entire submix.
