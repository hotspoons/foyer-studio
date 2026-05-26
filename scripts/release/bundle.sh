#!/usr/bin/env bash
set -euo pipefail

# Bundles `foyer` + (Linux) `foyer-desktop` + `libfoyer_shim.{so,dylib}`
# into a per-platform zip. Driven by env vars so both the GitHub Actions
# matrix and a `just release-bundle` local invocation produce identical
# layouts.
#
# Inputs (env):
#   OS_LABEL          linux | macos    (default: derived from `uname -s`)
#   ARCH              x86_64 | arm64   (default: derived from `uname -m`)
#   FOYER_BIN         path to release foyer binary
#                     (default: target/release/foyer)
#   FOYER_DESKTOP_BIN path to release foyer-desktop binary (Linux only)
#                     (default: target/release/foyer-desktop)
#   SHIM_LIB          path to built shim library
#                     (default: shims/ardour/cmake-build/libfoyer_shim.{so,dylib})
#   FOYER_SKIP_SHIM=1 ship a foyer-only bundle (used by macOS CI today)
#   FOYER_SKIP_DESKTOP=1 ship without foyer-desktop even on Linux
#                     (set automatically when the binary is missing)
#
# Output:
#   dist/foyer-<os>-<arch>.zip
#
# Layout inside the zip:
#   foyer-<os>-<arch>/
#     foyer                       (executable, fully-static on Linux)
#     foyer-desktop               (Linux only — needs libgtk-3,
#                                  libwebkit2gtk-4.1 at runtime)
#     foyer-studio.svg            (Linux only — menu/icon glyph)
#     foyer-studio.desktop        (Linux only — XDG menu entry)
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
        MINGW*|MSYS*|CYGWIN*|Windows_NT) OS_LABEL=windows ;;
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
    linux)   shim_ext=so ;     bin_ext=""    ;;
    macos)   shim_ext=dylib ;  bin_ext=""    ;;
    # Windows: no shim (Ardour doesn't run on Windows — Windows users
    # run Foyer's backend in Docker Desktop). Binaries get a .exe
    # suffix; bundle script stages them with that extension so
    # install.ps1 can `Copy-Item` directly.
    windows) shim_ext=""    ;  bin_ext=".exe" ;;
    *) echo "bundle: unsupported OS_LABEL '$OS_LABEL'" >&2; exit 1 ;;
esac

FOYER_BIN="${FOYER_BIN:-$ROOT_DIR/target/release/foyer$bin_ext}"
FOYER_DESKTOP_BIN="${FOYER_DESKTOP_BIN:-$ROOT_DIR/target/release/foyer-desktop$bin_ext}"
SHIM_LIB="${SHIM_LIB:-$ROOT_DIR/shims/ardour/cmake-build/libfoyer_shim.$shim_ext}"
SKIP_SHIM="${FOYER_SKIP_SHIM:-0}"
# Windows never carries a shim (no Linux/macOS Ardour to load it).
# Force-skip without making the caller think to set FOYER_SKIP_SHIM.
if [ "$OS_LABEL" = "windows" ]; then
    SKIP_SHIM=1
fi
# foyer-desktop ships for all three OSes now. Skip automatically when
# the binary isn't where we expect (e.g. the user ran release-bundle
# without first building it). Older CI/local invocations may still set
# FOYER_SKIP_DESKTOP=1 to opt out — we honor that.
SKIP_DESKTOP="${FOYER_SKIP_DESKTOP:-0}"
if [ "$SKIP_DESKTOP" != "1" ] && [ ! -x "$FOYER_DESKTOP_BIN" ]; then
    echo "bundle: foyer-desktop binary missing at $FOYER_DESKTOP_BIN — skipping" >&2
    echo "bundle: build it first with:" >&2
    echo "    cargo build --release --bin foyer-desktop" >&2
    SKIP_DESKTOP=1
fi

if [ ! -x "$FOYER_BIN" ]; then
    echo "bundle: foyer binary missing at $FOYER_BIN" >&2
    echo "bundle: run \`cargo build --release --bin foyer\` first" >&2
    exit 1
fi
if [ "$SKIP_SHIM" != "1" ] && [ ! -f "$SHIM_LIB" ]; then
    echo "bundle: shim library missing at $SHIM_LIB" >&2
    echo "bundle: run \`./scripts/dev/shim.sh build\` (needs Ardour built)" >&2
    echo "bundle: or set FOYER_SKIP_SHIM=1 for a foyer-only bundle" >&2
    exit 1
fi

bundle_name="foyer-$OS_LABEL-$ARCH"
asset_name="$bundle_name.zip"

dist_dir="$ROOT_DIR/dist"
staging="$dist_dir/$bundle_name"

rm -rf "${staging:?}" "${dist_dir:?}/${asset_name:?}"
mkdir -p "$staging"

cp "$FOYER_BIN" "$staging/foyer$bin_ext"
chmod 0755 "$staging/foyer$bin_ext"
if [ "$SKIP_SHIM" != "1" ]; then
    cp "$SHIM_LIB" "$staging/libfoyer_shim.$shim_ext"
    chmod 0644 "$staging/libfoyer_shim.$shim_ext"
fi

# Per-OS launcher artifacts. Linux gets the XDG menu + icon, macOS
# gets the .icns when available (install.sh builds the .app bundle
# itself), Windows gets just the .exe — install.ps1 writes the .lnk
# directly via WScript.Shell, no need for a templated shortcut file
# in the zip.
if [ "$SKIP_DESKTOP" != "1" ]; then
    cp "$FOYER_DESKTOP_BIN" "$staging/foyer-desktop$bin_ext"
    chmod 0755 "$staging/foyer-desktop$bin_ext"

    if [ "$OS_LABEL" = "linux" ]; then
        # Icon — the mixer-fader logo (`web/logo.svg`), NOT the smaller
        # web favicon. SVG works in every modern XDG menu (GNOME /
        # KDE / XFCE / sway-launchers all consume
        # `~/.local/share/icons/hicolor/scalable/apps/`).
        cp "$ROOT_DIR/web/logo.svg" "$staging/foyer-studio.svg"
        chmod 0644 "$staging/foyer-studio.svg"

        # .desktop template — install.sh rewrites `Exec=` with the
        # absolute path it installed `foyer-desktop` to. Keeping the
        # template in the bundle (rather than generated by install.sh
        # alone) means an admin doing a manual / packaged install
        # gets the same XDG entry layout for free.
        cat > "$staging/foyer-studio.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Foyer Studio
GenericName=DAW Control Surface
Comment=Web-native control surface for the Ardour DAW
# `Exec=` is rewritten by install.sh to the absolute path of the
# installed foyer-desktop binary so the entry survives a custom
# FOYER_PREFIX install. The packaged form below assumes the default
# install location and is what `desktop-file-validate` lints.
Exec=foyer-desktop
TryExec=foyer-desktop
Icon=foyer-studio
Terminal=false
Categories=AudioVideo;Audio;AudioEditing;Music;
Keywords=Ardour;DAW;Audio;Music;Mixer;Studio;
StartupNotify=true
StartupWMClass=Foyer Studio
EOF
        chmod 0644 "$staging/foyer-studio.desktop"
    fi

    if [ "$OS_LABEL" = "macos" ]; then
        # The .icns lives at web/logo.icns when CI's iconutil step has
        # produced one; otherwise skip and install.sh will fall back
        # to the system default app glyph. Generation lives in
        # scripts/release/macos-dmg.sh (future) which iconutils the
        # SVG into a .iconset → .icns at release time.
        if [ -f "$ROOT_DIR/web/logo.icns" ]; then
            cp "$ROOT_DIR/web/logo.icns" "$staging/AppIcon.icns"
            chmod 0644 "$staging/AppIcon.icns"
        fi
    fi
fi

cp "$ROOT_DIR/LICENSE" "$staging/LICENSE"
# LICENSE-GPL is only relevant when the shim is bundled.
if [ "$SKIP_SHIM" != "1" ]; then
    cp "$ROOT_DIR/shims/ardour/LICENSE-GPL" "$staging/LICENSE-GPL"
fi
cp "$ROOT_DIR/install.sh" "$staging/install.sh"
chmod 0755 "$staging/install.sh"

if [ "$SKIP_SHIM" = "1" ]; then
    cat > "$staging/README.txt" <<EOF
Foyer Studio — $OS_LABEL/$ARCH (foyer only)
============================================

Contents:
  foyer                       Web-native control-surface server (Apache-2.0)
  install.sh                  One-shot installer (mirror of repo HEAD)

This bundle is foyer-only — the Ardour shim isn't shipped on $OS_LABEL/$ARCH
yet. The 'foyer' binary works against the stub backend (demo mode) and can
talk to a remote Ardour over the network. To run against a local Ardour you
need libfoyer_shim built locally:

  git clone https://github.com/foyer-studio/foyer-studio
  cd foyer-studio
  just ardour ensure       # clones + builds Ardour (slow, one-time)
  just shim install        # builds + drops the .dylib into Ardour's surfaces

Quick install (foyer binary only):
  ./install.sh install --from-bundle .

Or from the network:
  curl -fsSL https://github.com/foyer-studio/foyer-studio/releases/latest/download/install.sh | bash

Uninstall:
  ./install.sh uninstall            # remove binary
  ./install.sh uninstall --purge    # also wipe ~/.local/share/foyer/
EOF
else
    desktop_blurb=""
    if [ "$SKIP_DESKTOP" != "1" ]; then
        desktop_blurb=$(cat <<EOF

  foyer-desktop               Native window shell (tao+wry). Linux only;
                              needs GTK3 + WebKit2GTK at runtime —
                              install.sh prints distro-specific commands.
  foyer-studio.svg            App icon (XDG hicolor)
  foyer-studio.desktop        XDG menu entry template
EOF
)
    fi
    cat > "$staging/README.txt" <<EOF
Foyer Studio — $OS_LABEL/$ARCH
================================

Contents:
  foyer                       Web-native control-surface server (Apache-2.0)$desktop_blurb
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

Built against Ardour ${ARDOUR_TAG:-9.5}. The shim covers the 9.x
ABI family via the version-skew guards in shims/ardour/src/
ardour_version.h; mixing with major versions (8.x, 10.x) is
undefined behavior.
EOF
fi

mkdir -p "$dist_dir"
( cd "$dist_dir" && zip -qr "$asset_name" "$bundle_name" )

echo "bundle: $dist_dir/$asset_name"
ls -lh "$dist_dir/$asset_name"
