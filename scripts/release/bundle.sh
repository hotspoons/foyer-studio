#!/usr/bin/env bash
set -euo pipefail

# Bundles `foyer` + `libfoyer_shim.{so,dylib}` into a per-platform zip.
# Driven by env vars so both the GitHub Actions matrix and a
# `just release-bundle` local invocation produce identical layouts.
#
# Inputs (env):
#   OS_LABEL   linux | macos    (default: derived from `uname -s`)
#   ARCH       x86_64 | arm64   (default: derived from `uname -m`)
#   FOYER_BIN  path to release foyer binary (default: target/release/foyer)
#   SHIM_LIB   path to built shim library
#              (default: shims/ardour/cmake-build/libfoyer_shim.{so,dylib})
#
# Output:
#   dist/foyer-<os>-<arch>.zip
#
# Layout inside the zip:
#   foyer-<os>-<arch>/
#     foyer                       (executable)
#     libfoyer_shim.{so,dylib}    (control surface plugin)
#     README.txt                  (terse what-this-is)
#     LICENSE                     (top-level Apache-2.0)
#     LICENSE-GPL                 (shim's GPLv2-or-later — applies to
#                                  libfoyer_shim only; rest of the
#                                  bundle is Apache-2.0)
#     install.sh                  (mirrored copy for offline install)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# Derive defaults from `uname` so a local `just release-bundle` works
# without env wiring.
if [ -z "${OS_LABEL:-}" ]; then
    case "$(uname -s)" in
        Linux)  OS_LABEL=linux ;;
        Darwin) OS_LABEL=macos ;;
        *) echo "bundle: unsupported OS $(uname -s)" >&2; exit 1 ;;
    esac
fi
if [ -z "${ARCH:-}" ]; then
    case "$(uname -m)" in
        x86_64|amd64) ARCH=x86_64 ;;
        aarch64|arm64) ARCH=arm64 ;;
        *) echo "bundle: unsupported arch $(uname -m)" >&2; exit 1 ;;
    esac
fi

case "$OS_LABEL" in
    linux) shim_ext=so ;;
    macos) shim_ext=dylib ;;
    *) echo "bundle: unsupported OS_LABEL '$OS_LABEL'" >&2; exit 1 ;;
esac

FOYER_BIN="${FOYER_BIN:-$ROOT_DIR/target/release/foyer}"
SHIM_LIB="${SHIM_LIB:-$ROOT_DIR/shims/ardour/cmake-build/libfoyer_shim.$shim_ext}"

if [ ! -x "$FOYER_BIN" ]; then
    echo "bundle: foyer binary missing at $FOYER_BIN" >&2
    echo "bundle: run \`cargo build --release --bin foyer\` first" >&2
    exit 1
fi
if [ ! -f "$SHIM_LIB" ]; then
    echo "bundle: shim library missing at $SHIM_LIB" >&2
    echo "bundle: run \`./scripts/dev/shim.sh build\` (needs Ardour built)" >&2
    exit 1
fi

bundle_name="foyer-$OS_LABEL-$ARCH"
asset_name="$bundle_name.zip"

dist_dir="$ROOT_DIR/dist"
staging="$dist_dir/$bundle_name"

rm -rf "${staging:?}" "${dist_dir:?}/${asset_name:?}"
mkdir -p "$staging"

cp "$FOYER_BIN" "$staging/foyer"
chmod 0755 "$staging/foyer"
cp "$SHIM_LIB" "$staging/libfoyer_shim.$shim_ext"
chmod 0644 "$staging/libfoyer_shim.$shim_ext"

cp "$ROOT_DIR/LICENSE" "$staging/LICENSE"
cp "$ROOT_DIR/shims/ardour/LICENSE-GPL" "$staging/LICENSE-GPL"
cp "$ROOT_DIR/install.sh" "$staging/install.sh"
chmod 0755 "$staging/install.sh"

cat > "$staging/README.txt" <<EOF
Foyer Studio — $OS_LABEL/$ARCH
================================

Contents:
  foyer                       Web-native control-surface server (Apache-2.0)
  libfoyer_shim.$shim_ext           Ardour control surface plugin (GPLv2+,
                              see LICENSE-GPL — links libardour)
  install.sh                  One-shot installer (mirror of repo HEAD)

Quick install (run in this directory):
  ./install.sh install --from-bundle .

Or from the network:
  curl -fsSL https://github.com/foyer-studio/foyer-studio/releases/latest/download/install.sh | bash

Manual install:
  1. Drop libfoyer_shim.$shim_ext into:
       Linux:  ~/.config/ardour9/surfaces/
       macOS:  ~/Library/Preferences/Ardour9/surfaces/
  2. Drop foyer somewhere on PATH (e.g. ~/.local/share/foyer/bin/).
  3. Open Ardour → Preferences → Control Surfaces → enable
     "Foyer Studio Shim".

Uninstall:
  ./install.sh uninstall            # remove binary + shim
  ./install.sh uninstall --purge    # also wipe ~/.local/share/foyer/

Built against Ardour ${ARDOUR_TAG:-9.2}. The shim is ABI-locked to
the Ardour minor version above; using it with a different Ardour
build is undefined behavior.
EOF

mkdir -p "$dist_dir"
( cd "$dist_dir" && zip -qr "$asset_name" "$bundle_name" )

echo "bundle: $dist_dir/$asset_name"
ls -lh "$dist_dir/$asset_name"
