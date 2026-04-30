#!/usr/bin/env bash
# Idempotent seeder for ~/.config/ardour9/.
#
# Container runtimes (and the dev container's first boot) hit two
# blocking dialogs the first time Ardour is launched against a fresh
# user dir:
#   1. "Welcome to Ardour" first-run wizard. Gated on the existence of
#      the file `<config-dir>/.a9` (per
#      `gtk2_ardour/new_user_wizard.cc::required()` →
#      `libs/ardour/filesystem_paths.cc::been_here_before_path`).
#   2. Audio/MIDI Setup dialog. Appears when no `<EngineStates>` are
#      saved or when the saved engine fails to autostart. Stored
#      inside `<config-dir>/config` as an `<Extra>/<AudioMIDISetup>`
#      block (per `gtk2_ardour/engine_dialog.cc:326` +
#      `libs/pbd/stateful.cc:102` — the `<Extra>` wrapper is required;
#      child nodes at the root of `<Ardour>` are silently ignored).
#
# Usage:
#   seed-ardour-config.sh                  # always seeds .a9 only
#   seed-ardour-config.sh --ams-dummy      # also seeds AMS for the
#                                          # libardour "None (Dummy)"
#                                          # backend with Silence
#                                          # device — what we want in
#                                          # non-privileged contexts
#                                          # (Cloud Run gen2) where
#                                          # JACK can't acquire
#                                          # SCHED_FIFO and the
#                                          # `failed_constructor`
#                                          # cascade kills hardour.
#
# Override the config dir via `ARDOUR_CONFIG_DIR=...`. Default is
# `$HOME/.config/ardour9` (Linux). Re-running is safe — existing
# files are NEVER overwritten so a user who configured Ardour
# manually keeps their settings.

set -euo pipefail

cfg_dir="${ARDOUR_CONFIG_DIR:-$HOME/.config/ardour9}"
mkdir -p "$cfg_dir"

# Wizard-skip sentinel — always seed. Empty file is the marker.
if [ ! -f "$cfg_dir/.a9" ]; then
    touch "$cfg_dir/.a9"
    echo "seed-ardour-config: created $cfg_dir/.a9 (welcome wizard skip)"
fi

# Optional: seed the Audio/MIDI Setup with the Dummy backend so
# autostart bypasses the AMS dialog on first session load. Only
# applied when explicitly asked AND no existing config is present.
if [ "${1:-}" = "--ams-dummy" ]; then
    if [ -f "$cfg_dir/config" ]; then
        echo "seed-ardour-config: $cfg_dir/config already present — leaving as-is"
    else
        cat > "$cfg_dir/config" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<Ardour version="9.0.0">
  <Config>
    <Option name="try-autostart-engine" value="1"/>
  </Config>
  <Extra>
    <AudioMIDISetup>
      <EngineStates>
        <State backend="None (Dummy)"
               driver=""
               device="Silence"
               input-device=""
               output-device=""
               sample-rate="48000"
               buffer-size="1024"
               n-periods="2"
               input-latency="0"
               output-latency="0"
               lm-input="0"
               lm-output="0"
               active="1"
               use-buffered-io="0"
               midi-option=""
               lru="$(date +%s)">
          <MIDIDevices/>
        </State>
      </EngineStates>
    </AudioMIDISetup>
  </Extra>
</Ardour>
EOF
        echo "seed-ardour-config: created $cfg_dir/config (Dummy backend / Silence device)"
    fi
fi
