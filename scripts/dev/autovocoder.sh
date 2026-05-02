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
# SHA). Empty means "whatever upstream HEAD is" — current behavior
# before the variable existed. See `.env` for the full rationale.
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
  ensure      Soft-check install; clone + build + install only when missing/stale
  check       Hard-check the installed bundle
  clean       Remove the build directory
  uninstall   Remove the installed LV2 bundle from $LV2_DIR

Current AV_DIR:           $AV_DIR
Current LV2_DIR:          $LV2_DIR
Current AUTOVOCODER_REF:  ${AUTOVOCODER_REF:-(unset — upstream HEAD)}
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

# Switch an existing checkout to $AUTOVOCODER_REF when it doesn't
# match. No-op when the ref is empty or already correct. Matches
# either by tag/branch name or by commit SHA prefix (so a 7-char SHA
# in .env still correctly identifies the full commit). Skips when
# there are local modifications — user may be mid-hack.
ensure_ref() {
    [ -n "$AUTOVOCODER_REF" ] || return 0
    [ -d "$AV_DIR/.git" ] || return 0
    local current full
    current="$(git -C "$AV_DIR" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
    full="$(git -C "$AV_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    # Already at the requested ref? Compare against full SHA, short
    # SHA, current branch name (`git symbolic-ref`), and any tag that
    # currently points at HEAD. That covers branch / tag / SHA inputs
    # without a separate ref-type detection step.
    if [ "$full" = "$AUTOVOCODER_REF" ] \
            || [ "$current" = "$AUTOVOCODER_REF" ]; then
        return 0
    fi
    case "$full" in "$AUTOVOCODER_REF"*) return 0 ;; esac
    if [ "$(git -C "$AV_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)" \
            = "$AUTOVOCODER_REF" ]; then
        return 0
    fi
    if git -C "$AV_DIR" tag --points-at HEAD 2>/dev/null \
            | grep -qxF "$AUTOVOCODER_REF"; then
        return 0
    fi
    if [ -n "$(git -C "$AV_DIR" status --porcelain)" ]; then
        echo "autovocoder: ⚠ uncommitted changes — staying on $current (target: $AUTOVOCODER_REF)"
        return 0
    fi
    echo "autovocoder: switching $current → $AUTOVOCODER_REF"
    # Fetch the ref. Try unqualified (works for branches/tags +
    # already-cached SHAs) before falling through to a SHA-fetch.
    if ! git -C "$AV_DIR" fetch --depth 1 origin "$AUTOVOCODER_REF" 2>/dev/null \
            && ! git -C "$AV_DIR" fetch --tags origin 2>/dev/null; then
        echo "autovocoder: fetch failed — leaving on $current"
        return 1
    fi
    # Branch case: if `origin/<ref>` exists after the fetch, the user
    # almost certainly wants to track it (not stay pinned to whatever
    # the local branch happened to point at before our fetch). Check
    # out `origin/<ref>` directly so we land on the just-fetched commit
    # regardless of whether the local branch was stale. Detached-HEAD
    # is fine — we're not committing here.
    if git -C "$AV_DIR" rev-parse --verify --quiet \
            "refs/remotes/origin/$AUTOVOCODER_REF" >/dev/null; then
        git -C "$AV_DIR" -c advice.detachedHead=false \
            checkout "origin/$AUTOVOCODER_REF"
    else
        git -C "$AV_DIR" -c advice.detachedHead=false \
            checkout "$AUTOVOCODER_REF"
    fi
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
