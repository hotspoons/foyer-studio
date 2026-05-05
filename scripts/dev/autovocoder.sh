#!/usr/bin/env bash
set -euo pipefail

# Resolve autovocoder source tree. Priority:
#   1. $FOYER_AUTOVOCODER_DIR (explicit override)
#   2. <repo>/ext/autovocoder (in-repo convention — gitignored)
# Resolve via BASH_SOURCE so this works whether the script is invoked
# directly or sourced (matches scripts/dev/ardour.sh).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -n "${FOYER_AUTOVOCODER_DIR:-}" ]; then
    AV_DIR="$FOYER_AUTOVOCODER_DIR"
else
    AV_DIR="$REPO_ROOT/ext/autovocoder"
fi

AV_UPSTREAM="${FOYER_AUTOVOCODER_UPSTREAM:-https://github.com/hotspoons/autovocoder.git}"

# Source project + per-dev .env files for AUTOVOCODER_REF (and any
# other values .env carries). Precedence: shell env > .env.local
# (gitignored) > .env (committed). Mirrors scripts/dev/ardour.sh —
# `set -a` exports each assignment as a real env var.
load_env_file() {
    [ -f "$1" ] || return 0
    set -a
    # shellcheck disable=SC1090
    . "$1"
    set +a
}
__foyer_av_env_already_set="${AUTOVOCODER_REF+1}"
if [ -z "$__foyer_av_env_already_set" ]; then
    load_env_file "$REPO_ROOT/.env"
    load_env_file "$REPO_ROOT/.env.local"
fi
unset __foyer_av_env_already_set

# Optional pin to a specific autovocoder ref (tag, branch, or commit
# SHA). Empty → each `ensure` fetches origin and follows `origin/HEAD`
# (default branch). Non-empty → fetch that ref and checkout its tip.
AUTOVOCODER_REF="${AUTOVOCODER_REF:-}"

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
  ensure      Fetch upstream + sync checkout; clone/build/install when missing or HEAD moved
  check       Hard-check the installed bundle
  clean       Remove the build directory
  uninstall   Remove the installed LV2 bundle from $LV2_DIR

Current AV_DIR:           $AV_DIR
Current LV2_DIR:          $LV2_DIR
Current AUTOVOCODER_REF:  ${AUTOVOCODER_REF:-(unset — track origin/HEAD)}
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
    if [ -n "$AUTOVOCODER_REF" ]; then
        echo "autovocoder: cloning $AV_UPSTREAM @ $AUTOVOCODER_REF → $AV_DIR"
        # Try the fast path (tag/branch shallow clone). If that fails,
        # the ref is likely a commit SHA — `--branch` doesn't accept
        # those, so fall back to init + fetch + checkout. GitHub has
        # uploadpack.allowReachableSHA1InWant on, so SHA fetch works.
        # Mirrors scripts/dev/ardour.sh's `do_clone` behavior.
        if git -c advice.detachedHead=false clone \
                --depth 1 \
                --branch "$AUTOVOCODER_REF" \
                "$AV_UPSTREAM" "$AV_DIR" 2>/dev/null; then
            return 0
        fi
        echo "autovocoder: '$AUTOVOCODER_REF' isn't a tag/branch — fetching as commit SHA"
        rm -rf "$AV_DIR"
        mkdir -p "$AV_DIR"
        git -C "$AV_DIR" init -q
        git -C "$AV_DIR" remote add origin "$AV_UPSTREAM"
        git -C "$AV_DIR" fetch --depth 1 origin "$AUTOVOCODER_REF"
        git -C "$AV_DIR" -c advice.detachedHead=false checkout FETCH_HEAD
        return 0
    fi
    echo "autovocoder: cloning $AV_UPSTREAM → $AV_DIR"
    git clone "$AV_UPSTREAM" "$AV_DIR"
}

# Resolve the commit we want to be on, fetching from origin first so
# branch pins (e.g. main) actually advance when upstream moves.
# Empty AUTOVOCODER_REF → track upstream default branch (origin/HEAD).
resolve_autovocoder_target_sha() {
    local sha
    if [ -n "$AUTOVOCODER_REF" ]; then
        # Try shallow fetch first (fast on CI / repeated ensures).
        if ! git -C "$AV_DIR" fetch --depth 1 origin "$AUTOVOCODER_REF" 2>/dev/null; then
            if ! git -C "$AV_DIR" fetch origin "$AUTOVOCODER_REF" 2>/dev/null \
                    && ! git -C "$AV_DIR" fetch --tags origin 2>/dev/null; then
                echo "autovocoder: fetch origin '$AUTOVOCODER_REF' failed"
                return 1
            fi
        fi
        if git -C "$AV_DIR" rev-parse --verify --quiet \
                "refs/remotes/origin/$AUTOVOCODER_REF" >/dev/null; then
            git -C "$AV_DIR" rev-parse "refs/remotes/origin/$AUTOVOCODER_REF"
            return 0
        fi
        if git -C "$AV_DIR" rev-parse --verify --quiet \
                "refs/tags/$AUTOVOCODER_REF" >/dev/null; then
            git -C "$AV_DIR" rev-parse "refs/tags/$AUTOVOCODER_REF^{commit}"
            return 0
        fi
        sha="$(git -C "$AV_DIR" rev-parse --verify "$AUTOVOCODER_REF^{commit}" 2>/dev/null || true)"
        if [ -n "$sha" ]; then
            echo "$sha"
            return 0
        fi
        echo "autovocoder: could not resolve AUTOVOCODER_REF='$AUTOVOCODER_REF' after fetch"
        return 1
    fi
    # No pin — stay on upstream default branch (latest tip).
    if ! git -C "$AV_DIR" fetch origin 2>/dev/null; then
        echo "autovocoder: fetch origin failed"
        return 1
    fi
    local sym
    sym="$(git -C "$AV_DIR" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null || true)"
    if [ -n "$sym" ]; then
        git -C "$AV_DIR" rev-parse "$sym"
        return 0
    fi
    if git -C "$AV_DIR" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
        git -C "$AV_DIR" rev-parse refs/remotes/origin/main
        return 0
    fi
    if git -C "$AV_DIR" rev-parse --verify --quiet refs/remotes/origin/master >/dev/null; then
        git -C "$AV_DIR" rev-parse refs/remotes/origin/master
        return 0
    fi
    echo "autovocoder: could not resolve origin default branch (no origin/HEAD, main, or master)"
    return 1
}

# Move an existing checkout to the resolved target commit when we're
# behind origin (or pinned SHA/tag moved). No-op when already there.
# Skips when there are local modifications — user may be mid-hack.
ensure_ref() {
    [ -d "$AV_DIR/.git" ] || return 0
    local current target_sha head_sha
    current="$(git -C "$AV_DIR" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
    head_sha="$(git -C "$AV_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"

    # Fast path: exact SHA pin already checked out (no network).
    if [ -n "$AUTOVOCODER_REF" ]; then
        if [ "$head_sha" = "$AUTOVOCODER_REF" ]; then
            return 0
        fi
        case "$head_sha" in "$AUTOVOCODER_REF"*) return 0 ;; esac
    fi

    if ! target_sha="$(resolve_autovocoder_target_sha)"; then
        return 1
    fi
    if [ "$head_sha" = "$target_sha" ]; then
        return 0
    fi
    if [ -n "$(git -C "$AV_DIR" status --porcelain)" ]; then
        echo "autovocoder: ⚠ uncommitted changes — staying on $current (would move to ${target_sha:0:12})"
        return 0
    fi
    echo "autovocoder: updating $current → ${target_sha:0:12}"
    git -C "$AV_DIR" -c advice.detachedHead=false checkout "$target_sha"
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
        return 1
    fi
    case "$(uname)" in
        Linux)  lib="libautovocoder_lv2.so" ;;
        Darwin) lib="libautovocoder_lv2.dylib" ;;
        *)      lib="autovocoder_lv2.dll" ;;
    esac
    if [ ! -f "$BUNDLE/$lib" ]; then
        echo "autovocoder: $BUNDLE/$lib missing — install incomplete"
        return 1
    fi
    if [ ! -f "$BUNDLE/manifest.ttl" ]; then
        echo "autovocoder: $BUNDLE/manifest.ttl missing — install incomplete"
        return 1
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
        #   1. clone into ext/autovocoder if missing (honoring
        #      $AUTOVOCODER_REF when set)
        #   2. switch existing checkout to $AUTOVOCODER_REF if it
        #      drifted (e.g. user just bumped the ref in .env)
        #   3. build + install the LV2 bundle if not already at $BUNDLE
        #      OR the source HEAD is newer than the installed bundle
        # Idempotent — once installed this short-circuits in < 1 s.
        # The one-time slow path is the cargo release build (~1 min).
        if [ ! -d "$AV_DIR" ]; then
            echo "autovocoder: source missing — cloning"
            do_clone
        else
            # ref-switch may swap HEAD; capture the before-SHA so we
            # can detect when a rebuild is needed even if $BUNDLE
            # already exists from the prior ref.
            before_sha="$(git -C "$AV_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
            ensure_ref
            after_sha="$(git -C "$AV_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
            if [ "$before_sha" != "$after_sha" ] && [ -d "$BUNDLE" ]; then
                echo "autovocoder: ref switched ($before_sha → $after_sha) — bundle is stale"
                # `do_install` does an in-place upgrade; let it handle
                # the rebuild + replace rather than wiping here.
                do_install
                do_check
                exit 0
            fi
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
