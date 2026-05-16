enabled: true

# Authoring Ardour Lua DSP plugins

DSP scripts are Lua-authored audio plugins. After `scripts.save { script_type: "dsp", … }` the script is dropped into Ardour's user_script_dir and a refresh cascade exposes it in the plugin catalog. The user then inserts it on a track via `plugins.insert` — same path as a native plugin.

## Required shape

Every DSP script MUST define:

- A top-level **`ardour { ... }`** info table (called once at scan time to register metadata)
- **`dsp_ioconfig()`** returning input/output channel configurations
- **`dsp_run(ins, outs, n_samples)`** — the real-time block

Common optional additions:

- `dsp_params()` — declare user-facing controls
- `dsp_init(rate)` — one-shot init given the engine sample rate

## Minimum viable template

```lua
ardour {
    ["type"]    = "dsp",
    name        = "My Effect",
    category    = "Utility",
    license     = "MIT",
    author      = "Foyer",
    description = "One sentence summary."
}

function dsp_ioconfig ()
    -- Pairs of {in, out} channel counts. -1 = any, matches ins to outs.
    return { { audio_in = 1, audio_out = 1 } }
end

function dsp_params ()
    return {
        { ["type"] = "input", name = "Gain", min = 0, max = 2, default = 1 },
    }
end

function dsp_init (rate)
    -- Lua locals only — see "Sharp edges" below.
    local self = {}
    self.sr = rate
    -- Stash on a closure-captured upvalue that dsp_run can read.
    state = self
end

function dsp_run (ins, outs, n_samples)
    local ctrl = CtrlPorts:array()
    local gain = ctrl[0]
    local ib = ins[1]:array()
    local ob = outs[1]:array()
    for i = 0, n_samples - 1 do
        ob[i] = ib[i] * gain
    end
end
```

## Sharp edges (these are the ones that silently fail to instantiate)

1. **Don't pre-allocate huge buffers in `dsp_init`**. A 2-second delay line at 96 kHz is 192 000 entries — Lua's array constructor and the GC pressure during init can stall instantiation. Allocate lazily on first `dsp_run` OR use a ring buffer that grows only as the write head wraps.

2. **Avoid global variables across instances**. Two tracks running the same DSP each get their own Lua VM — but if you grab a `_G.foo` it can clash with names Ardour provides. Use local upvalues captured into a closure, or stash state in a single `state` table.

3. **Audio buffers are 0-indexed** even though Lua tables are usually 1-indexed. `ib[0]` is the first sample.

4. **`CtrlPorts:array()` returns control-port values 0-indexed**. The first declared param is `ctrl[0]`.

5. **No file IO, no `os.execute`, no `io.open`** inside `dsp_run` — that path runs under the audio thread and any blocking call drops the session. Allocate file handles (if you must) inside `dsp_init`.

6. **`dsp_ioconfig` is queried during plugin scan**, not after. Return a table that's STATIC — don't compute it based on session state that won't exist at scan time.

7. **Test on small N**. If `dsp_init` or `dsp_run` raises any error, Ardour silently drops the instantiation and `plugins.insert` reports success but the plugin doesn't appear on the track. Watch the Console window for `Lua:` lines on failure.

## Hand-off check

After `scripts.save { script_type: "dsp" }`:

1. `plugins.catalog { query: "<your name>" }` — confirm the plugin appears.
2. `plugins.insert { track_id: …, plugin_uri: <unique_id from catalog> }` — adds to the track.
3. `transport.play` + verify audibly that the effect is doing what you intended.
4. If insert silently fails, the script body is the problem — usually a bad `dsp_init` allocation or a typo in the `ardour { … }` table. Rewrite with a tighter init.
