#!/usr/bin/env bash
set -euo pipefail

# Foyer Studio one-shot installer.
#
# Usage (network install):
#   curl -fsSL https://github.com/hotspoons/foyer-studio/releases/latest/download/install.sh | bash
#
# Usage (latest CI build, no release needed — grabs the most recent
# successful main-branch CI artifacts via nightly.link, no GitHub auth):
#   curl -fsSL https://raw.githubusercontent.com/hotspoons/foyer-studio/main/install.sh | bash -s -- --latest-ci
#
# Usage (latest CI build, no release needed — grabs the most recent
# successful main-branch CI artifacts via nightly.link, no GitHub auth):
#   curl -fsSL https://raw.githubusercontent.com/foyer-studio/foyer-studio/main/install.sh | bash -s -- --latest-ci
#
# Usage (explicit):
#   ./install.sh install                       # latest release
#   ./install.sh install --version v0.1.0
#   ./install.sh install --latest-ci           # latest passing CI build
#   ./install.sh install --from-bundle ./dir   # use an extracted zip
#   ./install.sh uninstall                     # remove binary + shim
#   ./install.sh uninstall --purge             # also wipe ~/.local/share/foyer/
#
# Env overrides:
#   FOYER_RELEASE_REPO  owner/repo to fetch from (default: hotspoons/foyer-studio)
#   FOYER_PREFIX        install root (default: $XDG_DATA_HOME/foyer or ~/.local/share/foyer)
#   FOYER_CI_BRANCH     branch to pull --latest-ci artifacts from (default: main)
#   FOYER_NO_PATH_EDIT  set to 1 to skip touching shell rc files
#
# What it does:
#   1. Detects OS + arch (linux/macos × x86_64/arm64).
#   2. Downloads foyer-<os>-<arch>.zip from the matching GitHub release.
#   3. Installs:
#        $FOYER_PREFIX/bin/foyer
#        <ardour-surfaces>/libfoyer_shim.{so,dylib}
#      Ardour surfaces dir:
#        Linux:  ~/.config/ardour9/surfaces/
#        macOS:  ~/Library/Preferences/Ardour9/surfaces/
#   4. Adds $FOYER_PREFIX/bin to PATH in ~/.bashrc / ~/.zshrc / ~/.profile
#      (idempotent — sentinel-marked, removed on uninstall).

REPO="${FOYER_RELEASE_REPO:-hotspoons/foyer-studio}"
PREFIX="${FOYER_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/foyer}"
BIN_DIR="$PREFIX/bin"
PATH_SENTINEL="# foyer-studio installer (managed)"
CI_BRANCH="${FOYER_CI_BRANCH:-main}"

OS=""
ARCH=""
SHIM_EXT=""
SURFACES_DIR=""

die() { echo "install.sh: $*" >&2; exit 1; }
# Stderr so callers using $(download_and_extract_ci ...) don't capture
# progress chatter into the returned bundle path.
note() { echo "==> $*" >&2; }

usage() {
    cat <<EOF
foyer installer

Commands:
  install [--version vX.Y.Z] [--latest-ci] [--from-bundle DIR]
                                  Fetch + install foyer + shim.
                                  --latest-ci pulls the most recent passing
                                  CI build from nightly.link instead of a
                                  tagged release (no GitHub auth needed).
  uninstall [--purge]             Remove foyer + shim. --purge wipes
                                  $PREFIX entirely.
  help                            Show this help.

Env:
  FOYER_RELEASE_REPO  owner/repo (default: $REPO)
  FOYER_PREFIX        install root (default: $PREFIX)
  FOYER_CI_BRANCH     branch for --latest-ci (default: $CI_BRANCH)
  FOYER_NO_PATH_EDIT  set 1 to skip shell rc edits
EOF
}

detect_target() {
    local uname_s uname_m
    uname_s="$(uname -s)"
    uname_m="$(uname -m)"
    case "$uname_s" in
        Linux)  OS=linux ; SHIM_EXT=so   ; SURFACES_DIR="$HOME/.config/ardour9/surfaces" ;;
        Darwin) OS=macos ; SHIM_EXT=dylib; SURFACES_DIR="$HOME/Library/Preferences/Ardour9/surfaces" ;;
        *) die "unsupported OS: $uname_s" ;;
    esac
    case "$uname_m" in
        x86_64|amd64)   ARCH=x86_64 ;;
        aarch64|arm64)  ARCH=arm64 ;;
        *) die "unsupported architecture: $uname_m" ;;
    esac
    # GitHub retired the Intel macOS runners, so we don't ship a
    # macOS x86_64 binary. Intel Macs need to build from source.
    if [ "$OS" = "macos" ] && [ "$ARCH" = "x86_64" ]; then
        die "Intel Macs aren't supported by the prebuilt release. Build from source: https://github.com/$REPO"
    fi
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

asset_url() {
    local version="$1"
    local asset="foyer-$OS-$ARCH.zip"
    if [ -z "$version" ] || [ "$version" = "latest" ]; then
        echo "https://github.com/$REPO/releases/latest/download/$asset"
    else
        echo "https://github.com/$REPO/releases/download/$version/$asset"
    fi
}

download_and_extract() {
    local version="$1" workdir="$2"
    require_cmd curl
    require_cmd unzip
    local url asset
    url="$(asset_url "$version")"
    asset="$workdir/foyer.zip"
    note "fetching $url"
    if ! curl -fL --retry 3 -o "$asset" "$url"; then
        die "download failed (URL: $url)"
    fi
    ( cd "$workdir" && unzip -q foyer.zip )
    # Zip layout is foyer-<os>-<arch>/{foyer,libfoyer_shim.*}.
    local extracted
    extracted="$(find "$workdir" -mindepth 1 -maxdepth 1 -type d -name "foyer-*" | head -n1)"
    [ -n "$extracted" ] || die "extracted bundle directory not found"
    echo "$extracted"
}

# Pull the foyer binary + shim from the most recent successful ci.yml run on
# $CI_BRANCH via nightly.link, which proxies GitHub Actions artifacts behind
# auth-free URLs. The two CI artifacts are uploaded as separate files (not a
# combined bundle like the release), so we download both and lay them out to
# match the release-bundle shape that install_files expects.
download_and_extract_ci() {
    local workdir="$1"
    require_cmd curl
    require_cmd unzip

    local base="https://nightly.link/$REPO/workflows/ci/$CI_BRANCH"
    local bin_url="$base/foyer-$OS-$ARCH.zip"
    local shim_url="$base/foyer-shim-$OS-$ARCH.zip"
    local bin_zip="$workdir/foyer-bin.zip"
    local shim_zip="$workdir/foyer-shim.zip"
    local bundle="$workdir/foyer-$OS-$ARCH"
    mkdir -p "$bundle"

    note "fetching $bin_url"
    if ! curl -fL --retry 3 -o "$bin_zip" "$bin_url"; then
        die "download failed (URL: $bin_url) — no successful run on '$CI_BRANCH'?"
    fi
    note "fetching $shim_url"
    if ! curl -fL --retry 3 -o "$shim_zip" "$shim_url"; then
        die "download failed (URL: $shim_url) — no successful run on '$CI_BRANCH'?"
    fi

    # Each CI artifact zip wraps a single file at the root.
    ( cd "$bundle" && unzip -qo "$bin_zip" && unzip -qo "$shim_zip" )
    [ -f "$bundle/foyer" ] \
        || die "CI bundle missing foyer binary (from $bin_url)"
    [ -f "$bundle/libfoyer_shim.$SHIM_EXT" ] \
        || die "CI bundle missing shim (from $shim_url)"
    # GitHub Actions artifact uploads strip the executable bit.
    chmod +x "$bundle/foyer"
    echo "$bundle"
}

install_files() {
    local source_dir="$1"
    local foyer_src="$source_dir/foyer"
    local shim_src="$source_dir/libfoyer_shim.$SHIM_EXT"
    [ -x "$foyer_src" ] || [ -f "$foyer_src" ] || die "missing $foyer_src in bundle"

    mkdir -p "$BIN_DIR"
    install -m 0755 "$foyer_src" "$BIN_DIR/foyer"
    note "installed $BIN_DIR/foyer"

    # Bundle may or may not include the shim — macOS bundles ship
    # foyer-only today (see bundle.sh's FOYER_SKIP_SHIM path).
    if [ -f "$shim_src" ]; then
        mkdir -p "$SURFACES_DIR"
        install -m 0644 "$shim_src" "$SURFACES_DIR/libfoyer_shim.$SHIM_EXT"
        note "installed $SURFACES_DIR/libfoyer_shim.$SHIM_EXT"
    else
        note "bundle has no shim for $OS/$ARCH — installing foyer only."
        note "  to use foyer with a local Ardour, build the shim from source:"
        note "  https://github.com/$REPO#build-the-shim-from-source"
    fi

    # Strip the quarantine xattr macOS slaps on downloaded archives —
    # without this Gatekeeper blocks dlopen of the shim and refuses to
    # exec the foyer binary on first launch.
    if [ "$OS" = "macos" ]; then
        xattr -dr com.apple.quarantine "$BIN_DIR/foyer" 2>/dev/null || true
        if [ -f "$SURFACES_DIR/libfoyer_shim.$SHIM_EXT" ]; then
            xattr -dr com.apple.quarantine "$SURFACES_DIR/libfoyer_shim.$SHIM_EXT" 2>/dev/null || true
        fi
    fi

}

# Idempotently append a PATH export to whichever shell rc files exist.
# Marked with a sentinel comment so uninstall can find + remove it.
add_to_path() {
    [ "${FOYER_NO_PATH_EDIT:-0}" = "1" ] && { note "FOYER_NO_PATH_EDIT=1, skipping PATH edit"; return 0; }
    local export_line="export PATH=\"$BIN_DIR:\$PATH\""
    local block
    block=$(printf '\n%s\n%s\n' "$PATH_SENTINEL" "$export_line")
    local touched=0
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        [ -f "$rc" ] || continue
        if grep -qF "$PATH_SENTINEL" "$rc"; then
            continue
        fi
        printf '%s' "$block" >> "$rc"
        note "added PATH entry to $rc"
        touched=1
    done
    if [ "$touched" = 0 ]; then
        # No shell rc existed (or all already had the sentinel). Drop a
        # ~/.profile so a future shell login picks it up.
        if ! [ -f "$HOME/.profile" ]; then
            printf '%s' "$block" > "$HOME/.profile"
            note "created $HOME/.profile with PATH entry"
        fi
    fi
}

remove_from_path() {
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        [ -f "$rc" ] || continue
        grep -qF "$PATH_SENTINEL" "$rc" || continue
        # Delete the sentinel line and the export line that follows it.
        # `awk` works portably across BSD (macOS) and GNU.
        local tmp
        tmp="$(mktemp)"
        awk -v sentinel="$PATH_SENTINEL" '
            $0 == sentinel { skip = 1; next }
            skip && /^export PATH=/ { skip = 0; next }
            skip { skip = 0 }
            { print }
        ' "$rc" > "$tmp"
        mv "$tmp" "$rc"
        note "cleaned PATH entry from $rc"
    done
}

do_install() {
    local version="latest"
    local from_bundle=""
    local latest_ci=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --version)    version="$2"; shift 2 ;;
            --version=*)  version="${1#*=}"; shift ;;
            --from-bundle) from_bundle="$2"; shift 2 ;;
            --from-bundle=*) from_bundle="${1#*=}"; shift ;;
            --latest-ci)  latest_ci=1; shift ;;
            -h|--help) usage; exit 0 ;;
            *) die "unknown install argument: $1" ;;
        esac
    done

    if [ "$latest_ci" = 1 ] && [ -n "$from_bundle" ]; then
        die "--latest-ci and --from-bundle are mutually exclusive"
    fi
    if [ "$latest_ci" = 1 ] && [ "$version" != "latest" ]; then
        die "--latest-ci and --version are mutually exclusive"
    fi

    detect_target
    note "target: $OS/$ARCH"
    note "prefix: $PREFIX"
    note "ardour surfaces: $SURFACES_DIR"
    [ "$latest_ci" = 1 ] && note "source: latest passing CI on $CI_BRANCH (via nightly.link)"

    local workdir source_dir cleanup_workdir=0
    if [ -n "$from_bundle" ]; then
        [ -d "$from_bundle" ] || die "--from-bundle path not a directory: $from_bundle"
        source_dir="$from_bundle"
    elif [ "$latest_ci" = 1 ]; then
        workdir="$(mktemp -d)"
        cleanup_workdir=1
        # shellcheck disable=SC2064
        trap "rm -rf '$workdir'" EXIT
        source_dir="$(download_and_extract_ci "$workdir")"
    else
        workdir="$(mktemp -d)"
        cleanup_workdir=1
        # shellcheck disable=SC2064
        trap "rm -rf '$workdir'" EXIT
        source_dir="$(download_and_extract "$version" "$workdir")"
    fi

    install_files "$source_dir"
    add_to_path

    [ "$cleanup_workdir" = 1 ] && rm -rf "$workdir" && trap - EXIT

    cat <<EOF

foyer installed.

Open a new shell, or run:
  export PATH="$BIN_DIR:\$PATH"

Then start Ardour and enable "Foyer Studio Shim" under
  Edit → Preferences → Control Surfaces.

Uninstall later with:
  $0 uninstall          # remove files
  $0 uninstall --purge  # also wipe $PREFIX
EOF
}

do_uninstall() {
    local purge=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --purge) purge=1; shift ;;
            -h|--help) usage; exit 0 ;;
            *) die "unknown uninstall argument: $1" ;;
        esac
    done

    detect_target

    local shim_path="$SURFACES_DIR/libfoyer_shim.$SHIM_EXT"
    local foyer_path="$BIN_DIR/foyer"

    if [ -f "$shim_path" ]; then
        rm -f "$shim_path"
        note "removed $shim_path"
    fi
    if [ -f "$foyer_path" ]; then
        rm -f "$foyer_path"
        note "removed $foyer_path"
    fi

    remove_from_path

    if [ "$purge" = 1 ]; then
        if [ -d "$PREFIX" ]; then
            rm -rf "$PREFIX"
            note "purged $PREFIX"
        fi
    else
        # Best-effort: drop the now-empty bin dir but leave any
        # session/config data intact.
        rmdir "$BIN_DIR" 2>/dev/null || true
    fi

    note "foyer uninstalled."
}

main() {
    # Accept either an explicit subcommand or a bare flag (in which case
    # we default to `install` so `bash -s -- --latest-ci` works straight
    # out of a curl pipe).
    local cmd="install"
    if [ $# -gt 0 ]; then
        case "$1" in
            install|uninstall|help|-h|--help)
                cmd="$1"; shift ;;
        esac
    fi
    case "$cmd" in
        install)        do_install "$@" ;;
        uninstall)      do_uninstall "$@" ;;
        help|-h|--help) usage ;;
        *) usage; die "unknown command: $cmd" ;;
    esac
}

main "$@"
