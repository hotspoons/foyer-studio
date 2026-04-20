set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# --- rust ---
build:
    cargo build --workspace --all-targets

test:
    cargo test --workspace --all-targets

fmt:
    cargo fmt --all

fmt-check:
    cargo fmt --all -- --check

clippy:
    cargo clippy --workspace --all-targets -- -D warnings

check: fmt-check clippy test

# --- dev loops ---
# Launch foyer with whatever `default_backend` is in config.yaml (stub on
# first run — dummy data, no DAW process). `just run` is the everyday
# "bring up the UI" command.
run *args:
    cargo run --bin foyer -- serve {{args}}

# Launch with the stub (dummy) backend explicitly — useful if config
# default got changed and you just want the demo UI back.
run-stub *args:
    cargo run --bin foyer -- serve --backend stub {{args}}

# Launch with the Ardour backend. If PROJECT is given, the configured
# executable is spawned with the project as argv and we wait for the
# shim to advertise before serving. Without PROJECT, discovery picks
# the single live shim (fails if none is running).
#
#   just run-ardour                        # attach to already-running Ardour
#   just run-ardour /tmp/foyer-session/foyer-smoke.ardour
run-ardour project="" *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{project}}" ]; then
      cargo run --bin foyer -- serve --backend ardour --project "{{project}}" {{args}}
    else
      cargo run --bin foyer -- serve --backend ardour {{args}}
    fi

# Print the list of backends configured in $XDG_DATA_HOME/foyer/config.yaml
# (creates the file on first call with sensible defaults).
backends:
    cargo run --bin foyer -- backends

# Print the absolute path of config.yaml.
config-path:
    cargo run --bin foyer -- config-path

# Scan for DAW executables and write the results into config.yaml. Safe to
# re-run; existing paths are preserved unless you pass `--force`. Checks
# $PATH, macOS app bundles, and the sibling Ardour checkout at
# $FOYER_ARDOUR_BUILD_ROOT (default /workspaces/ardour).
#
#   just configure               # detect missing paths, write
#   just configure --dry-run     # preview without writing
#   just configure --force       # overwrite even if already set
configure *args:
    cargo run --bin foyer -- configure {{args}}

# --- web (M4) ---
# tailwind standalone binary lives in ./.bin/ after first run; committed artifact is web/styles/tw.build.css
tw_bin := justfile_directory() + "/.bin/tailwindcss"

tw-build:
    {{tw_bin}} -i web/styles/tw.css -o web/styles/tw.build.css --minify

tw-watch:
    {{tw_bin}} -i web/styles/tw.css -o web/styles/tw.build.css --watch

# --- ardour (sibling repo at /workspaces/ardour) ---
ardour_dir := "/workspaces/ardour"

# Configure Ardour's waf build — first-time setup or after dep changes.
ardour-configure *args:
    cd {{ardour_dir}} && python3 waf configure --optimize {{args}}

# Build Ardour. Takes ~30 min on a clean tree; incremental is fast.
ardour-build *args:
    cd {{ardour_dir}} && python3 waf build {{args}}

# Convenience: configure + build in one shot.
ardour: ardour-configure ardour-build

# Run tests inside Ardour's tree. Mostly not needed unless touching libardour.
ardour-test:
    cd {{ardour_dir}} && python3 waf test

ardour-clean:
    cd {{ardour_dir}} && python3 waf clean

# --- foyer shim (C++, builds against Ardour tree) ---
shim_dir := justfile_directory() + "/shims/ardour"
shim_link := ardour_dir + "/libs/surfaces/foyer_shim"

# Symlink the shim into Ardour's libs/surfaces/ so waf picks it up.
shim-link:
    test -L "{{shim_link}}" || ln -s "{{shim_dir}}" "{{shim_link}}"

# Build the shim (or anything else).
shim-build: shim-link
    cd {{ardour_dir}} && python3 waf build

# Remove the shim from Ardour's tree (clean Ardour rebuild).
shim-unlink:
    rm -f "{{shim_link}}"

# --- foyer shim (out-of-tree CMake build, no Ardour source edits) ---
#
# Builds `libfoyer_shim.so` against a sibling Ardour source tree
# without touching any file in it. Matches the eventual shipping
# story: third-party control-surface authors drop their .so into
# `$ARDOUR_SURFACES_PATH` and Ardour picks it up at startup. See
# [docs/PROPOSAL-surface-auto-discovery.md](docs/PROPOSAL-surface-auto-discovery.md).
#
# Requires the sibling Ardour tree to be configured + built at least
# once (`just ardour-configure && just ardour-build`) — we link
# against its in-tree libraries under build/libs/. When Ardour ships
# a proper `ardour-surface.pc` upstream this will flip to
# `find_package(Ardour)` and be even simpler.
shim_cmake_build := shim_dir + "/cmake-build"

shim-cmake-configure:
    cmake -S {{shim_dir}} -B {{shim_cmake_build}} \
          -DCMAKE_BUILD_TYPE=RelWithDebInfo \
          -DFOYER_ARDOUR_SOURCE={{ardour_dir}}

shim-cmake-build: shim-cmake-configure
    cmake --build {{shim_cmake_build}} -j

# Install the out-of-tree .so into a user-scoped Ardour surfaces dir.
# Ardour's default `ARDOUR_SURFACES_PATH` already scans
# `$HOME/.config/ardour<N>/surfaces/` so no env var tweak needed.
# Override DEST to point elsewhere (system-wide, test dir, etc).
shim-install DEST="$HOME/.config/ardour9": shim-cmake-build
    mkdir -p "{{DEST}}/surfaces"
    cp {{shim_cmake_build}}/libfoyer_shim.so "{{DEST}}/surfaces/"
    echo "✓ Installed libfoyer_shim.so → {{DEST}}/surfaces/"
    echo "  Ardour will pick it up from ARDOUR_SURFACES_PATH at next startup."

# Clean the out-of-tree build.
shim-cmake-clean:
    rm -rf {{shim_cmake_build}}

# --- cleanup ---
# Kill any stale DAW + sidecar processes and their IPC detritus.
# Useful after a crash, a stuck `foyer serve` that's holding
# target/debug/foyer (preventing `cargo build` from updating the
# binary), or a series of Listen clicks that left orphan hardour
# processes (Ardour doesn't always exit cleanly when its parent
# terminates).
#
# Kills — by exact name match:
#   · hardour-9.2.583, ardour, ardour-9.2  (the DAW)
#   · foyer                                (the sidecar)
#
# Plus removes Unix sockets in /tmp/foyer/ so the next `just run`
# doesn't hit "advertised shim at /tmp/foyer/ardour-<pid>.sock is
# stale (connect: Connection refused)". Safe at any time; won't
# touch anything outside those specific process names.
kill-daws:
    #!/usr/bin/env bash
    set -u
    killed=0
    for name in hardour-9.2.583 ardour ardour-9.2 foyer; do
        pids=$(pgrep -x "$name" || true)
        if [ -n "$pids" ]; then
            echo "Killing $name: $pids"
            kill -TERM $pids 2>/dev/null || true
            killed=$((killed + $(echo "$pids" | wc -w)))
        fi
    done
    # Give SIGTERM a moment, then SIGKILL anything still breathing.
    sleep 1
    for name in hardour-9.2.583 ardour ardour-9.2 foyer; do
        pids=$(pgrep -x "$name" || true)
        if [ -n "$pids" ]; then
            echo "SIGKILL $name: $pids"
            kill -KILL $pids 2>/dev/null || true
        fi
    done
    # Clear shim advertisement files + stale Unix sockets so the next
    # `just run` starts from a clean slate.
    rm -f /tmp/foyer.sock /tmp/foyer/ardour-*.sock /tmp/foyer/ardour-*.json 2>/dev/null || true
    remaining=$(ps -eo pid,comm | awk '$2 ~ /^h?ardour/ {print $1}' | head)
    if [ -z "$remaining" ]; then
        echo "✓ clean — no DAW processes and no stale sockets"
    else
        echo "⚠ still running: $remaining"
    fi

# --- end-to-end smoke (Ardour headless + foyer_shim + foyer-cli) ---
# Create a throwaway session using Ardour's session_utils, with all env vars
# set up so the dummy backend is found.
session_dir := "/tmp/foyer-session"

ardour-new-session name="foyer-smoke":
    #!/usr/bin/env bash
    set -eo pipefail
    rm -rf {{session_dir}}
    export TOP={{ardour_dir}}
    source {{ardour_dir}}/build/gtk2_ardour/ardev_common_waf.sh
    {{ardour_dir}}/build/session_utils/ardour9-new_empty_session {{session_dir}} {{name}}

# Populate the demo session with some audio tracks so the mixer has
# real content. Run after `just ardour-new-session` and BEFORE launching
# hardour (Ardour will overwrite the session on close if it's already open).
populate-demo-session:
    #!/usr/bin/env bash
    set -eo pipefail
    export TOP={{ardour_dir}}
    source {{ardour_dir}}/build/gtk2_ardour/ardev_common_waf.sh
    {{ardour_dir}}/build/luasession/luasession {{justfile_directory()}}/scripts/populate-demo-session.lua

# Launch hardour against the session with foyer_shim on the surfaces path.
# Shim activation must be configured by patching the session file (see docs).
ardour-hardev name="foyer-smoke":
    #!/usr/bin/env bash
    set -eo pipefail
    export TOP={{ardour_dir}}
    source {{ardour_dir}}/build/gtk2_ardour/ardev_common_waf.sh
    export ARDOUR_SURFACES_PATH="{{ardour_dir}}/build/libs/surfaces/foyer_shim:${ARDOUR_SURFACES_PATH}"
    export ARDOUR_BACKEND="None (Dummy)"
    rm -f /tmp/foyer.sock
    exec {{ardour_dir}}/build/headless/hardour-9.2.583 {{session_dir}} {{name}}

# Full E2E: creates a session (if missing), launches hardour + foyer_shim,
# connects foyer-cli with --backend=host, reports success/failure. Call after
# `just ardour-build` + `just shim-build`.
shim-e2e:
    #!/usr/bin/env bash
    set -o pipefail
    cleanup() { kill ${HP:-0} ${FP:-0} 2>/dev/null; wait 2>/dev/null; }
    trap cleanup EXIT
    rm -f /tmp/foyer.sock /tmp/hardour.log /tmp/foyer-cli.log
    if [ ! -f {{session_dir}}/{{"foyer-smoke"}}.ardour ]; then just ardour-new-session; fi
    # Ensure the shim is enabled in the session file.
    if ! grep -q 'name="Foyer Studio Shim" active="1"' {{session_dir}}/foyer-smoke.ardour; then
      sed -i 's|<Protocol name="Wiimote" active="0"/>|<Protocol name="Wiimote" active="0"/>\n    <Protocol name="Foyer Studio Shim" active="1"/>|' {{session_dir}}/foyer-smoke.ardour
    fi
    export TOP={{ardour_dir}}
    source {{ardour_dir}}/build/gtk2_ardour/ardev_common_waf.sh > /dev/null
    export ARDOUR_SURFACES_PATH="{{ardour_dir}}/build/libs/surfaces/foyer_shim:${ARDOUR_SURFACES_PATH}"
    export ARDOUR_BACKEND="None (Dummy)"
    {{ardour_dir}}/build/headless/hardour-9.2.583 {{session_dir}} foyer-smoke > /tmp/hardour.log 2>&1 &
    HP=$!
    for i in {1..40}; do [ -S /tmp/foyer.sock ] && break; sleep 0.5; done
    [ -S /tmp/foyer.sock ] || { echo "FAIL: shim socket never appeared"; tail -20 /tmp/hardour.log; exit 1; }
    echo "✓ shim socket up at /tmp/foyer.sock"
    {{justfile_directory()}}/target/debug/foyer serve --backend ardour --socket /tmp/foyer.sock --listen 127.0.0.1:3842 --web-root {{justfile_directory()}}/web > /tmp/foyer-cli.log 2>&1 &
    FP=$!
    for i in {1..30}; do curl -sf http://127.0.0.1:3842/index.html > /dev/null 2>&1 && break; sleep 0.5; done
    kill -0 $FP 2>/dev/null || { echo "FAIL: foyer-cli died"; cat /tmp/foyer-cli.log; exit 1; }
    echo "✓ foyer-cli up on http://127.0.0.1:3842"
    sleep 3
    grep -qE 'event pump died|bad control frame|panic' /tmp/foyer-cli.log && { echo "FAIL: pump errored"; cat /tmp/foyer-cli.log; exit 1; }
    echo "✓ E2E_OK — foyer-cli → foyer-shim → hardour"
