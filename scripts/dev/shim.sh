#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Resolve Ardour source tree. Priority mirrors scripts/dev/ardour.sh:
#   1. $FOYER_ARDOUR_DIR (explicit override)
#   2. <repo>/ext/ardour (in-repo convention — gitignored)
#   3. /workspaces/ardour (legacy sibling layout)
if [ -n "${FOYER_ARDOUR_DIR:-}" ]; then
    ARDOUR_DIR="$FOYER_ARDOUR_DIR"
elif [ -d "$ROOT_DIR/ext/ardour" ]; then
    ARDOUR_DIR="$ROOT_DIR/ext/ardour"
else
    ARDOUR_DIR="/workspaces/ardour"
fi

SHIM_DIR="$ROOT_DIR/shims/ardour"
SHIM_BUILD_DIR="$SHIM_DIR/cmake-build"
INSTALL_DEST="${FOYER_SHIM_DEST:-$HOME/.config/ardour9}"
SESSION_DIR="${FOYER_SESSION_DIR:-/tmp/foyer-session}"
SESSION_NAME="${FOYER_SESSION_NAME:-foyer-smoke}"

usage() {
    cat <<'EOF'
shim subcommands:
  help       Print this help
  configure  Configure CMake for standalone shim
  build      Build standalone shim
  install    Install shim into ~/.config/ardour9/surfaces
  check      Soft-check install freshness; rebuild only when stale
  clean      Remove shim build directory
  e2e        Run shim end-to-end smoke test
EOF
}

do_configure() {
    cmake -S "$SHIM_DIR" -B "$SHIM_BUILD_DIR" \
          -DCMAKE_BUILD_TYPE=RelWithDebInfo \
          -DFOYER_ARDOUR_SOURCE="$ARDOUR_DIR"
}

do_build() {
    do_configure
    cmake --build "$SHIM_BUILD_DIR" -j
}

do_install() {
    do_build
    mkdir -p "$INSTALL_DEST/surfaces"
    cp "$SHIM_BUILD_DIR/libfoyer_shim.so" "$INSTALL_DEST/surfaces/"
    echo "shim: installed libfoyer_shim.so -> $INSTALL_DEST/surfaces/"
}

do_check() {
    # Stub-backend workflows don't need the shim; skip with a hint if
    # Ardour source is missing (the shim can't build without it). The
    # `just prep → shim check` path used to hard-fail here, blocking
    # the perfectly-fine stub boot.
    if [ ! -d "$ARDOUR_DIR" ]; then
        echo "shim: skipped (no Ardour source at $ARDOUR_DIR — real backend needs \`just ardour clone && just ardour build\`)"
        return 0
    fi
    installed="$INSTALL_DEST/surfaces/libfoyer_shim.so"
    if [ ! -e "$installed" ]; then
        echo "shim: not installed, building + installing"
        do_install
        return
    fi
    newer="$(find "$SHIM_DIR/src" "$SHIM_DIR/CMakeLists.txt" "$SHIM_BUILD_DIR/libfoyer_shim.so" -newer "$installed" 2>/dev/null | awk 'NR==1 {print}')"
    if [ -n "$newer" ]; then
        echo "shim: stale ($newer), rebuilding"
        do_install
        return
    fi
    echo "shim: up to date"
}

do_e2e() {
    "$ROOT_DIR/scripts/dev/jack.sh" start
    "$ROOT_DIR/scripts/dev/ardour.sh" ensure
    do_check

    cleanup() { kill "${HP:-0}" "${FP:-0}" 2>/dev/null || true; wait 2>/dev/null || true; }
    trap cleanup EXIT

    rm -f /tmp/foyer.sock /tmp/hardour.log /tmp/foyer-cli.log
    mkdir -p "$SESSION_DIR"

    if [ ! -f "$SESSION_DIR/$SESSION_NAME.ardour" ]; then
        export TOP="$ARDOUR_DIR"
        # shellcheck disable=SC1090
        source "$ARDOUR_DIR/build/gtk2_ardour/ardev_common_waf.sh"
        "$ARDOUR_DIR/build/session_utils/ardour9-new_empty_session" "$SESSION_DIR" "$SESSION_NAME"
    fi

    if ! grep -q 'name="Foyer Studio Shim" active="1"' "$SESSION_DIR/$SESSION_NAME.ardour"; then
        sed -i 's|<Protocol name="Wiimote" active="0"/>|<Protocol name="Wiimote" active="0"/>\n    <Protocol name="Foyer Studio Shim" active="1"/>|' "$SESSION_DIR/$SESSION_NAME.ardour"
    fi

    export TOP="$ARDOUR_DIR"
    # shellcheck disable=SC1090
    source "$ARDOUR_DIR/build/gtk2_ardour/ardev_common_waf.sh" >/dev/null
    export ARDOUR_SURFACES_PATH="$SHIM_BUILD_DIR:${ARDOUR_SURFACES_PATH:-}"

    hardour_bin="$(ls -1 "$ARDOUR_DIR"/build/headless/hardour-* 2>/dev/null | sort -V | tail -n1)"
    "$hardour_bin" "$SESSION_DIR" "$SESSION_NAME" >/tmp/hardour.log 2>&1 &
    HP=$!

    for _ in {1..40}; do [ -S /tmp/foyer.sock ] && break; sleep 0.5; done
    [ -S /tmp/foyer.sock ] || { echo "FAIL: shim socket never appeared"; sed -n '1,80p' /tmp/hardour.log; exit 1; }

    "$ROOT_DIR/target/debug/foyer" serve --backend ardour --socket /tmp/foyer.sock --listen 127.0.0.1:3842 --web-root "$ROOT_DIR/web" >/tmp/foyer-cli.log 2>&1 &
    FP=$!

    for _ in {1..30}; do curl -sf http://127.0.0.1:3842/index.html >/dev/null 2>&1 && break; sleep 0.5; done
    kill -0 "$FP" 2>/dev/null || { echo "FAIL: foyer-cli died"; sed -n '1,120p' /tmp/foyer-cli.log; exit 1; }

    sleep 3
    if rg -n "event pump died|bad control frame|panic" /tmp/foyer-cli.log >/dev/null 2>&1; then
        echo "FAIL: pump errored"
        sed -n '1,120p' /tmp/foyer-cli.log
        exit 1
    fi
    echo "shim: E2E_OK"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
    help) usage ;;
    configure) do_configure ;;
    build) do_build ;;
    install) do_install ;;
    check) do_check ;;
    clean) rm -rf "$SHIM_BUILD_DIR" ;;
    e2e) do_e2e ;;
    *)
        echo "Unknown shim subcommand: $cmd"
        usage
        exit 1
        ;;
esac
