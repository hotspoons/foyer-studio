#!/usr/bin/env bash
set -euo pipefail

# Build a macOS .dmg that contains a draggable `Foyer Studio.app`
# bundle + a symlink to /Applications. Drives off the staging dir
# already produced by `scripts/release/bundle.sh` — call it AFTER
# the .zip has been created so the foyer + foyer-desktop binaries
# are already present at `dist/foyer-macos-<arch>/`.
#
# Output: `dist/foyer-macos-<arch>.dmg` (sibling to the .zip).
#
# This script is macOS-only and only useful in release.yml's
# macos-14 cell. It does NOT replace the .zip — both ship: the
# .zip path mirrors Linux for the curl-based install.sh flow, and
# the .dmg gives the user the drag-into-Applications experience
# they expect from a Mac app.
#
# Inputs (env):
#   ARCH         arm64 | x86_64 (default: derived from uname)
#   STAGING_DIR  override the staging dir bundle.sh produced
#                (default: dist/foyer-macos-<arch>)
#   DIST_DIR     where the resulting .dmg lands
#                (default: dist/)
#
# Dependencies (all pre-installed on macos-14 runners):
#   hdiutil   — built into macOS, makes the .dmg
#   sips      — built into macOS, generates the bundle icon when
#               only the SVG is available
#
# Layout produced inside the .dmg:
#   Foyer Studio.app/        ← drag-target
#   Applications -> /Applications  ← symlink for drag-drop UX
#   README.txt               ← what-this-is

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ "$(uname -s)" != "Darwin" ]; then
    echo "macos-dmg.sh: macOS-only (uname=$(uname -s))" >&2
    exit 1
fi

ARCH="${ARCH:-}"
if [ -z "$ARCH" ]; then
    case "$(uname -m)" in
        arm64|aarch64) ARCH=arm64 ;;
        x86_64|amd64)  ARCH=x86_64 ;;
        *) echo "macos-dmg.sh: unsupported arch $(uname -m)" >&2; exit 1 ;;
    esac
fi

STAGING_DIR="${STAGING_DIR:-$ROOT_DIR/dist/foyer-macos-$ARCH}"
DIST_DIR="${DIST_DIR:-$ROOT_DIR/dist}"

if [ ! -d "$STAGING_DIR" ]; then
    echo "macos-dmg.sh: staging dir not found at $STAGING_DIR" >&2
    echo "macos-dmg.sh: run scripts/release/bundle.sh first" >&2
    exit 1
fi
if [ ! -x "$STAGING_DIR/foyer-desktop" ]; then
    echo "macos-dmg.sh: foyer-desktop binary missing in staging — re-run bundle.sh" >&2
    exit 1
fi

dmg_root="$(mktemp -d)/Foyer-Studio-${ARCH}"
mkdir -p "$dmg_root"
trap 'rm -rf "$(dirname "$dmg_root")"' EXIT

# Compose the .app bundle. Layout mirrors install.sh's
# macos_make_app_bundle so the in-DMG and the install.sh paths
# produce identical bundle shapes.
app_root="$dmg_root/Foyer Studio.app"
mkdir -p "$app_root/Contents/MacOS" "$app_root/Contents/Resources"
cp "$STAGING_DIR/foyer-desktop" "$app_root/Contents/MacOS/foyer-desktop"
chmod 0755 "$app_root/Contents/MacOS/foyer-desktop"

# Stamp the bundle version from the foyer CLI. Falls back to 0.0.0
# when --version can't be invoked (cross-compiled bundle path).
version="$( "$STAGING_DIR/foyer" --version 2>/dev/null | awk '{print $2}' | head -1 || true )"
[ -n "$version" ] || version="0.0.0"

cat > "$app_root/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key><string>en</string>
    <key>CFBundleExecutable</key><string>foyer-desktop</string>
    <key>CFBundleIdentifier</key><string>com.patapsco.foyer-studio</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleName</key><string>Foyer Studio</string>
    <key>CFBundleDisplayName</key><string>Foyer Studio</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$version</string>
    <key>CFBundleVersion</key><string>$version</string>
    <key>LSMinimumSystemVersion</key><string>11.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
    <key>CFBundleIconFile</key><string>AppIcon.icns</string>
</dict>
</plist>
EOF

# Icon — accept either a pre-generated AppIcon.icns OR fall back to
# the SVG and run it through sips to produce a single 1024×1024 PNG
# wrapped into an iconset → icns. Real production builds want a
# multi-resolution iconset; the single-resolution fallback at least
# gives the bundle some art on Finder grids.
if [ -f "$STAGING_DIR/AppIcon.icns" ]; then
    cp "$STAGING_DIR/AppIcon.icns" "$app_root/Contents/Resources/AppIcon.icns"
elif [ -f "$ROOT_DIR/web/logo.svg" ]; then
    iconset="$dmg_root/AppIcon.iconset"
    mkdir -p "$iconset"
    sips -s format png "$ROOT_DIR/web/logo.svg" \
        --resampleHeightWidth 1024 1024 \
        --out "$iconset/icon_512x512@2x.png" >/dev/null
    iconutil -c icns "$iconset" -o "$app_root/Contents/Resources/AppIcon.icns" || true
    rm -rf "$iconset"
fi

# Also bundle the foyer CLI alongside foyer-desktop so commands
# the desktop spawns (`foyer doctor-host`, `foyer docker …`) work
# without the user manually putting `foyer` on PATH. The .app's
# MacOS dir is the binary's runtime cwd-ish — foyer-desktop's
# find_foyer_binary() helper already looks here first.
cp "$STAGING_DIR/foyer" "$app_root/Contents/MacOS/foyer"
chmod 0755 "$app_root/Contents/MacOS/foyer"

# Ad-hoc sign so Gatekeeper accepts the bundle when the user
# double-clicks it after dragging into /Applications. install.sh
# does the same for the per-user copy. Notarization is a separate
# step the project will adopt once Apple Developer enrollment
# lands; until then, ad-hoc keeps the launch flow working as long
# as the user clicks through Gatekeeper's first-launch warning.
xattr -dr com.apple.quarantine "$app_root" 2>/dev/null || true
codesign --force --deep --sign - "$app_root" 2>/dev/null \
    || echo "macos-dmg.sh: codesign --sign - failed (best-effort; ok in CI without keychain)" >&2

# Drag-drop UX: symlink to /Applications so the user drops the
# .app into the symlink instead of trekking to Finder's sidebar.
ln -s /Applications "$dmg_root/Applications"

# README — a one-line "drag the app to Applications" so DMG viewers
# without the symlink (rare) still get the gist.
cat > "$dmg_root/README.txt" <<'EOF'
Foyer Studio
============

Drag "Foyer Studio.app" onto the Applications symlink to install.

On first launch, macOS may warn that the bundle is from an
"unidentified developer" — right-click the app, pick "Open", then
click "Open" in the dialog. That stamps Gatekeeper's quarantine
attribute as user-approved; subsequent launches don't prompt.

Foyer on Windows / Linux installs via:
  curl -fsSL https://github.com/hotspoons/foyer-studio/releases/latest/download/install.sh | bash
  irm https://raw.githubusercontent.com/hotspoons/foyer-studio/main/install.ps1 | iex

Source + docs: https://github.com/hotspoons/foyer-studio
EOF

mkdir -p "$DIST_DIR"
dmg_path="$DIST_DIR/foyer-macos-$ARCH.dmg"
rm -f "$dmg_path"

# `hdiutil create -srcfolder` packages the dir into an HFS+ DMG.
# UDZO = compressed read-only, the standard distribution format.
# `-volname` is what Finder shows in the sidebar when the DMG is
# mounted.
hdiutil create \
    -volname "Foyer Studio" \
    -srcfolder "$dmg_root" \
    -ov \
    -format UDZO \
    "$dmg_path"

echo "macos-dmg.sh: $dmg_path"
ls -lh "$dmg_path"
