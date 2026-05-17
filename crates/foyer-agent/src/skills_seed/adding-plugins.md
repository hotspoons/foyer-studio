enabled: true

# Adding and configuring plugins

How to add a plugin to a track and customize its parameters without
wasting round-trips.

## Recipe

1. **Search the catalog FIRST** with a `query` that narrows hard:
   ```json
   {"subcommand": "catalog", "query": "reverb", "limit": 10}
   ```
   The catalog has ~900 plugins. A blank query returns the first 50
   and you'll spend several turns scrolling. Use `query` to match
   name / vendor / uri (case-insensitive substring).
2. **Insert by URI**:
   ```json
   {"subcommand": "insert", "track_id": "track.177", "plugin_uri": "urn:ardour:a-comp"}
   ```
   Optional `index` controls chain position; omit to append.
3. **Read the param list with `describe`**:
   ```json
   {"subcommand": "describe", "plugin_id": "plugin.43188"}
   ```
   This returns every `control_id` plus ranges, scales (`Linear` /
   `Logarithmic` / `Decibels` / `Hertz`), and unit labels — you NEED
   this before tuning anything, because `set_param` takes raw values
   inside the declared range, NOT normalized 0..1.
4. **Tune with `set_params` (BATCHED)**:
   ```json
   {"subcommand": "set_params", "plugin_id": "plugin.43188",
    "params": [
      {"control_id": "plugin.43188.param.0", "value": 5},
      {"control_id": "plugin.43188.param.4", "value": -18},
      {"control_id": "plugin.43188.param.5", "value": 4}
    ]}
   ```
   One call applies the whole patch. Don't fire `set_param` thirty
   times in a row — the user sees every WS round-trip.

## When to prefer presets over hand-tuning

```json
{"subcommand": "list_presets", "plugin_id": "plugin.43188"}
{"subcommand": "load_preset", "plugin_id": "plugin.43188",
 "preset_uri": "urn:ardour:a-comp#preset002"}
```

If the plugin ships a factory preset that's close, loading it then
nudging a few params with `set_params` is faster and more musical
than starting from defaults.

## Cloning a plugin's setup to another track

```json
{"subcommand": "duplicate",
 "source_plugin_id": "plugin.43188",
 "target_track_id": "track.245"}
```

Copies URI + current params + active preset to the target track.
Use when the user says "put the same compressor on the vocal".

## Gotchas

- Some plugins (e.g. ACE Reverb, hardware-emulation VSTs) expose
  only `Bypass` over the schema — their parameter surface lives
  inside a native GUI window the host can't introspect.
  `describe` will show `param_count: 1`. Don't pretend `set_params`
  failed — TELL THE USER and direct them to open the plugin's
  panel via Foyer's "Native GUI" button (the host runs the plugin
  GUI through xpra and pipes it back to the browser). The user
  drives the knobs themselves; the agent steps aside on these.
- Ranges are inclusive. A `Continuous` Threshold with range
  `[-60, 0]` rejects -61 — clamp on your side or you'll get a
  schema error.
- `Decibels` scale params still take raw dB values, not linear
  gain. -18 dB is `value: -18`, not `value: 0.126`.
- A `Trigger` kind takes booleans, NOT numbers — `value: true` /
  `value: false`. Don't pass 1.0.
