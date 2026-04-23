#!/usr/bin/env bash
set -euo pipefail

ARDOUR_DIR="${FOYER_ARDOUR_DIR:-/workspaces/ardour}"

usage() {
    cat <<'EOF'
ardour subcommands:
  help        Print this help
  configure   Run waf configure --optimize
  build       Run waf build
  ensure      Soft-check build, auto-build only when needed
  check       Hard-check existing build
  clean       Run waf clean
  test        Run waf test
EOF
}

latest_bin() {
    ls -1 "$ARDOUR_DIR"/build/headless/hardour-* 2>/dev/null | sort -V | tail -n1 || true
}

ensure_tags() {
    if [ -z "$(git -C "$ARDOUR_DIR" tag -l | head -n1)" ]; then
        echo "ardour: no git tags found, fetching from origin..."
        git -C "$ARDOUR_DIR" fetch --tags origin
    fi
}

require_repo() {
    if [ ! -d "$ARDOUR_DIR" ]; then
        echo "ardour: missing $ARDOUR_DIR"
        exit 1
    fi
}

do_configure() {
    (cd "$ARDOUR_DIR" && python3 waf configure --optimize)
}

do_build() {
    (cd "$ARDOUR_DIR" && python3 waf build)
}

do_check() {
    local bin
    bin="$(latest_bin)"
    if [ -z "$bin" ] || [ ! -x "$bin" ]; then
        echo "ardour: no runnable hardour binary under $ARDOUR_DIR/build/headless/"
        exit 1
    fi
    if [ ! -f "$ARDOUR_DIR/build/gtk2_ardour/ardev_common_waf.sh" ]; then
        echo "ardour: missing ardev_common_waf.sh (build incomplete)"
        exit 1
    fi
    export TOP="$ARDOUR_DIR"
    export ASAN_COREDUMP="${ASAN_COREDUMP:-0}"
    # shellcheck disable=SC1090
    source "$ARDOUR_DIR/build/gtk2_ardour/ardev_common_waf.sh"
    if ! "$bin" --version >/tmp/foyer-hardour-check.log 2>&1; then
        echo "ardour: runtime probe failed"
        sed -n '1,20p' /tmp/foyer-hardour-check.log
        exit 1
    fi
    echo "ardour: ok ($bin)"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
    help)
        usage
        ;;
    configure)
        require_repo
        ensure_tags
        do_configure
        ;;
    build)
        require_repo
        do_build
        ;;
    check)
        require_repo
        do_check
        ;;
    ensure)
        require_repo
        ensure_tags
        need_build=0
        bin="$(latest_bin)"
        if [ -z "$bin" ] || [ ! -x "$bin" ]; then
            need_build=1
        fi
        if [ ! -f "$ARDOUR_DIR/build/gtk2_ardour/ardev_common_waf.sh" ]; then
            need_build=1
        fi
        if [ "$need_build" -eq 1 ]; then
            echo "ardour: bootstrapping build (slow path)"
            do_configure
            do_build
        fi
        if ! do_check; then
            echo "ardour: retrying incremental build after failed probe..."
            do_build
            do_check
        fi
        ;;
    clean)
        require_repo
        (cd "$ARDOUR_DIR" && python3 waf clean)
        ;;
    test)
        require_repo
        (cd "$ARDOUR_DIR" && python3 waf test)
        ;;
    *)
        echo "Unknown ardour subcommand: $cmd"
        usage
        exit 1
        ;;
esac
