enabled: true

# Authoring Ardour Lua Editor Hooks

Editor Hooks fire automatically when the host emits one of a fixed set of signals. Save via `scripts.save { script_type: "editor_hook", hook: "<hook_name>" }`. Hook names come from `scripts.capabilities` — never hardcode.

## Required shape

```lua
ardour {
    ["type"]    = "EditorHook",
    name        = "My Hook",
    description = "Fires when X happens."
}

function signals ()
    -- Subscribe to specific signal names. The shim's `hook` field
    -- picks ONE; this table returns the bitmask the engine wires up.
    return LuaSignal.Set():add({
        [LuaSignal.TransportStateChange] = true,
    })
end

function factory (params)
    return function (signal, ...)
        -- `signal` is the LuaSignal enum that fired.
        -- The remaining varargs are signal-specific data.
        if signal == LuaSignal.TransportStateChange then
            local speed = Session:transport_speed()
            print("transport now: " .. tostring(speed))
        end
    end
end
```

## Common signals

Pulled from Ardour's `LuaSignal` enum (the shim advertises the subset
it exposes via `scripts.capabilities` → `script_types[*].hooks`):

- `TransportStateChange` — play / stop / reverse
- `SelectionChanged` — user changed the selection
- `RegionPropertyChanged` — a region's metadata changed
- `PunchLoopConstraint` — punch / loop range edited
- `SessionLoaded` — fires once after a session finishes loading

## Sharp edges

- **Hooks are RT-context-adjacent**. Don't allocate on the hot path; don't sleep; don't block.
- **`Session` may be nil** during early-boot or post-close signals. Always guard.
- **Cross-session state must live in upvalues**, not globals — Ardour reloads the script on session swap.
- **One signal per script** in Foyer's surface. If you need to react to multiple signals, save multiple hooks pointing at the same body.
