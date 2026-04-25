#!/bin/bash
set -euo pipefail

# Bootstrap script: Ensures ardour is available as a sibling to foyer-studio
# and opens the multi-root workspace in VSCode.
#
# Modes:
#   1. Run from within foyer-studio -> verifies/clones ardour sibling, opens workspace
#   2. Fresh setup with target dir  -> clones both repos into target dir, opens workspace

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FOYER_REPO="https://github.com/foyer-studio/foyer-studio.git"
# Always use Ardour proper and fetch release tags from there. Ardour's waf
# configure reads version/tag metadata and can fail on tagless clones.
ARDOUR_REPO="https://github.com/Ardour/ardour.git"
# Source project + per-dev .env files for ARDOUR_TAG and friends.
# Precedence: shell env > .env.local (gitignored) > .env (committed).
# Bootstrap may run before the foyer-studio repo is cloned — guard
# the path lookup so we don't crash in fresh-setup mode.
__foyer_repo="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"
if [ -n "$__foyer_repo" ] && [ -z "${ARDOUR_TAG:-}" ]; then
    for f in "$__foyer_repo/.env" "$__foyer_repo/.env.local"; do
        if [ -f "$f" ]; then
            set -a
            # shellcheck disable=SC1090
            . "$f"
            set +a
        fi
    done
fi
unset __foyer_repo

# Ardour ref (tag/branch/SHA) the shim ABI is locked to. Default
# lives in `.env`; final fallback is `9.2`. Override with shell env:
# `ARDOUR_TAG=master ./scripts/bootstrap-workspace.sh`.
ARDOUR_TAG="${ARDOUR_TAG:-9.2}"
EDITOR_CMD="${FOYER_WORKSPACE_EDITOR:-code}"

print_usage() {
    cat <<EOF
Usage:
  $0 [--editor <cmd>] [<target-directory> [workspace-name]]

Options:
  --editor <cmd>   VSCode-compatible CLI command to open the workspace
                   (examples: code, cursor, codium)
  -h, --help       Show this help

Environment:
  FOYER_WORKSPACE_EDITOR
      Default VSCode-compatible command when --editor is not provided.

Examples:
  Fresh setup (clone both repos):
    $0 ~/dev
    $0 --editor cursor ~/dev my-workspace

  Existing foyer-studio checkout:
    FOYER_WORKSPACE_EDITOR=cursor ./scripts/bootstrap-workspace.sh
EOF
}

POSITIONAL_ARGS=()
while (($#)); do
    case "$1" in
        --editor)
            if [ $# -lt 2 ]; then
                echo "Missing value for --editor"
                echo ""
                print_usage
                exit 1
            fi
            EDITOR_CMD="$2"
            shift 2
            ;;
        --editor=*)
            EDITOR_CMD="${1#*=}"
            shift
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        --)
            shift
            while (($#)); do
                POSITIONAL_ARGS+=("$1")
                shift
            done
            ;;
        -*)
            echo "Unknown option: $1"
            echo ""
            print_usage
            exit 1
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

if [ "${#POSITIONAL_ARGS[@]}" -gt 2 ]; then
    echo "Too many positional arguments."
    echo ""
    print_usage
    exit 1
fi

# Ensure ardour's origin points at Ardour proper, release tags are
# present, and the working tree is on $ARDOUR_TAG. Idempotent — if
# already on the right ref this just verifies + returns.
ensure_ardour_origin_and_tags() {
    local dest="$1"
    local current_origin
    current_origin="$(git -C "$dest" remote get-url origin 2>/dev/null || true)"
    if [ "$current_origin" != "$ARDOUR_REPO" ]; then
        echo "  updating ardour origin: $current_origin -> $ARDOUR_REPO"
        git -C "$dest" remote set-url origin "$ARDOUR_REPO"
    fi
    echo "  fetching ardour tags from origin..."
    git -C "$dest" fetch --tags origin
    # Move the working tree to $ARDOUR_TAG if it isn't already there.
    # Skip silently when the user has uncommitted changes — they may
    # be hacking on Ardour locally and we don't want to clobber it.
    local current_ref
    current_ref="$(git -C "$dest" describe --tags --always 2>/dev/null || echo unknown)"
    if [ "$current_ref" != "$ARDOUR_TAG" ]; then
        if [ -n "$(git -C "$dest" status --porcelain)" ]; then
            echo "  ⚠  ardour has uncommitted changes — leaving on $current_ref (target: $ARDOUR_TAG)"
        else
            echo "  switching ardour to $ARDOUR_TAG (was $current_ref)"
            git -C "$dest" -c advice.detachedHead=false checkout "$ARDOUR_TAG"
        fi
    fi
}

# Clone ardour into $1 from Ardour proper, pin to $ARDOUR_TAG.
clone_ardour() {
    local dest="$1"
    # Try `--branch $ARDOUR_TAG` first (works for tags + branches).
    # Fall back to clone-then-fetch-by-SHA for commit refs.
    if ! git -c advice.detachedHead=false clone \
            --depth 1 --branch "$ARDOUR_TAG" \
            "$ARDOUR_REPO" "$dest" 2>/dev/null; then
        echo "  '$ARDOUR_TAG' isn't a tag/branch — fetching as commit SHA"
        rm -rf "$dest"
        git clone "$ARDOUR_REPO" "$dest"
        git -C "$dest" -c advice.detachedHead=false checkout "$ARDOUR_TAG"
    fi
    ensure_ardour_origin_and_tags "$dest"
    echo "  ardour ref:      $(git -C "$dest" describe --tags --always)"
    echo "  ardour origin:   $(git -C "$dest" remote get-url origin)"
}

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     Foyer Studio - Workspace Bootstrap                         ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

open_workspace() {
    local workspace_file="$1"
    if command -v "$EDITOR_CMD" &> /dev/null; then
        "$EDITOR_CMD" "$workspace_file"
        echo "✅ Opened workspace with '$EDITOR_CMD': $workspace_file"
        echo ""
        echo "Click 'Reopen in Container' when prompted to start developing!"
    else
        echo "Workspace opener '$EDITOR_CMD' not found in PATH."
        echo "Manually open: $workspace_file"
        echo ""
        echo "Then click 'Reopen in Container'."
    fi
}

# Detect if we're running from within the foyer-studio repo
if [ -f "$SCRIPT_DIR/../foyer-studio.code-workspace" ]; then
    FOYER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
    PARENT_DIR="$(dirname "$FOYER_DIR")"
    ARDOUR_DIR="$PARENT_DIR/ardour"
    WORKSPACE_FILE="$FOYER_DIR/foyer-studio.code-workspace"

    echo "Running from existing foyer-studio at: $FOYER_DIR"
    echo ""

    if [ -d "$ARDOUR_DIR" ]; then
        echo "✅ ardour already exists at: $ARDOUR_DIR"
        ensure_ardour_origin_and_tags "$ARDOUR_DIR"
    else
        echo "ardour not found at: $ARDOUR_DIR"
        echo ">>> Cloning Ardour proper..."
        clone_ardour "$ARDOUR_DIR"
        echo "✅ ardour cloned"
    fi

    echo ""
    echo "Workspace structure:"
    echo "  $PARENT_DIR/"
    echo "  ├── $(basename "$FOYER_DIR")/  # Foyer Studio (primary)"
    echo "  └── ardour/                    # Ardour (sibling)"
    echo ""

    open_workspace "$WORKSPACE_FILE"
    exit 0
fi

# Fresh setup mode
TARGET_DIR="${POSITIONAL_ARGS[0]:-}"
WORKSPACE_NAME="${POSITIONAL_ARGS[1]:-foyer-workspace}"

if [ -z "$TARGET_DIR" ]; then
    print_usage
    exit 1
fi

WORKSPACE_DIR="${TARGET_DIR}/${WORKSPACE_NAME}"

echo "Setting up fresh workspace at: $WORKSPACE_DIR"
echo ""

if [ -d "$WORKSPACE_DIR" ]; then
    FOYER_EXISTS=false
    ARDOUR_EXISTS=false
    [ -d "$WORKSPACE_DIR/foyer-studio" ] && FOYER_EXISTS=true
    [ -d "$WORKSPACE_DIR/ardour" ] && ARDOUR_EXISTS=true

    if [ "$FOYER_EXISTS" = true ] && [ "$ARDOUR_EXISTS" = true ]; then
        echo "✅ Both projects already exist at $WORKSPACE_DIR"
        open_workspace "$WORKSPACE_DIR/foyer-studio/foyer-studio.code-workspace"
        exit 0
    fi

    if [ "$FOYER_EXISTS" = true ] && [ "$ARDOUR_EXISTS" = false ]; then
        echo ">>> Cloning Ardour proper..."
        clone_ardour "$WORKSPACE_DIR/ardour"
    elif [ "$FOYER_EXISTS" = false ] && [ "$ARDOUR_EXISTS" = true ]; then
        echo ">>> Cloning foyer-studio..."
        git clone "$FOYER_REPO" "$WORKSPACE_DIR/foyer-studio"
        ensure_ardour_origin_and_tags "$WORKSPACE_DIR/ardour"
    else
        read -p "Directory exists but is empty-ish. Remove and start fresh? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            rm -rf "$WORKSPACE_DIR"
        else
            echo "❌ Bootstrap cancelled"
            exit 1
        fi
    fi
fi

if [ ! -d "$WORKSPACE_DIR" ]; then
    echo ">>> Creating workspace directory"
    mkdir -p "$WORKSPACE_DIR"

    echo ">>> Cloning foyer-studio"
    git clone "$FOYER_REPO" "$WORKSPACE_DIR/foyer-studio"

    echo ">>> Cloning Ardour proper"
    clone_ardour "$WORKSPACE_DIR/ardour"
fi

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  Workspace Setup Complete!                                     ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Workspace structure:"
echo "  $WORKSPACE_DIR/"
echo "  ├── foyer-studio/  # Primary project"
echo "  └── ardour/        # Sibling project"
echo ""

open_workspace "$WORKSPACE_DIR/foyer-studio/foyer-studio.code-workspace"
