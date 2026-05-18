enabled: true

# Authoring Ardour Lua Editor Actions

Editor Actions are reusable Lua scripts invoked manually from the Script Manager or by keybind. Compared to DSP scripts they have unrestricted access to the session — they can mutate regions, automation, transport, plugin params, etc. Save via `scripts.save { script_type: "editor_action" }`.

## Required shape

Editor Actions live inside a single **factory** function. Ardour calls `factory()` once per invocation; the returned function is what actually runs.

```lua
ardour {
    ["type"]    = "EditorAction",
    name        = "My Action",
    license     = "MIT",
    author      = "Foyer",
    description = "What it does, one line."
}

function factory (params)
    return function ()
        -- Action body — runs each time the user triggers the action.
        local s = Session
        if not s then return end
        -- ... operate on s ...
    end
end
```

## Useful globals available inside the action body

- `Session` — the active `ARDOUR.Session`. Almost every operation hangs off this.
- `Editor` — the editor singleton (selection, ruler, locate).
- `Session:get_tracks()` — iterable of every track.
- `Session:get_routes()` — iterable of tracks + busses + master.
- `Session:request_transport_speed(speed)` — 1.0 to play, 0.0 to stop.
- `Session:request_locate(samples, force)` — jump to a sample position.

Example — solo every audio track:

```lua
function factory ()
    return function ()
        for t in Session:get_tracks():iter() do
            if t:data_type():to_string() == "audio" then
                t:solo_control():set_value(1, PBD.GroupControlDisposition.UseGroup)
            end
        end
    end
end
```

## Parameters

To prompt the user for inputs declare them in `dsp_params`-shaped tables and read them via `params` in `factory`:

```lua
function factory (params)
    return function ()
        local n = params["count"] or 4
        for i = 1, n do
            -- ...
        end
    end
end

function action_params ()
    return {
        { ["type"] = "input", name = "count", title = "How many", default = 4 },
    }
end
```

## Sharp edges

- **Don't write to globals**. Same VM is shared across action invocations; a stray `_G.x = …` persists. Always `local`.
- **Bail when `Session` is nil** — actions can be invoked before a session loads.
- **Mutations need an undo group**: `Session:begin_reversible_command("My Action")` … `Session:commit_reversible_command(nil)` — without it, the user can't undo.
- **Logging**: `print("...")` shows up in the Lua console; `LuaDialog.Message(...)` for a modal.
