set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

rust_log_default := "info"
rust_log_verbose := "foyer_server=debug"

rust-log debug:
    #!/usr/bin/env bash
    if [ "{{debug}}" == "true" ]; then echo "{{rust_log_verbose}}"; else echo "{{rust_log_default}}"; fi

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
#
# `jack-dummy` is a dependency because the moment the user picks a project
# in the browser picker, the sidecar spawns a hardour process that tries
# to connect to JACK (hardour's default backend is "JACK/Pipewire"). If
# jackd isn't running, hardour errors out at startup with "Cannot set
# Audio/MIDI engine backend: JACK/Pipewire" and the LaunchBackend swap
# fails. The `jack-dummy` recipe is idempotent — no-op if jackd is
# already up, so chaining is cheap.
#
# LAN access: pass `listen=0.0.0.0:3838` to bind all interfaces
# instead of loopback. Example:
#     just run listen=0.0.0.0:3838
# `just run` defaults to 127.0.0.1:3838 (loopback only) since that's
# the safe local-development story — no auth on the WS surface means
# binding 0.0.0.0 exposes the DAW to anyone on the LAN.
# Pass `debug=true` to enable verbose logging:
#     just run debug=true
run listen='127.0.0.1:3838' debug='false' *args: jack-dummy shim-check
    #!/usr/bin/env bash
    source /dev/stdin <<'EOF'
    rust_log() {
        if [ "{{debug}}" == "true" ]; then echo "foyer_server=debug"; else echo "info"; fi
    }
    EOF
    RUST_LOG=$(rust_log) cargo run --bin foyer -- serve --listen {{listen}} {{args}}

# Convenience: bind all interfaces so another computer on the LAN
# instead of loopback. Equivalent to `just run listen=0.0.0.0:3838`.
run-lan debug='false' *args: jack-dummy shim-check
    #!/usr/bin/env bash
    source /dev/stdin <<'EOF'
    rust_log() {
        if [ "{{debug}}" == "true" ]; then echo "foyer_server=debug"; else echo "info"; fi
    }
    EOF
    RUST_LOG=$(rust_log) cargo run --bin foyer -- serve --listen 0.0.0.0:3838 {{args}}

# Same as run-lan, but with HTTPS via a self-signed cert so the
# sidecar is reachable from mobile browsers. Browsers gate
# AudioWorklet (used by the Listen button) on a secure context —
# plain HTTP on a LAN IP makes the Listen button error out on
# phones. This recipe generates a throwaway cert in
# `~/.local/share/foyer/tls/` covering both the container's LAN
# IPs and `localhost`, then boots foyer with `--tls-cert/--tls-key`.
#
# Accept the self-signed warning once on each device — subsequent
# loads are fine. The cert is tied to the host's LAN IPs at
# generation time; if your address changes, re-run this recipe to
# refresh.
run-lan-tls *args='': jack-dummy shim-check
    #!/usr/bin/env bash
    set -euo pipefail
    tls_dir="${XDG_DATA_HOME:-$HOME/.local/share}/foyer/tls"
    mkdir -p "$tls_dir"
    cert="$tls_dir/dev.pem"
    key="$tls_dir/dev-key.pem"
    if [ ! -f "$cert" ] || [ ! -f "$key" ]; then
        echo "Generating self-signed cert at $tls_dir/"
        # Collect the host's LAN IPs so the cert's SAN covers them —
        # browsers reject CN-only certs for IP-literal URLs.
        san_lines=("DNS:localhost" "IP:127.0.0.1" "IP:::1")
        for ip in $(hostname -I 2>/dev/null); do
            case "$ip" in
                127.*|172.17.*|172.18.*|172.19.*|172.20.*) continue ;;
            esac
            san_lines+=("IP:$ip")
        done
        san_joined=$(IFS=,; echo "${san_lines[*]}")
        openssl req -x509 -newkey rsa:2048 -nodes \
            -days 365 \
            -keyout "$key" -out "$cert" \
            -subj "/CN=foyer-dev" \
            -addext "subjectAltName=$san_joined" \
            2>/dev/null
        echo "SAN: $san_joined"
    fi
    cargo run --bin foyer -- serve \
        --listen 0.0.0.0:3838 \
        --tls-cert "$cert" --tls-key "$key" \
        {{args}}

# Launch with the stub (dummy) backend explicitly — useful if config
# default got changed and you just want the demo UI back. No JACK
# dependency because the stub generates its own sine wave and never
# spawns a DAW.
run-stub *args:
    cargo run --bin foyer -- serve --backend stub {{args}}

# Launch with the Ardour backend. If PROJECT is given, the configured
# executable is spawned with the project as argv and we wait for the
# shim to advertise before serving. Without PROJECT, discovery picks
# the single live shim (fails if none is running).
#
#   just run-ardour                        # attach to already-running Ardour
#   just run-ardour /tmp/foyer-session/foyer-smoke.ardour
run-ardour project="" *args: jack-dummy shim-check
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

# --- foyer shim (standalone out-of-tree CMake build) ---
#
# The shim is a pure third-party control surface: a `libfoyer_shim.so`
# dropped into an `ARDOUR_SURFACES_PATH` directory and `dlopen`d by
# Ardour at startup, identically to Mackie / OSC / Generic MIDI. The
# Ardour source tree is untouched; we only link against its built
# libraries under `build/libs/`.
#
# Requires a sibling Ardour tree to be configured + built at least
# once (`just ardour-configure && just ardour-build`). When Ardour
# ships `ardour-surface.pc` upstream this will flip to
# `find_package(Ardour)` and we'll drop the source-tree dependency.
#
# Earlier iterations of this project had a `shim-link`/`shim-unlink`
# pair that symlinked the shim directory into Ardour's `libs/surfaces/`
# so Ardour's waf build would include it as an in-tree target. That
# workflow was removed on 2026-04-20 because it conflicts with the
# "don't fork Ardour, keep its commercial build pristine" posture
# documented in [docs/DECISIONS.md#18] — building the shim into
# Ardour's tree means the Ardour binary we ship is a MODIFIED version
# of Ardour, which has license + commercial implications. Standalone
# is the one true path; if you find yourself wanting an in-tree build
# for faster iteration, read Decision 18 first.
shim_dir := justfile_directory() + "/shims/ardour"
shim_build_dir := shim_dir + "/cmake-build"

shim-configure:
    cmake -S {{shim_dir}} -B {{shim_build_dir}} \
          -DCMAKE_BUILD_TYPE=RelWithDebInfo \
          -DFOYER_ARDOUR_SOURCE={{ardour_dir}}

shim-build: shim-configure
    cmake --build {{shim_build_dir}} -j

# Install the .so into a user-scoped Ardour surfaces dir. Ardour's
# `control_protocol_search_path()` scans `$HOME/.config/ardour<N>/surfaces/`
# (see libs/ardour/search_paths.cc) plus anything in `ARDOUR_SURFACES_PATH`,
# so this location works with zero env var tweaks. Override DEST for
# system-wide installs or isolated test configs.
#
# Always rebuilds via `shim-build` (CMake incremental is fast when the
# tree hasn't changed, ~1.7 s). For a true no-op-when-current check
# used by `run` / `run-ardour`, see `shim-check`.
shim-install DEST="$HOME/.config/ardour9": shim-build
    mkdir -p "{{DEST}}/surfaces"
    cp {{shim_build_dir}}/libfoyer_shim.so "{{DEST}}/surfaces/"
    echo "✓ Installed libfoyer_shim.so → {{DEST}}/surfaces/"
    echo "  Ardour will dlopen it at next startup — no env vars needed."

# Ensure the installed shim is present and current; short-circuit
# when it is. Used as a dep by `run` / `run-ardour` / `shim-e2e` /
# `ardour-hardev` so every recipe that spawns hardour auto-discovers
# a missing or stale shim without paying the ~1.7 s CMake-incremental
# cost when nothing needs updating.
#
# "Current" = installed .so mtime >= every source file under shims/ardour.
# If the source tree or CMakeLists.txt has been touched since last
# install, we fall through to `shim-install`.
shim-check:
    #!/usr/bin/env bash
    set -uo pipefail
    INSTALLED="$HOME/.config/ardour9/surfaces/libfoyer_shim.so"
    SRC_ROOT="{{shim_dir}}"
    if [ ! -e "$INSTALLED" ]; then
        echo "shim-check: not installed → building + installing"
        exec just shim-install
    fi
    # Find any source file newer than the installed .so. -newer uses
    # mtime comparison; we cover src/, CMakeLists.txt, and the linked
    # libfoyer_shim.so in the build dir itself (so a manual cmake
    # rebuild without install is noticed).
    NEWER=$(find "$SRC_ROOT/src" "$SRC_ROOT/CMakeLists.txt" \
                 "{{shim_build_dir}}/libfoyer_shim.so" \
                 -newer "$INSTALLED" 2>/dev/null | head -1)
    if [ -n "$NEWER" ]; then
        echo "shim-check: stale (newer: $NEWER) → rebuilding"
        exec just shim-install
    fi
    echo "shim-check: up to date"

shim-clean:
    rm -rf {{shim_build_dir}}

# One-shot: rebuild + install + report what Ardour will load.
shim: shim-install
    @echo ""
    @echo "Next step:"
    @echo "  Start Ardour (fresh process — it only scans surfaces at startup)"
    @echo "  Verify load: tail Ardour's startup output for 'FoyerShim' or"
    @echo "  check dlopen-level with:"
    @echo "    LD_DEBUG=files <ardour-launch> 2>&1 | grep foyer_shim"

# --- JACK (audio server required by Ardour's default backend) ---
#
# Why JACK + dummy driver: hardour's default backend is "JACK/Pipewire".
# In the dev container we don't have Pipewire or a real audio device,
# so we run `jackd -d dummy` which simulates an audio device at a chosen
# sample rate + buffer size. Ardour connects to the JACK server via a
# socket in /dev/shm and gets a steady run()/silence() cadence — exactly
# what our MasterTap processor needs.
#
# Privileged-container requirement: JACK tries SCHED_FIFO + mlock for
# realtime behavior; without --privileged those calls fail and JACK
# falls back to non-realtime mode (which still works for dummy). See
# devcontainer.json's runArgs.
#
# Runs in the background (`run_in_background` in the recipe below).
# `just jack-stop` kills it. `just jack-status` reports.
jack-dummy:
    #!/usr/bin/env bash
    set -uo pipefail
    if pgrep -x jackd > /dev/null; then
        echo "jackd already running (pid $(pgrep -x jackd))"
        exit 0
    fi
    # Sweep stale shm segments left behind by a hard-killed jackd.
    # Restart-after-stop races kernel cleanup; explicit sweep avoids
    # "server already active" on startup. Glob is broad but safe —
    # only jackd itself owns these paths.
    rm -rf /dev/shm/jack-"$(id -u)" /dev/shm/jack_default_* 2>/dev/null || true
    # Realtime mode (`-R`) is the default and works now that the
    # devcontainer grants `rtprio=95 / memlock=-1` via Docker's
    # --ulimit. JACK's callback thread runs on SCHED_FIFO so
    # Ardour's process graph meets its deadlines reliably, and
    # libardour can lock its ~107 MB audio graph against paging.
    #
    # Priority 10 leaves plenty of headroom for OS-level RT tasks
    # (max is typically 99 on Linux). Buffer 1024 @ 48 kHz ≈ 21 ms
    # — a comfortable middle ground: small enough that monitoring
    # latency isn't noticeable, large enough that the Colima VM's
    # 9p filesystem hiccups and cross-VM scheduling jitter don't
    # trigger xruns. Drop to 256 or 128 on bare-metal Linux for
    # real tracking-grade latency.
    echo "Starting jackd -R -d dummy @ 48 kHz, 720-sample buffer (~30 ms)…”
    jackd -R -P 10 -d dummy -r 48000 -p 720 -n default > /tmp/jackd.log 2>&1 &
    # Poll for process + short settle time. jackd clients block on
    # connect until the server is actually ready, so we don't need
    # to sniff the log — existence + a beat is enough.
    for _ in {1..20}; do
        pgrep -x jackd > /dev/null && break
        sleep 0.1
    done
    sleep 0.3
    if pgrep -x jackd > /dev/null; then
        echo "✓ jackd up (pid $(pgrep -x jackd)) — log at /tmp/jackd.log"
    else
        echo "✗ jackd failed to start — check /tmp/jackd.log"
        tail /tmp/jackd.log
        exit 1
    fi

jack-stop:
    #!/usr/bin/env bash
    set -uo pipefail
    if pgrep -x jackd > /dev/null; then
        pkill -TERM -x jackd || true
        # Wait briefly for the process to clear + sweep shm so the
        # next `jack-dummy` doesn't hit "server already active".
        for _ in {1..20}; do
            pgrep -x jackd > /dev/null || break
            sleep 0.1
        done
        rm -rf /dev/shm/jack-"$(id -u)" /dev/shm/jack_default_* 2>/dev/null || true
        echo "✓ jackd stopped"
    else
        echo "(jackd not running)"
    fi

jack-status:
    @pgrep -x jackd > /dev/null && echo "jackd running (pid $(pgrep -x jackd))" || echo "jackd not running"

# --- cleanup ---
# Kill DAW processes only — NOT the Foyer sidecar. Use this when a
# Listen click left an orphan hardour behind or when Ardour's exit
# didn't stick; the sidecar keeps running so the next `just run` is
# a no-op and your browser tab doesn't even need a reload.
#
# Kills — by exact name match:
#   · hardour-9.2.583, ardour, ardour-9.2  (the DAW)
#
# Used to also kill the `foyer` CLI itself (the sidecar binary is
# literally named `foyer`). That was a foot-gun — Rich hit it on
# 2026-04-22: running kill-daws to clean up a stuck Ardour took out
# foyer-server too and forced a full re-launch. Split the "nuke
# everything including the sidecar" story into `just kill-all`.
#
# Plus removes stale shim socket + advertisement files under
# /tmp/foyer/ so a subsequent Ardour launch doesn't hit "advertised
# shim at /tmp/foyer/ardour-<pid>.sock is stale (connect: Connection
# refused)". Also sweeps leftover registry entries under
# ~/.local/share/foyer/sessions/ whose pids are now dead — Foyer's
# orphan detection handles those gracefully, but a clean sweep
# after a hard kill keeps the welcome screen from showing ghost
# "crashed" sessions forever.
kill-daws:
    #!/usr/bin/env bash
    set -u
    killed=0
    for name in hardour-9.2.583 ardour ardour-9.2; do
        pids=$(pgrep -x "$name" || true)
        if [ -n "$pids" ]; then
            echo "Killing $name: $pids"
            kill -TERM $pids 2>/dev/null || true
            killed=$((killed + $(echo "$pids" | wc -w)))
        fi
    done
    # Give SIGTERM a moment, then SIGKILL anything still breathing.
    sleep 1
    for name in hardour-9.2.583 ardour ardour-9.2; do
        pids=$(pgrep -x "$name" || true)
        if [ -n "$pids" ]; then
            echo "SIGKILL $name: $pids"
            kill -KILL $pids 2>/dev/null || true
        fi
    done
    # Clear shim advertisement files + stale Unix sockets so the next
    # Ardour launch starts from a clean slate.
    rm -f /tmp/foyer.sock /tmp/foyer/ardour-*.sock /tmp/foyer/ardour-*.json 2>/dev/null || true
    # Sweep session registry entries whose pids are dead. The sidecar
    # would otherwise keep them around as "crashed" orphans until the
    # user dismissed each one from the welcome screen — fine in
    # theory, noisy after a hard kill.
    reg="${XDG_DATA_HOME:-$HOME/.local/share}/foyer/sessions"
    if [ -d "$reg" ]; then
        for f in "$reg"/*.json; do
            [ -e "$f" ] || continue
            pid=$(grep -oE '"pid":[[:space:]]*[0-9]+' "$f" | head -1 | grep -oE '[0-9]+' || echo 0)
            if [ "${pid:-0}" -gt 0 ] && [ ! -d "/proc/$pid" ]; then
                rm -f "$f"
            fi
        done
    fi
    remaining=$(ps -eo pid,comm | awk '$2 ~ /^h?ardour/ {print $1}' | head)
    if [ -z "$remaining" ]; then
        echo "✓ clean — no DAW processes and no stale sockets"
    else
        echo "⚠ still running: $remaining"
    fi

# --- nuke everything, including the Foyer sidecar ---
# Use when you want a completely cold restart: DAWs + sidecar + all
# sockets + all registry entries. Your browser tab WILL need a
# reload after this since foyer-server itself is going away.
kill-all: kill-daws
    #!/usr/bin/env bash
    set -u
    for name in foyer; do
        pids=$(pgrep -x "$name" || true)
        if [ -n "$pids" ]; then
            echo "Killing $name: $pids"
            kill -TERM $pids 2>/dev/null || true
        fi
    done
    sleep 1
    for name in foyer; do
        pids=$(pgrep -x "$name" || true)
        if [ -n "$pids" ]; then
            echo "SIGKILL $name: $pids"
            kill -KILL $pids 2>/dev/null || true
        fi
    done
    # Sidecar gone → wipe the whole session registry; anything left
    # is definitionally orphaned and there's no sidecar around to
    # surface it anyway.
    reg="${XDG_DATA_HOME:-$HOME/.local/share}/foyer/sessions"
    [ -d "$reg" ] && rm -f "$reg"/*.json 2>/dev/null || true
    echo "✓ full reset — reload your browser tab"

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

# Launch hardour against the session with the standalone foyer_shim .so on
# the surfaces path. The shim still needs `<Protocol name="Foyer Studio Shim"
# active="1"/>` in the .ardour XML for a given session — Ardour's
# control-surface registry is a two-step process (dlopen the .so, then
# enable-per-session). `shim-e2e` below adds that XML snippet automatically.
ardour-hardev name="foyer-smoke": jack-dummy shim-check
    #!/usr/bin/env bash
    set -eo pipefail
    export TOP={{ardour_dir}}
    source {{ardour_dir}}/build/gtk2_ardour/ardev_common_waf.sh
    export ARDOUR_SURFACES_PATH="{{shim_build_dir}}:${ARDOUR_SURFACES_PATH}"
    rm -f /tmp/foyer.sock
    exec {{ardour_dir}}/build/headless/hardour-9.2.583 {{session_dir}} {{name}}

# Full E2E: creates a session (if missing), launches hardour with the
# standalone foyer_shim.so on the surfaces path, connects foyer-cli with
# --backend=host, reports success/failure. Call after `just ardour-build`
# (once, for the linked libraries) + `just shim-build` (the standalone .so).
shim-e2e: jack-dummy shim-check
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
    export ARDOUR_SURFACES_PATH="{{shim_build_dir}}:${ARDOUR_SURFACES_PATH}"
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
