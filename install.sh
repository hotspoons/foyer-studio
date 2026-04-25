#!/usr/bin/env bash
set -euo pipefail

# Foyer Studio one-shot installer.
#
# Usage (network install):
#   curl -fsSL https://github.com/foyer-studio/foyer-studio/releases/latest/download/install.sh | bash
#
# Usage (explicit):
#   ./install.sh install                       # latest release
#   ./install.sh install --version v0.1.0
#   ./install.sh install --from-bundle ./dir   # use an extracted zip
#   ./install.sh uninstall                     # remove binary + shim
#   ./install.sh uninstall --purge             # also wipe ~/.local/share/foyer/
#
# Env overrides:
#   FOYER_RELEASE_REPO  owner/repo to fetch from (default: foyer-studio/foyer-studio)
#   FOYER_PREFIX        install root (default: $XDG_DATA_HOME/foyer or ~/.local/share/foyer)
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

REPO="${FOYER_RELEASE_REPO:-foyer-studio/foyer-studio}"
PREFIX="${FOYER_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/foyer}"
BIN_DIR="$PREFIX/bin"
PATH_SENTINEL="# foyer-studio installer (managed)"

OS=""
ARCH=""
SHIM_EXT=""
SURFACES_DIR=""

die() { echo "install.sh: $*" >&2; exit 1; }
note() { echo "==> $*"; }

usage() {
    cat <<EOF
foyer installer

Commands:
  install [--version vX.Y.Z] [--from-bundle DIR]
                                  Fetch + install foyer + shim.
  uninstall [--purge]             Remove foyer + shim. --purge wipes
                                  $PREFIX entirely.
  help                            Show this help.

Env:
  FOYER_RELEASE_REPO  owner/repo (default: $REPO)
  FOYER_PREFIX        install root (default: $PREFIX)
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

install_files() {
    local source_dir="$1"
    local foyer_src="$source_dir/foyer"
    local shim_src="$source_dir/libfoyer_shim.$SHIM_EXT"
    [ -x "$foyer_src" ] || [ -f "$foyer_src" ] || die "missing $foyer_src in bundle"
    [ -f "$shim_src" ] || die "missing $shim_src in bundle"

    mkdir -p "$BIN_DIR" "$SURFACES_DIR"
    install -m 0755 "$foyer_src" "$BIN_DIR/foyer"
    install -m 0644 "$shim_src" "$SURFACES_DIR/libfoyer_shim.$SHIM_EXT"
    note "installed $BIN_DIR/foyer"
    note "installed $SURFACES_DIR/libfoyer_shim.$SHIM_EXT"

    # Strip the quarantine xattr macOS slaps on downloaded archives —
    # without this Gatekeeper blocks dlopen of the shim and refuses to
    # exec the foyer binary on first launch.
    if [ "$OS" = "macos" ]; then
        xattr -dr com.apple.quarantine "$BIN_DIR/foyer" 2>/dev/null || true
        xattr -dr com.apple.quarantine "$SURFACES_DIR/libfoyer_shim.$SHIM_EXT" 2>/dev/null || true
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
    while [ $# -gt 0 ]; do
        case "$1" in
            --version)    version="$2"; shift 2 ;;
            --version=*)  version="${1#*=}"; shift ;;
            --from-bundle) from_bundle="$2"; shift 2 ;;
            --from-bundle=*) from_bundle="${1#*=}"; shift ;;
            -h|--help) usage; exit 0 ;;
            *) die "unknown install argument: $1" ;;
        esac
    done

    detect_target
    note "target: $OS/$ARCH"
    note "prefix: $PREFIX"
    note "ardour surfaces: $SURFACES_DIR"

    local workdir source_dir cleanup_workdir=0
    if [ -n "$from_bundle" ]; then
        [ -d "$from_bundle" ] || die "--from-bundle path not a directory: $from_bundle"
        source_dir="$from_bundle"
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
    local cmd="${1:-install}"
    [ $# -gt 0 ] && shift || true
    case "$cmd" in
        install)        do_install "$@" ;;
        uninstall)      do_uninstall "$@" ;;
        help|-h|--help) usage ;;
        *) usage; die "unknown command: $cmd" ;;
    esac
}

main "$@"
