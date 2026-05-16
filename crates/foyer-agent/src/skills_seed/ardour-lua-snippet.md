enabled: true

# Authoring Ardour Lua Snippets

Snippets are one-shot scripts the user (or agent) fires from the Script Manager. Compared to Editor Actions they have no `factory` indirection — the body just runs. Save via `scripts.save { script_type: "snippet" }`.

## Shape

```lua
ardour {
    ["type"]    = "Snippet",
    name        = "Print track names",
    description = "Sanity check — list every track in the session."
}

-- Body runs at invocation time. No factory, no params.
if Session then
    for t in Session:get_tracks():iter() do
        print(t:name())
    end
else
    print("no session")
end
```

## When to use which type

- **Snippet** — one-off "tell me / inspect" scripts. No persisted state, no args.
- **Editor Action** — reusable parameterised operation (a real verb the user wants to invoke from a binding).
- **Editor Hook** — automatic reaction to a host signal.
- **DSP** — audio processing. Lives in the plugin catalog.

## Sharp edges

- **No params**. If you need inputs, use an Editor Action.
- **Output goes to the Lua console** via `print()`. From Foyer, that surfaces as the `stdout` field of `scripts.run`'s `ScriptRunResult`.
- **`Session` may be nil** — guard.
