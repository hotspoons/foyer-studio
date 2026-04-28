#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN_DIR="$ROOT_DIR/.bin"
BIN="$BIN_DIR/tailwindcss"
DOWNLOAD_BASE="https://github.com/tailwindlabs/tailwindcss/releases/latest/download"

usage() {
    cat <<'EOF'
tw subcommands:
  help     Print this help
  install  Install standalone tailwindcss binary
  build    Build web/styles/tw.build.css
  watch    Watch and rebuild CSS
  check    Rebuild only when output is missing/stale
EOF
}

install_tw() {
    mkdir -p "$BIN_DIR"
    if [ -x "$BIN" ]; then
        echo "tw: using existing $BIN"
        return
    fi
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64) arch="x64" ;;
        aarch64|arm64) arch="arm64" ;;
        *) echo "tw: unsupported architecture: $arch"; exit 1 ;;
    esac
    # Tailwind v4 renamed the macOS asset from `darwin` to `macos`.
    # Normalise here so the URL still resolves on both v3 and v4 (v3
    # also publishes a `macos-*` symlink as of recent releases).
    case "$os" in
        linux) ;;
        darwin) os="macos" ;;
        *) echo "tw: unsupported OS: $os"; exit 1 ;;
    esac
    url="$DOWNLOAD_BASE/tailwindcss-$os-$arch"
    echo "tw: downloading $url"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$BIN"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$BIN" "$url"
    else
        echo "tw: need curl or wget"
        exit 1
    fi
    chmod +x "$BIN"
    "$BIN" --help >/dev/null
    echo "tw: installed $BIN"
}

do_build() {
    install_tw
    "$BIN" -i "$ROOT_DIR/web/styles/tw.css" -o "$ROOT_DIR/web/styles/tw.build.css" --minify
}

do_check() {
    built="$ROOT_DIR/web/styles/tw.build.css"
    if [ ! -s "$built" ]; then
        echo "tw: missing/empty output, rebuilding"
        do_build
        return
    fi
    newer="$(find "$ROOT_DIR/web/src" "$ROOT_DIR/web/index.html" "$ROOT_DIR/web/styles/tw.css" -newer "$built" -print -quit 2>/dev/null || true)"
    if [ -n "$newer" ]; then
        echo "tw: stale ($newer newer than $built), rebuilding"
        do_build
        return
    fi
    echo "tw: up to date"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
    help) usage ;;
    install) install_tw ;;
    build) do_build ;;
    watch)
        install_tw
        "$BIN" -i "$ROOT_DIR/web/styles/tw.css" -o "$ROOT_DIR/web/styles/tw.build.css" --watch
        ;;
    check) do_check ;;
    *)
        echo "Unknown tw subcommand: $cmd"
        usage
        exit 1
        ;;
esac
