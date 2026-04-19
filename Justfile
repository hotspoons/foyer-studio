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
# start foyer-cli with the stub backend; tester.html served from ./web
run-stub *args:
    cargo run --bin foyer -- serve --backend=stub {{args}}

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
    {{justfile_directory()}}/target/debug/foyer serve --backend=host --socket=/tmp/foyer.sock --listen=127.0.0.1:3842 --web-root={{justfile_directory()}}/web > /tmp/foyer-cli.log 2>&1 &
    FP=$!
    for i in {1..30}; do curl -sf http://127.0.0.1:3842/index.html > /dev/null 2>&1 && break; sleep 0.5; done
    kill -0 $FP 2>/dev/null || { echo "FAIL: foyer-cli died"; cat /tmp/foyer-cli.log; exit 1; }
    echo "✓ foyer-cli up on http://127.0.0.1:3842"
    sleep 3
    grep -qE 'event pump died|bad control frame|panic' /tmp/foyer-cli.log && { echo "FAIL: pump errored"; cat /tmp/foyer-cli.log; exit 1; }
    echo "✓ E2E_OK — foyer-cli → foyer-shim → hardour"
