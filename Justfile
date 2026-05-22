set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @echo "Top-level recipes:"
    @just --list
    @echo ""
    @echo "Subcommands:"
    @./scripts/dev/ardour.sh help
    @./scripts/dev/autovocoder.sh help
    @./scripts/dev/shim.sh help
    @./scripts/dev/tw.sh help
    @./scripts/dev/jack.sh help

prep:
    mkdir -p sessions/
    ./scripts/dev/tw.sh check
    ./scripts/dev/ardour.sh ensure
    ./scripts/dev/autovocoder.sh ensure
    ./scripts/dev/jack.sh start
    ./scripts/dev/shim.sh check
    ./scripts/dev/nuke-web-install.sh

# JACK + GUI Ardour path. Use `just run` (libardour Dummy backend) if
# you don't have a privileged container or don't need real audio — that
# was historically `just run-dummy` and is now the default.
run-jack *args='': prep
    #!/usr/bin/env bash
    # Explicit --web-root so the dev loop edits the repo tree, not the
    # installed copy under $XDG_DATA_HOME/foyer/web. Without a flag the
    # binary always serves the install dir (that's the canonical
    # hackability target; see web/HACKING.md).
    #
    # Set FOYER_WEB_OVERLAY to a sibling dir (or colon-separated list)
    # to layer your own UI variants on top of the main tree — no edits
    # to this repo's web/ needed. The server checks overlays first
    # (earlier entry = higher priority), falls back to --web-root, and
    # /variants.json scans all of them so any `ui-*/` folders in an
    # overlay appear automatically in boot.js. See DEVELOPMENT.md.
    overlay_args=()
    if [ -n "${FOYER_WEB_OVERLAY:-}" ]; then
        IFS=':' read -r -a _overlays <<< "$FOYER_WEB_OVERLAY"
        for ol in "${_overlays[@]}"; do
            [ -z "$ol" ] && continue
            overlay_args+=("--web-overlay" "$ol")
        done
    fi
    cargo run --bin foyer -- serve \
        --listen 0.0.0.0:3838 \
        --web-root web \
        "${overlay_args[@]}" \
        {{args}}

# Run the binary the way an end user does: without `--web-root`, so
# foyer extracts its bundled web/ to `$XDG_DATA_HOME/foyer/web/` on
# first boot and serves from there. `prep` already nukes any existing
# extract via `scripts/dev/nuke-web-install.sh`, so each `just
# run-static` cycle re-bakes the bundle and re-extracts cleanly —
# ideal for testing JS changes through the actual ship-path
# (include_dir! → extract → serve) before cutting a static binary.
#
# Why this exists separate from `just run`: `just run` deliberately
# bypasses extract via `--web-root web` so dev iteration is
# immediate. `just run-static` exercises the path real users hit
# (and where stale extracts have bitten before — the bundled tree
# is hackable per web/HACKING.md and edits survive restarts, which
# is great for users but means a freshly-rebuilt binary doesn't
# automatically refresh someone else's hacked copy).
#
# `FOYER_BUNDLE_WATCH_DEBUG=1`: debug builds normally use an empty
# stub tree for `include_dir!` so JS edits don't trigger a 20 s
# rebuild every iteration (see build.rs). This recipe opts back in
# so the bundled tree is actually populated. First build after
# enabling is slower; subsequent builds are incremental.
run-static *args='': prep
    FOYER_BUNDLE_WATCH_DEBUG=1 cargo build --bin foyer
    ./target/debug/foyer serve --listen 0.0.0.0:3838 {{args}}

# Default dev loop. Run with the libardour Dummy backend instead of
# JACK. Mirrors the Cloud Run / non-privileged-container audio path
# locally — no jackd, no realtime scheduling, GUI Ardour painting onto
# an in-container Xvfb that nobody's watching. Useful for:
#   * replicating Cloud Run boot end-to-end before pushing
#   * quick-iteration UI work where you don't need real audio
#   * showing the project to someone without configuring JACK
#
# Differences from `just run-jack`:
#   * does NOT start jackd (`scripts/dev/jack.sh stop` if it's up)
#   * starts an Xvfb on :99 if no $DISPLAY is set
#   * seeds ~/.config/ardour9/{.a9,config} so Ardour autostarts the
#     Dummy backend with the Silence device — no welcome wizard,
#     no AMS dialog. Existing config files are NEVER overwritten.
run *args='':
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p sessions/
    # Same prep work as `prep` but without `scripts/dev/jack.sh start`.
    # If jackd is already running from a prior `just run-jack`, stop it
    # so there's no JACK socket on /dev/shm tempting Ardour to pick the
    # JACK backend instead of Dummy.
    ./scripts/dev/tw.sh check
    ./scripts/dev/ardour.sh ensure
    ./scripts/dev/autovocoder.sh ensure
    ./scripts/dev/shim.sh check
    ./scripts/dev/nuke-web-install.sh
    ./scripts/dev/jack.sh stop 2>/dev/null || true

    # Bring up xpra (which manages its own Xvfb) so you can peek at
    # Ardour's display via http://127.0.0.1:14500 — useful when
    # debugging plugin window placement, etc. If xpra is already on
    # :99 (e.g. you started it manually), leave it alone. The X11
    # socket file is the cheap idempotency check; bare bash, no
    # procps needed.
    #
    # Readiness signal: xpra's bind-tcp port on 14500. xpra 6+ runs
    # Xvfb with abstract sockets (kernel namespace, no file under
    # /tmp/.X11-unix/), so the older "is the X11 socket file there"
    # check is unreliable. The TCP listen socket is what we actually
    # need (proxy + html5 client both go through it) AND it's a
    # binary signal — either listening or not.
    if (echo > /dev/tcp/127.0.0.1/14500) 2>/dev/null; then
        echo "xpra already listening on :14500 — reusing"
    else
        # Belt + braces: kill any half-alive xpra processes that
        # stopped serving but didn't fully exit. Without this the
        # next `xpra start` hits "Address already in use" if the
        # listener is gone but the X server child is hung.
        for p in /proc/[0-9]*; do
            [ -r "$p/cmdline" ] || continue
            cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
            case "$cmd" in
                *"/usr/bin/xpra start :99"*)
                    pid=$(basename "$p")
                    echo "killing zombie xpra pid=$pid"
                    kill -TERM "$pid" 2>/dev/null || true
                    ;;
            esac
        done
        sleep 1
        for p in /proc/[0-9]*; do
            [ -r "$p/cmdline" ] || continue
            cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
            case "$cmd" in
                *"/usr/bin/xpra start :99"*)
                    kill -KILL "$(basename "$p")" 2>/dev/null || true
                    ;;
            esac
        done
        # Clean state files in case any are stale.
        rm -rf /tmp/.X11-unix/X99 /tmp/xpra/99 \
               "$HOME/.xpra/$(hostname)-99" 2>/dev/null || true

        if command -v xpra >/dev/null 2>&1; then
            echo "starting xpra on :99 (peek at http://127.0.0.1:14500)"
            # `--auth=none --tcp-auth=none --ws-auth=none` matter:
            # newer xpra (19+) defaults to demanding credentials on
            # all socket types. The HTML5 client connects via
            # WebSocket (NOT raw TCP), so `--ws-auth=none` is the
            # load-bearing flag — without it the client cycles
            # through "loading → login → disconnect" forever even
            # when --tcp-auth is permissive. We're binding to
            # localhost only, and the only client is foyer's
            # same-origin /ws/plugin-gui proxy, so anonymous-allow
            # is the correct posture here.
            # `--resize-display=no` is load-bearing here. Defaults
            # let the client shrink the Xvfb to whatever the iframe
            # canvas size is — when the user resizes the Foyer
            # panel small, Xvfb shrinks, then Ardour's editor pops
            # "this screen is not tall enough to display the
            # editor mixer". Locking Xvfb at 1920x1280 means
            # Ardour always has room; the iframe just shows a
            # downscaled view of whatever's in that area, and
            # our title-filter only paints the matched plugin
            # window full-bleed so the visual stays clean.
            xpra start :99 \
                --bind-tcp=127.0.0.1:14500 --html=on \
                --auth=none --tcp-auth=none --ws-auth=none \
                --start-via-proxy=no --no-pulseaudio --no-mdns \
                --no-daemon \
                --dpi=96 --resize-display=no \
                --xvfb="Xvfb +extension Composite +extension DAMAGE +extension RANDR -screen 0 1920x1280x24+32 -nolisten tcp -noreset -dpi 96" \
                >/tmp/foyer-xpra.log 2>&1 &
        else
            # Fallback: bare Xvfb. Ardour's display works, but no
            # browser peek. Install xpra to get the HTML5 client:
            #   sudo apt install -y xpra xpra-html5
            echo "xpra not on PATH — falling back to bare Xvfb (no browser peek)"
            Xvfb :99 -screen 0 1280x720x24 -nolisten tcp \
                >/tmp/foyer-xvfb.log 2>&1 &
        fi
        # Wait for the readiness signal. xpra: TCP 14500 listening
        # (works whether Xvfb uses abstract sockets or file-based —
        # xpra 6+ uses abstract). Bare Xvfb fallback: the X11 socket
        # file is the only signal we have. Up to 5s.
        ready=0
        for _ in $(seq 1 50); do
            if (echo > /dev/tcp/127.0.0.1/14500) 2>/dev/null; then
                ready=1; break
            fi
            if [ -e /tmp/.X11-unix/X99 ]; then
                ready=1; break
            fi
            sleep 0.1
        done
        if [ "$ready" -eq 0 ]; then
            echo "ERROR: X server didn't bind :99 within 5s — check /tmp/foyer-xpra.log or /tmp/foyer-xvfb.log" >&2
            exit 1
        fi
    fi
    export DISPLAY=:99

    # Seed Ardour config (idempotent — won't clobber existing files).
    ./scripts/runtime/seed-ardour-config.sh --ams-dummy

    # Force foyer-config to re-detect the right binary now that
    # DISPLAY is set — without this, a previous `just run-jack` cached
    # `headless/hardour-9.x.x` and we'd skip past GUI Ardour.
    cfg="${XDG_DATA_HOME:-$HOME/.local/share}/foyer/config.yaml"
    # Resolve ARDOUR_DIR with the same priority as scripts/dev/ardour.sh
    REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -n "${FOYER_ARDOUR_DIR:-}" ]; then
        ARDOUR_DIR="$FOYER_ARDOUR_DIR"
    elif [ -d "$REPO_ROOT/ext/ardour" ]; then
        ARDOUR_DIR="$REPO_ROOT/ext/ardour"
    else
        ARDOUR_DIR="/workspaces/ardour"
    fi
    if [ -f "$cfg" ] && ! grep -q "gtk2_ardour" "$cfg"; then
        rm -f "$cfg"
        FOYER_ARDOUR_BUILD_ROOT="$ARDOUR_DIR" \
            cargo run --bin foyer -- configure --force >/dev/null
    fi

    # Export the dev-tree paths so the spawner's `load_ardour_dev_env`
    # picks them up without re-detecting from the binary location.
    # Lets contributors with non-canonical layouts swap in a tree by
    # setting FOYER_ARDOUR_DIR without us baking paths into Rust.
    export FOYER_ARDOUR_DEV_TREE="$ARDOUR_DIR"
    export FOYER_ARDOUR_SHIM_DIR="$ARDOUR_DIR/build/libs/surfaces/foyer_shim"

    cargo run --bin foyer -- serve \
        --listen 0.0.0.0:3838 \
        --web-root web \
        --backend ardour \
        {{args}}

run-tls *args='': prep
    #!/usr/bin/env bash
    tls_dir="${XDG_DATA_HOME:-$HOME/.local/share}/foyer/tls"
    mkdir -p "$tls_dir"
    cert="$tls_dir/dev.pem"
    key="$tls_dir/dev-key.pem"
    if [ ! -f "$cert" ] || [ ! -f "$key" ]; then
        echo "Generating self-signed cert at $tls_dir/"
        san_lines=("DNS:localhost" "IP:127.0.0.1" "IP:::1")
        for ip in $(hostname -I 2>/dev/null); do
            case "$ip" in
                127.*|172.17.*|172.18.*|172.19.*|172.20.*) continue ;;
            esac
            san_lines+=("IP:$ip")
        done
        san_joined=$(IFS=,; echo "${san_lines[*]}")
        openssl req -x509 -newkey rsa:2048 -nodes             -days 365             -keyout "$key" -out "$cert"             -subj "/CN=foyer-dev"             -addext "subjectAltName=$san_joined"             2>/dev/null
        echo "SAN: $san_joined"
    fi
    cargo run --bin foyer -- serve         --listen 0.0.0.0:3838         --tls-cert "$cert" --tls-key "$key"         --web-root web         {{args}}

# Kill any stray Ardour / hardour processes plus the auxiliary
# session_utils binaries (ardour9-new_empty_session, etc.). Useful
# when:
#   * `just run` left orphans behind after a Ctrl-C → next launch
#     can't bind shim's discovery socket because the old shim is
#     still holding it
#   * the Audio/MIDI Setup dialog stuffed an ardour-9.x.x and the
#     X11 session won't take a new one until it's gone
#   * you want to restart cleanly without restarting the whole
#     dev container
#
# Matches on `/proc/<pid>/comm` (executable basename), NOT cmdline,
# so it won't accidentally nuke a shell whose `bash -c` argument
# mentioned the word "ardour". TERM first, then KILL anything that
# survived a 2s grace period.
kill-daws:
    #!/usr/bin/env bash
    set -uo pipefail
    # Match patterns:
    #   * ardour-9.x.x / hardour-9.x.x / ardour9 / hardour9 — original
    #     filenames before exec
    #   * ArdourGUI — Ardour calls prctl(PR_SET_NAME, "ArdourGUI") after
    #     launch, so /proc/<pid>/comm reads that. Same for any
    #     "Ardour*" prctl variant a future build might set.
    #   * ardour9-new_empty_session — the bootstrap helper
    is_daw() {
        case "$1" in
            ardour-9*|hardour-9*|ardour9|hardour9|ardour9-new_empty*) return 0 ;;
            Ardour*) return 0 ;;
        esac
        return 1
    }
    matched=0
    for p in /proc/[0-9]*; do
        [ -r "$p/comm" ] || continue
        comm=$(cat "$p/comm" 2>/dev/null)
        if is_daw "$comm"; then
            pid=$(basename "$p")
            echo "TERM $pid ($comm)"
            kill -TERM "$pid" 2>/dev/null || true
            matched=1
        fi
    done
    if [ "$matched" -eq 0 ]; then
        echo "no ardour / hardour processes running"
        exit 0
    fi
    sleep 2
    for p in /proc/[0-9]*; do
        [ -r "$p/comm" ] || continue
        comm=$(cat "$p/comm" 2>/dev/null)
        if is_daw "$comm"; then
            pid=$(basename "$p")
            echo "KILL $pid ($comm) — survived TERM"
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done
    # Stale shim discovery sockets in $XDG_RUNTIME_DIR / /tmp/foyer.
    # Foyer-cli's `discovery::scan` ignores broken sockets but
    # cleans them up only on the next successful spawn — pre-emptive
    # rm here so a fresh `just run` doesn't trip over yesterday's
    # entries.
    rm -f /tmp/foyer/ardour-*.{json,sock} 2>/dev/null || true
    rm -f "${XDG_RUNTIME_DIR:-/tmp}/foyer/ardour-*.{json,sock}" 2>/dev/null || true
    echo "kill-daws: done"

# Sweep Ardour's crash-recovery breadcrumbs (`*.pending`, `*.history`)
# out of every session under the configured FOYER_JAIL plus the
# `sessions/` dev tree. Without this Ardour blocks at session load
# with a "This session appears to have been modified without save…
# Recover from crash / Ignore" dialog — fatal in container deploys
# where there's no human to click. Files are archived to
# /tmp/foyer-crash-recovery-<stamp>.tar.gz before removal so you can
# extract them later if the recovery state was actually wanted.
#
# Usage: just clear-crash
#
# Pair with kill-daws when un-sticking a frozen launch:
#   just kill-daws clear-crash
clear-crash:
    #!/usr/bin/env bash
    set -uo pipefail
    stamp=$(date +%Y%m%d-%H%M%S)
    archive="/tmp/foyer-crash-recovery-$stamp.tar.gz"
    # Search the dev sessions tree + the configured jail + the
    # docker default `/projects`. Skip dirs that don't exist.
    roots=()
    for r in "$(pwd)/sessions" /projects "${FOYER_JAIL:-}" /workspaces; do
        [ -n "$r" ] && [ -d "$r" ] && roots+=("$r")
    done
    if [ "${#roots[@]}" -eq 0 ]; then
        echo "no session roots found — nothing to do"
        exit 0
    fi
    # NUL-delimited so spaces in session names don't break us
    # (`xargs -r` whitespace-splits otherwise).
    mapfile -d '' -t files < <(
        find "${roots[@]}" -maxdepth 5 \
             \( -name '*.pending' -o -name '*.history' \) \
             -print0 2>/dev/null
    )
    if [ "${#files[@]}" -eq 0 ]; then
        echo "no crash-recovery files found"
        exit 0
    fi
    echo "archiving ${#files[@]} files → $archive"
    printf '%s\n' "${files[@]}" | sed 's/^/  /'
    printf '%s\0' "${files[@]}" | tar czf "$archive" --null --files-from=- 2>&1 \
        | grep -v "Removing leading" || true
    for f in "${files[@]}"; do
        rm -v "$f"
    done
    echo "---"
    echo "archive: $archive"

clippy:
    cargo clippy --workspace --all-targets -- -D warnings

fmt-check:
    cargo fmt --all -- --check

# Apply every autofixer that resolves a `just verify` failure
# (formatting, lint auto-fixes, etc.) AND then run `just verify` so
# the same gate CI runs is what gates a local push. Without the
# verify chain `just ci` was a write-only autofix that didn't catch
# what it couldn't fix — e.g. a clippy error landed in CI on
# 2026-04-28 because the dev had run `just ci` and assumed it was
# enough. Now `just ci` is the one-shot "make it green" command.
ci: && verify
    cargo fmt --all
    @echo "✅ ci: autofixers applied — running verify…"

test:
    cargo test --workspace --all-targets

e2e:
    ./scripts/dev/shim.sh e2e

# Smoke-check the /v1 OpenAI-compat endpoint against a running foyer
# (default 127.0.0.1:3838). Verifies /v1/models advertises foyer-agent,
# non-streaming completion uses a tool, and streaming emits [DONE].
# Set FOYER_BASE=http://other-host:3838 to target a different host.
agent-v1-smoke:
    python3 ./scripts/dev/agent-v1-smoke.py

# Deep multi-turn drive of the /v1 endpoint — runs an 8-turn music-making
# workflow that exercises session lifecycle (new/close/reopen), heavy
# visualization-tool use (compaction stress), and the drum-vs-piano
# regression (drums must use GM drum MIDI, not piano-range notes).
# Takes 5–15 minutes against a working LLM upstream. Set FOYER_BASE /
# FOYER_SESSION to override defaults.
agent-v1-e2e:
    python3 ./scripts/dev/agent-v1-e2e.py

# Hardware I/O smoke test over MCP: enumerate engine ports, route a track
# input, arm record. No LLM in the loop — direct tools/call. Works against
# stub (synthetic ports) or Ardour (real JACK ports). Set SESSION=… to
# pick the project session.open should target.
agent-io-record-arm:
    python3 ./scripts/dev/agent-io-record-arm.py

# Run the Playwright UI smoke suite. By default assumes a server is
# already on 127.0.0.1:3838 — quick to iterate when you're already
# running `just run`. Pass `--auto-serve` (or set FOYER_AUTO_SERVE=1)
# to spin up a short-lived stub server for the tests. Extra args
# forward to Playwright (e.g. `just test-ui smoke.spec.js`).
test-ui *args='':
    ./scripts/dev/ui-test.sh {{args}}

# Boot a stub server in the background, run test-ui against it, kill.
# This is the form CI uses — no shim, no Ardour, no JACK needed, just
# exercises the browser + Rust server boundary. Exits with the
# Playwright exit code.
#
# Set FOYER_BIN=/path/to/foyer to skip the cargo build and use a
# prebuilt binary instead — the GitHub Actions ui-smoke job uses this
# to consume the binary the rust job already built.
test-ui-ci:
    #!/usr/bin/env bash
    set -euo pipefail
    bin="${FOYER_BIN:-./target/debug/foyer}"
    if [ -n "${FOYER_BIN:-}" ] && [ ! -x "$FOYER_BIN" ]; then
        echo "FOYER_BIN=$FOYER_BIN is not executable — refusing to fall back to a build" >&2
        exit 1
    fi
    # ALWAYS rebuild when FOYER_BIN isn't explicitly pinned. Earlier
    # revisions gated this on `[ ! -x "$bin" ]`, which only rebuilt
    # when the binary was missing. A stale `./target/debug/foyer`
    # from before a WS-schema change would then silently run against
    # source that had moved on — the failure mode was identical to
    # "tests run but the new Command variant goes unrecognized,"
    # which is exactly the flake we hit on the test_reset_state
    # plumbing. Cargo's incremental compilation makes the
    # no-op path ~0.5 s anyway.
    if [ -z "${FOYER_BIN:-}" ]; then
        cargo build --bin foyer
    fi
    # Sanity: print binary metadata so a CI log shows what we're
    # about to launch (helps when "ERR_CONNECTION_REFUSED" is the
    # only signal Playwright gives us).
    echo "==> launching $bin"
    file "$bin" || true
    "$bin" --version 2>&1 || echo "(no --version, proceeding)"
    # Use the repo's working web/ so CI validates the tree that just
    # got committed — NOT whatever happens to be extracted in the
    # runner's $XDG_DATA_HOME. Without this flag the CLI serves the
    # install dir (the canonical hackability target for users).
    log=/tmp/foyer-ci.log
    "$bin" serve \
        --backend stub --listen 127.0.0.1:3838 --web-root web \
        > "$log" 2>&1 &
    server_pid=$!
    trap "kill $server_pid 2>/dev/null || true" EXIT
    # Poll readiness — and FAIL LOUD when it never comes up. Previous
    # version proceeded to Playwright regardless, which buried the
    # actual error (panic, missing libc dep, port collision, etc.) in
    # `ERR_CONNECTION_REFUSED` from the test side.
    ready=0
    for _ in $(seq 1 30); do
        if curl -fsS -o /dev/null http://127.0.0.1:3838/ 2>/dev/null; then
            ready=1
            break
        fi
        # Bail early if the server already exited.
        if ! kill -0 "$server_pid" 2>/dev/null; then
            break
        fi
        sleep 0.5
    done
    if [ "$ready" -ne 1 ]; then
        echo "==> foyer never bound 127.0.0.1:3838" >&2
        echo "==> server_pid=$server_pid alive? $(kill -0 "$server_pid" 2>/dev/null && echo yes || echo no)" >&2
        echo "==> --- $log ---" >&2
        cat "$log" >&2 || true
        echo "==> --- end log ---" >&2
        exit 1
    fi
    ./scripts/dev/ui-test.sh

# Full gate — mirrors what CI runs on a PR. Any failure = not ready
# to merge. Runs fmt + clippy + cargo test + UI smoke back-to-back so
# a single `just verify` locally matches a green check on the PR.
# The companion `just ci` recipe applies autofixers (fmt, etc.) for
# anything in here that has a writeable counterpart.
verify: fmt-check clippy test test-ui-ci
    @echo "✅ verify: clean"

# Drive the live UI from the CLI — screenshot, click, eval JS, probe
# store state. Useful for scripting reproducers and remote-control
# agents that can't open a browser themselves.
#   just ui-probe screenshot /tmp/foyer.png
#   just ui-probe eval 'window.__foyer.store.state.status'
#   just ui-probe click 'foyer-main-menu button'
ui-probe *args='':
    ./scripts/dev/ui-probe.sh {{args}}

# Walk every t() / tn() / tr!() / tn!() / loc!() call site, harvest
# the source-language keys, and write them to
# `web/locales/_template.json`. Per-locale catalogs (`es.json`, …)
# are checked against this template; missing keys + orphaned keys
# are reported but never auto-deleted. Run after wrapping new
# strings to surface them to translators.
i18n-extract:
    ./scripts/dev/i18n-extract.sh

config-reset:
    #!/usr/bin/env bash
    cfg_path="$(cargo run --bin foyer -- config-path | awk 'NF { line=$0 } END { print line }')"
    if [ -n "$cfg_path" ] && [ -f "$cfg_path" ]; then
        rm -f "$cfg_path"
        echo "Removed $cfg_path"
    fi
    cargo run --bin foyer -- configure --force

tw-build:
    ./scripts/dev/tw.sh build

# Build a release zip for the host platform. Mirrors what the
# `release.yml` matrix does on each runner — useful for sanity-checking
# the bundle layout, or for cutting an unsigned local build to hand to
# someone on the same OS/arch.
#
# Requires: a built Ardour (just ardour ensure) and a built shim.
# Override the Ardour tag with: ARDOUR_TAG=9.1.0 just release-bundle
# Build a release bundle that matches what CI ships:
#   * Linux: `*-unknown-linux-musl` + `+crt-static` + static libopus →
#     fully self-contained (zero .so deps).
#   * macOS: standard apple target + static libopus (libSystem.dylib
#     is always linked dynamically and that's by design).
#
# `cargo build` / `just run` are deliberately NOT this — local dev
# stays fast on glibc + dynamic libopus. Only this recipe pays the
# libopus-from-source build tax.
#
# Linux requires `musl-tools` (apt) for `musl-gcc`. The recipe checks
# and aborts with a clear hint if missing.
release-bundle:
    #!/usr/bin/env bash
    set -euo pipefail
    ./scripts/dev/tw.sh build

    case "$(uname -s)" in
        Linux)
            arch_triple="$(uname -m)-unknown-linux-musl"
            if ! command -v musl-gcc >/dev/null 2>&1; then
                echo "release-bundle: missing musl-gcc — install with:" >&2
                echo "    sudo apt-get install -y musl-tools" >&2
                exit 1
            fi
            rustup target add "$arch_triple" >/dev/null 2>&1 || true
            export CC=musl-gcc
            export CC_x86_64_unknown_linux_musl=musl-gcc
            export CC_aarch64_unknown_linux_musl=musl-gcc
            export RUSTFLAGS="-C target-feature=+crt-static"
            ;;
        Darwin)
            case "$(uname -m)" in
                arm64) arch_triple="aarch64-apple-darwin" ;;
                x86_64) arch_triple="x86_64-apple-darwin" ;;
                *) echo "release-bundle: unsupported macOS arch $(uname -m)" >&2; exit 1 ;;
            esac
            ;;
        *)
            echo "release-bundle: unsupported OS $(uname -s)" >&2
            exit 1
            ;;
    esac

    export OPUS_STATIC=1
    export OPUS_NO_PKG=1
    cargo build --release --target "$arch_triple" --bin foyer

    ./scripts/dev/shim.sh build
    FOYER_BIN="$(pwd)/target/$arch_triple/release/foyer" \
        ./scripts/release/bundle.sh

# Build the production container image. Two-stage build (Ardour from
# source + Foyer release binary in stage 1; slim runtime in stage 2).
# Slow path is the Ardour compile (~15 min on a modern CPU); rebuilds
# benefit from the BuildKit cache.
#
# Pass `image=foo:tag` to override the tag, or `args="--build-arg X=Y"`
# to forward extra build args. Example:
#   just docker-build image=ghcr.io/me/foyer:dev args="--build-arg ARDOUR_TAG=master"
docker-build image='foyer-studio:latest' *args='':
    DOCKER_BUILDKIT=1 docker build -t {{image}} {{args}} .

# Run the production image locally — the easy default. Matches the
# Cloud Run shape: GUI Ardour painting onto an in-container Xvfb,
# libardour's "None (Dummy)" backend, no JACK, no realtime
# scheduling, no privileged flags. Just works.
#
# Override the image:
#   just docker-run image=ghcr.io/hotspoons/foyer-studio:snapshot-latest
# Host path for /projects: repo root (just runs recipes with cwd = this
# Justfile’s directory). Override with FOYER_PROJECTS_DIR (e.g. foyer-projects).
docker-run image='foyer-studio:latest' *args='':
    docker run --rm -it \
        -p 3838:3838 \
        --shm-size=1g \
        -v "${FOYER_PROJECTS_DIR:-$(pwd)}:/projects" \
        -e PORT=3838 \
        {{args}} \
        {{image}}

# Run the production image in the JACK + RT path. Matches the dev-
# container shape: real `jackd` (or a host-mounted one via
# `FOYER_JACK_MODE=shm`), `hardour` instead of GUI Ardour, libjack
# clients allowed to acquire SCHED_FIFO. Needs --privileged + the
# rtprio/memlock ulimits or libjack fatals at thread-create.
#
# When you want to use the host's jackd instead of an in-container one:
#   just docker-run-jack image=... args="--ipc=host -v /dev/shm:/dev/shm -v /tmp:/tmp:rw -e FOYER_JACK_MODE=shm"
docker-run-jack image='foyer-studio:latest' *args='':
    docker run --rm -it \
        --privileged \
        --network=host \
        --ulimit rtprio=95 \
        --ulimit memlock=-1 \
        --shm-size=2g \
        -v "${FOYER_PROJECTS_DIR:-$(pwd)}:/projects" \
        -e PORT=3838 \
        -e FOYER_RUNTIME_MODE=jack-headless \
        {{args}} \
        {{image}}

ardour cmd='help' *args='':
    ./scripts/dev/ardour.sh {{cmd}} {{args}}

autovocoder cmd='help' *args='':
    ./scripts/dev/autovocoder.sh {{cmd}} {{args}}

# Pull latest upstream autovocoder (`main`) and reinstall LV2 bundle — overrides
# AUTOVOCODER_REF for this invocation only (see `.env` for daily default).
autovocoder-update *args='':
    AUTOVOCODER_REF=main ./scripts/dev/autovocoder.sh ensure {{args}}

shim cmd='help' *args='':
    ./scripts/dev/shim.sh {{cmd}} {{args}}

tw cmd='help' *args='':
    ./scripts/dev/tw.sh {{cmd}} {{args}}

jack cmd='help' *args='':
    ./scripts/dev/jack.sh {{cmd}} {{args}}

# ─────────────────────────── helm / kube ───────────────────────────
#
# Helpers for deploying the chart at charts/foyer-studio. They are
# deliberately thin around `helm install/upgrade` + a few discovery
# steps (kube-context, IngressClass, current-commit image tag) so a
# fresh dev gets a sane default deploy in one command, while power
# users keep every native helm knob via `{{args}}` passthrough.
#
# Configuration sources for the deployment domain (highest precedence
# first):
#   1. $FOYER_DOMAIN in the current shell env
#   2. FOYER_DOMAIN=... in .env.local at the repo root
#   3. FOYER_DOMAIN=... in .env at the repo root
#   4. auto-generated `f-<8 hex>.${FOYER_DOMAIN_PARENT:-foyer.io}` and
#      persisted to .env.local — random prefix avoids collisions when
#      multiple contributors deploy into the same shared cluster.
#
# Other env knobs (all optional):
#   FOYER_HELM_VALUES   path to an extra values.yaml (passed as -f)
#   FOYER_IMAGE_REPO    override image.repository
#   FOYER_IMAGE_TAG     override image.tag (skips ghcr probe)
#   FOYER_TLS_SECRET    pre-existing TLS Secret name to reference
#   FOYER_INGRESS_CLASS bypass autodetect; pass through verbatim
#   FOYER_USE_GATEWAY=1 deploy via Gateway API (HTTPRoute attach style)
#                       instead of Ingress; combine with
#                       FOYER_GATEWAY_NAME / FOYER_GATEWAY_NAMESPACE.

# Print the active kube context (or fail with a meaningful message if
# none is set / the API is unreachable). Both helm-deploy and
# helm-uninstall short-circuit through this.
_kube-precheck:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v kubectl >/dev/null 2>&1; then
        echo "==> kubectl not on PATH. Install it (.devcontainer/Dockerfile installs one) or rebuild the dev container." >&2
        exit 1
    fi
    if ! command -v helm >/dev/null 2>&1; then
        echo "==> helm not on PATH. Install it (.devcontainer/Dockerfile installs one) or rebuild the dev container." >&2
        exit 1
    fi
    if ! ctx=$(kubectl config current-context 2>/dev/null); then
        echo "==> No active kube context." >&2
        echo "    Drop a kubeconfig in place (e.g. \$KUBECONFIG=/path/to/cfg, or merge into ~/.kube/config)" >&2
        echo "    then 'kubectl config use-context <ctx>' before re-running this recipe." >&2
        exit 1
    fi
    if ! kubectl --request-timeout=5s version >/dev/null 2>&1; then
        echo "==> kube context '$ctx' is set but the API server is unreachable (5s timeout)." >&2
        echo "    Check cluster reachability: kubectl cluster-info" >&2
        exit 1
    fi
    echo "$ctx"

# Resolve FOYER_DOMAIN with the precedence documented above. If nothing
# resolves, mint a per-developer randomly-prefixed subdomain under
# `$FOYER_DOMAIN_PARENT` (default `foyer.io`) and persist it in
# .env.local so repeat deploys land on the same hostname. The random
# prefix is what stops two contributors deploying from the same shared
# cluster from racing each other onto the same Ingress host.
_resolve-domain:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "${FOYER_DOMAIN:-}" ]; then
        echo "$FOYER_DOMAIN"; exit 0
    fi
    for f in .env.local .env; do
        if [ -f "$f" ]; then
            v=$( (grep -E '^FOYER_DOMAIN=' "$f" || true) | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
            if [ -n "$v" ]; then echo "$v"; exit 0; fi
        fi
    done
    # Nothing set anywhere — generate one and stash it in .env.local
    # (which .gitignore already excludes from version control).
    parent="${FOYER_DOMAIN_PARENT:-foyer.io}"
    rand=$(openssl rand -hex 4 2>/dev/null || tr -dc 'a-f0-9' </dev/urandom | head -c 8)
    generated="f-${rand}.${parent}"
    if [ ! -f .env.local ]; then
        printf '# Per-developer overrides for `just` recipes. Not committed (see .gitignore).\n' > .env.local
    fi
    if ! grep -qE '^FOYER_DOMAIN=' .env.local 2>/dev/null; then
        printf 'FOYER_DOMAIN=%s\n' "$generated" >> .env.local
    fi
    echo "==> generated FOYER_DOMAIN=$generated and saved to .env.local" >&2
    echo "    (override anytime by exporting FOYER_DOMAIN= in your shell or editing .env.local)" >&2
    echo "$generated"

# Probe ghcr.io for a tag matching the current commit. Order:
#   main-<short-sha>  → snapshot-<short-sha> → latest
# Falls back to "latest" if none of the per-commit tags exist (e.g.
# CI hasn't pushed yet, or the local tree is dirty / behind).
_probe-image-tag repo='ghcr.io/hotspoons/foyer-studio':
    #!/usr/bin/env bash
    set -euo pipefail
    repo="{{repo}}"
    repo_path="${repo#ghcr.io/}"
    sha=$(git rev-parse --short=7 HEAD 2>/dev/null || true)
    if [ -z "$sha" ]; then
        echo "latest"; exit 0
    fi
    # GHCR token endpoint accepts an anonymous request for public repos.
    token=$(curl -fsS --max-time 10 \
        "https://ghcr.io/token?scope=repository:${repo_path}:pull&service=ghcr.io" 2>/dev/null \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)
    if [ -z "$token" ]; then
        # Anonymous probe failed (private repo, registry hiccup). Fall
        # back to latest — pulling will use whatever auth Helm/kubelet
        # already has configured.
        echo "latest"; exit 0
    fi
    for tag in "main-$sha" "snapshot-$sha" "latest"; do
        if curl -fsS -o /dev/null --max-time 10 -I \
            -H "Authorization: Bearer $token" \
            -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json" \
            "https://ghcr.io/v2/${repo_path}/manifests/${tag}" 2>/dev/null; then
            echo "$tag"; exit 0
        fi
    done
    echo "latest"

# Detect the cluster's default IngressClass. Honors the canonical
# `ingressclass.kubernetes.io/is-default-class=true` annotation; if no
# IngressClass is annotated, falls back to whichever class exists
# first; if no IngressClass exists at all, returns empty (Helm will
# leave the field unset and the cluster's resolution logic decides).
_detect-ingress-class:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "${FOYER_INGRESS_CLASS:-}" ]; then
        echo "$FOYER_INGRESS_CLASS"; exit 0
    fi
    cls=$(kubectl get ingressclass -o jsonpath='{.items[?(@.metadata.annotations.ingressclass\.kubernetes\.io/is-default-class=="true")].metadata.name}' 2>/dev/null || true)
    if [ -z "$cls" ]; then
        cls=$(kubectl get ingressclass -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    fi
    echo "$cls"

# Render the chart locally for inspection (no cluster access needed).
helm-render *args='':
    helm template foyer-studio charts/foyer-studio {{args}}

# Lint the chart.
helm-lint:
    helm lint charts/foyer-studio

# Install or upgrade the chart on the active context. The recipe
# discovers a default IngressClass + a current-commit image tag and
# threads them through as --set flags. Override any of those via the
# environment knobs documented at the top of the helm section.
helm-deploy release='foyer' namespace='foyer-studio' *args='':
    #!/usr/bin/env bash
    set -euo pipefail
    ctx=$(just _kube-precheck)
    domain=$(just _resolve-domain)
    repo="${FOYER_IMAGE_REPO:-ghcr.io/hotspoons/foyer-studio}"
    if [ -n "${FOYER_IMAGE_TAG:-}" ]; then
        tag="$FOYER_IMAGE_TAG"
    else
        tag=$(just _probe-image-tag "$repo")
    fi
    cls=$(just _detect-ingress-class)
    echo "==> context:       $ctx"
    echo "==> namespace:     {{namespace}}  (release: {{release}})"
    echo "==> domain:        $domain"
    echo "==> image:         $repo:$tag"
    if [ "${FOYER_USE_GATEWAY:-0}" = "1" ]; then
        echo "==> expose:        Gateway API (HTTPRoute attach)"
    else
        echo "==> expose:        Ingress (class: ${cls:-<cluster default>})"
    fi
    set_args=(
        --set "image.repository=${repo}"
        --set "image.tag=${tag}"
        --set "expose.host=${domain}"
    )
    if [ -n "${FOYER_TLS_SECRET:-}" ]; then
        set_args+=(--set "expose.tls.secretName=${FOYER_TLS_SECRET}")
    fi
    if [ "${FOYER_USE_GATEWAY:-0}" = "1" ]; then
        set_args+=(
            --set "expose.ingress.enabled=false"
            --set "expose.gateway.enabled=true"
            --set "expose.gateway.parentRef.name=${FOYER_GATEWAY_NAME:-gateway}"
        )
        if [ -n "${FOYER_GATEWAY_NAMESPACE:-}" ]; then
            set_args+=(--set "expose.gateway.parentRef.namespace=${FOYER_GATEWAY_NAMESPACE}")
        fi
    elif [ -n "$cls" ]; then
        set_args+=(--set "expose.ingress.className=${cls}")
    fi
    if [ -n "${FOYER_HELM_VALUES:-}" ]; then
        set_args+=(-f "$FOYER_HELM_VALUES")
    fi
    helm upgrade --install \
        "{{release}}" charts/foyer-studio \
        --namespace "{{namespace}}" --create-namespace \
        "${set_args[@]}" \
        {{args}}

# Uninstall the release. Keeps the underlying PV (reclaim policy is
# Retain) — pass FOYER_DELETE_PV=1 to also `kubectl delete pv` the
# bound volume after the helm uninstall lands.
helm-uninstall release='foyer' namespace='foyer-studio':
    #!/usr/bin/env bash
    set -euo pipefail
    ctx=$(just _kube-precheck)
    echo "==> context:   $ctx"
    echo "==> namespace: {{namespace}}  (release: {{release}})"
    pvc_name=""
    pv_name=""
    if pvc_name=$(kubectl -n "{{namespace}}" get pvc \
        -l "app.kubernetes.io/instance={{release}},foyer.io/role=projects" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) && [ -n "$pvc_name" ]; then
        pv_name=$(kubectl -n "{{namespace}}" get pvc "$pvc_name" \
            -o jsonpath='{.spec.volumeName}' 2>/dev/null || true)
    fi
    helm uninstall "{{release}}" --namespace "{{namespace}}"
    if [ -n "$pv_name" ]; then
        if [ "${FOYER_DELETE_PV:-0}" = "1" ]; then
            echo "==> deleting underlying PV $pv_name (FOYER_DELETE_PV=1)"
            kubectl delete pv "$pv_name" --ignore-not-found
        else
            echo "==> projects PV retained: $pv_name"
            echo "    (set FOYER_DELETE_PV=1 to also delete it)"
        fi
    fi
