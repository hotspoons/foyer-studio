# Foyer session templates

Pre-built Ardour sessions the CLI extracts into ephemeral or
user-named project paths on demand.

| Template               | Use                                                                 |
| ---------------------- | ------------------------------------------------------------------- |
| `sprunki-beats.zip`    | 5-track MIDI session (Drums + Bass + Chords + Lead + FX) with the right instruments and regions pre-wired. Avoids the `create_track × 5 + add_plugin × 5 + create_region × 5` provisioning dance the sprunki variant runs on first boot — instead the variant just opens the template and ships `set_sequencer_layout` against the existing region IDs. |

## How they get used

(Not yet wired through the server — `Command::LaunchTemplate` is
the next iteration's job. For now the zip exists so we can build
the launcher path against a real artefact instead of a placeholder.)

The plan, when the schema lands:

```
Command::LaunchTemplate {
  template_id: "sprunki-beats",
  mode: "ephemeral",     // → mkdtemp /tmp/foyer-session-<uuid>/
                          //   unpack zip, LaunchProject against that path,
                          //   cleanup on session close.
                          // "persistent" → unpack into a user-named path.
}
```

The bundled template is the source of truth. When a user "saves
as template" we drop a sibling zip under
`~/.local/share/foyer/templates/user-saved/`.

## Regenerating `sprunki-beats.zip`

If the variant grows new tracks / plugins, re-seed:

```bash
# 1. fresh sprunki session
rm -rf /workspaces/sprunki-scratch /tmp/foyer/ardour-*

# 2. boot a clean foyer (ardour backend, dev tree)
just run --backend ardour

# 3. in a browser, open /?ui=sprunki and let it finish provisioning.
#    The variant will create the 5 tracks + plugins + regions and
#    ship the initial layouts.

# 4. trigger a save
curl -X POST http://127.0.0.1:3838/api/... # or hit the Save button

# 5. zip the resulting session, excluding waveform caches and backups
cd /workspaces/sprunki-scratch
zip -r ../foyer-studio/crates/foyer-cli/templates/sprunki-beats.zip . \
   -x "*.bak" -x "peaks/*" -x "analysis/*" -x "dead/*" -x "*.history*"
```

The variant's `setup.js` is the source of truth for the track
layout; the template just captures the result of one clean
provisioning run.
