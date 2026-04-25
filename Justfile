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
    ./scripts/dev/tw.sh check
    ./scripts/dev/ardour.sh ensure
    ./scripts/dev/autovocoder.sh ensure
    ./scripts/dev/jack.sh start
    ./scripts/dev/shim.sh check
    ./scripts/dev/nuke-web-install.sh

run *args='': prep
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

clippy:
    cargo clippy --workspace --all-targets -- -D warnings

fmt-check:
    cargo fmt --all -- --check

# Apply every autofixer that resolves a `just verify` failure
# (formatting, lint auto-fixes, etc.). Run this before pushing —
# `just verify` is the read-only gate (mirrors GitHub Actions); this
# recipe is the writeable companion. Add new fixers here as the
# project picks them up.
ci:
    cargo fmt --all
    @echo "✅ ci: applied"

test:
    cargo test --workspace --all-targets

e2e:
    ./scripts/dev/shim.sh e2e

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
test-ui-ci:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo build --bin foyer
    # Use the repo's working web/ so CI validates the tree that just
    # got committed — NOT whatever happens to be extracted in the
    # runner's $XDG_DATA_HOME. Without this flag the CLI serves the
    # install dir (the canonical hackability target for users).
    ./target/debug/foyer serve \
        --backend stub --listen 127.0.0.1:3838 --web-root web \
        > /tmp/foyer-ci.log 2>&1 &
    server_pid=$!
    trap "kill $server_pid 2>/dev/null || true" EXIT
    # Poll readiness — don't hard-sleep.
    for _ in $(seq 1 30); do
        if curl -fsS -o /dev/null http://127.0.0.1:3838/ 2>/dev/null; then break; fi
        sleep 0.5
    done
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
release-bundle:
    ./scripts/dev/tw.sh build
    cargo build --release --bin foyer
    ./scripts/dev/shim.sh build
    ./scripts/release/bundle.sh

ardour cmd='help' *args='':
    ./scripts/dev/ardour.sh {{cmd}} {{args}}

autovocoder cmd='help' *args='':
    ./scripts/dev/autovocoder.sh {{cmd}} {{args}}

shim cmd='help' *args='':
    ./scripts/dev/shim.sh {{cmd}} {{args}}

tw cmd='help' *args='':
    ./scripts/dev/tw.sh {{cmd}} {{args}}

jack cmd='help' *args='':
    ./scripts/dev/jack.sh {{cmd}} {{args}}
