#!/usr/bin/env bash
set -euo pipefail

# Resolve autovocoder source tree. Priority:
#   1. $FOYER_AUTOVOCODER_DIR (explicit override)
#   2. <repo>/ext/autovocoder (in-repo convention — gitignored)
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -n "${FOYER_AUTOVOCODER_DIR:-}" ]; then
    AV_DIR="$FOYER_AUTOVOCODER_DIR"
else
    AV_DIR="$REPO_ROOT/ext/autovocoder"
fi

AV_UPSTREAM="${FOYER_AUTOVOCODER_UPSTREAM:-https://github.com/hotspoons/autovocoder.git}"

# Where the LV2 bundle lands. The upstream `scripts/install-lv2.sh`
# honors $INSTALL_DIR; we leave the default ($HOME/.lv2) so Ardour's
# default LV2 path discovery picks it up without extra config.
LV2_DIR="${LV2_DIR:-$HOME/.lv2}"
BUNDLE="$LV2_DIR/autovocoder.lv2"

usage() {
    cat <<EOF
autovocoder subcommands:
  help        Print this help
  clone       Clone autovocoder into $REPO_ROOT/ext/autovocoder (if not present)
  build       Build the LV2 plugin (cargo --release)
  install     Build + install the LV2 bundle into $LV2_DIR (idempotent)
  ensure      Soft-check install; clone + build + install only when missing/stale
  check       Hard-check the installed bundle
  clean       Remove the build directory
  uninstall   Remove the installed LV2 bundle from $LV2_DIR

Current AV_DIR:  $AV_DIR
Current LV2_DIR: $LV2_DIR
Override paths with: FOYER_AUTOVOCODER_DIR=/path  LV2_DIR=/path
EOF
}

require_repo() {
    if [ ! -d "$AV_DIR" ]; then
        echo "autovocoder: missing $AV_DIR"
        exit 1
    fi
}

do_clone() {
    if [ -d "$AV_DIR/.git" ]; then
        echo "autovocoder: already present at $AV_DIR"
        return 0
    fi
    mkdir -p "$REPO_ROOT/ext"
    if [ -d "$AV_DIR" ] && [ ! -d "$AV_DIR/.git" ]; then
        echo "autovocoder: $AV_DIR exists but isn't a git checkout — refusing to clone into it"
        exit 1
    fi
    echo "autovocoder: cloning $AV_UPSTREAM → $AV_DIR"
    git clone "$AV_UPSTREAM" "$AV_DIR"
}

do_build() {
    require_repo
    (cd "$AV_DIR" && cargo build --release -p autovocoder-lv2)
}

do_install() {
    require_repo
    # Delegate to the upstream installer — it builds release, copies
    # the .so + .ttl manifests into $INSTALL_DIR/autovocoder.lv2/, and
    # is idempotent (re-run upgrades in place). Same script anyone
    # cloning autovocoder standalone would use.
    INSTALL_DIR="$LV2_DIR" "$AV_DIR/scripts/install-lv2.sh"
}

do_check() {
    if [ ! -d "$BUNDLE" ]; then
        echo "autovocoder: bundle missing at $BUNDLE"
        exit 1
    fi
    case "$(uname)" in
        Linux)  lib="libautovocoder_lv2.so" ;;
        Darwin) lib="libautovocoder_lv2.dylib" ;;
        *)      lib="autovocoder_lv2.dll" ;;
    esac
    if [ ! -f "$BUNDLE/$lib" ]; then
        echo "autovocoder: $BUNDLE/$lib missing — install incomplete"
        exit 1
    fi
    if [ ! -f "$BUNDLE/manifest.ttl" ]; then
        echo "autovocoder: $BUNDLE/manifest.ttl missing — install incomplete"
        exit 1
    fi
    echo "autovocoder: ok ($BUNDLE)"
}

do_uninstall() {
    if [ -d "$BUNDLE" ]; then
        rm -rf "$BUNDLE"
        echo "autovocoder: removed $BUNDLE"
    else
        echo "autovocoder: nothing to remove at $BUNDLE"
    fi
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
    build)
        do_build
        ;;
    install)
        do_install
        ;;
    check)
        do_check
        ;;
    uninstall)
        do_uninstall
        ;;
    ensure)
        # Called by `just prep` alongside `ardour ensure`. Full
        # bootstrap:
        #   1. clone into ext/autovocoder if missing
        #   2. build + install the LV2 bundle if not already at $BUNDLE
        # Idempotent — once installed this short-circuits in < 1 s.
        # The one-time slow path is the cargo release build (~1 min).
        if [ ! -d "$AV_DIR" ]; then
            echo "autovocoder: source missing — cloning"
            do_clone
        fi
        if ! do_check >/dev/null 2>&1; then
            echo "autovocoder: bundle missing or stale — building + installing"
            do_install
            do_check
        else
            echo "autovocoder: bundle already installed at $BUNDLE"
        fi
        ;;
    clean)
        if [ -d "$AV_DIR/target" ]; then
            (cd "$AV_DIR" && cargo clean)
        fi
        ;;
    *)
        echo "Unknown autovocoder subcommand: $cmd"
        usage
        exit 1
        ;;
esac
