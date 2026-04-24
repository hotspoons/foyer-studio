#!/usr/bin/env bash
set -euo pipefail

# Resolve Ardour source tree. Priority:
#   1. $FOYER_ARDOUR_DIR (explicit override)
#   2. <repo>/ext/ardour (in-repo convention — gitignored)
#   3. /workspaces/ardour (legacy sibling-workspace layout)
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -n "${FOYER_ARDOUR_DIR:-}" ]; then
    ARDOUR_DIR="$FOYER_ARDOUR_DIR"
elif [ -d "$REPO_ROOT/ext/ardour" ]; then
    ARDOUR_DIR="$REPO_ROOT/ext/ardour"
else
    ARDOUR_DIR="/workspaces/ardour"
fi

ARDOUR_UPSTREAM="${FOYER_ARDOUR_UPSTREAM:-https://github.com/Ardour/ardour.git}"

usage() {
    cat <<EOF
ardour subcommands:
  help        Print this help
  clone       Clone Ardour into $REPO_ROOT/ext/ardour (if not present)
  configure   Run waf configure --optimize
  build       Run waf build
  ensure      Soft-check build, auto-build only when needed
  check       Hard-check existing build
  clean       Run waf clean
  test        Run waf test

Current ARDOUR_DIR: $ARDOUR_DIR
Override with: FOYER_ARDOUR_DIR=/path/to/ardour
EOF
}

do_clone() {
    if [ -d "$ARDOUR_DIR/.git" ]; then
        echo "ardour: already present at $ARDOUR_DIR"
        return 0
    fi
    mkdir -p "$REPO_ROOT/ext"
    local target="$REPO_ROOT/ext/ardour"
    if [ -d "$target" ] && [ ! -d "$target/.git" ]; then
        echo "ardour: $target exists but isn't a git checkout — refusing to clone into it"
        exit 1
    fi
    echo "ardour: cloning $ARDOUR_UPSTREAM → $target (this is ~1 GB)"
    git clone "$ARDOUR_UPSTREAM" "$target"
    echo "ardour: done. Next: \`just ardour configure && just ardour build\`"
    ARDOUR_DIR="$target"
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
    clone)
        do_clone
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
        # Called by `just prep` before every `just run[-tls]`. Full
        # bootstrap:
        #   1. clone into ext/ardour if source tree missing (~1 GB)
        #   2. configure + build if the headless binary isn't there
        #   3. write the resulting executable path into
        #      `$XDG_DATA_HOME/foyer/config.yaml` via
        #      `foyer configure --backend ardour --force`
        # Idempotent — once everything is in place this short-circuits
        # in < 1 s. The one-time slow path clones + builds Ardour, so
        # fresh-clone devs get a real DAW on `just run` without having
        # to remember separate setup steps.
        if [ ! -d "$ARDOUR_DIR" ]; then
            echo "ardour: source tree missing at $ARDOUR_DIR — cloning (large, one-time)"
            do_clone
        fi
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
            echo "ardour: bootstrapping build (slow path — ~15 min)"
            do_configure
            do_build
        fi
        if ! do_check; then
            echo "ardour: retrying incremental build after failed probe..."
            do_build
            do_check
        fi
        # Write the resolved executable path into config.yaml so the
        # sidecar (and the UI's backend launcher) can spawn it. Uses
        # `foyer configure --backend ardour --force` with
        # FOYER_ARDOUR_BUILD_ROOT pinned to the resolved ARDOUR_DIR
        # so detection finds the binary deterministically.
        (
            cd "$REPO_ROOT"
            FOYER_ARDOUR_BUILD_ROOT="$ARDOUR_DIR" \
                cargo run --quiet --bin foyer -- configure --backend ardour --force
        )
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
