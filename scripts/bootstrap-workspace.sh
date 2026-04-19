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
ARDOUR_REPO="https://github.com/Ardour/ardour.git"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     Foyer Studio - Workspace Bootstrap                         ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

open_workspace() {
    local workspace_file="$1"
    if command -v code &> /dev/null; then
        code "$workspace_file"
        echo "✅ Opened workspace in VSCode: $workspace_file"
        echo ""
        echo "Click 'Reopen in Container' when prompted to start developing!"
    else
        echo "VSCode 'code' command not found in PATH."
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
    else
        echo "ardour not found at: $ARDOUR_DIR"
        echo ">>> Cloning ardour as a sibling..."
        git clone "$ARDOUR_REPO" "$ARDOUR_DIR"
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
TARGET_DIR="${1:-}"
WORKSPACE_NAME="${2:-foyer-workspace}"

if [ -z "$TARGET_DIR" ]; then
    echo "Usage: $0 <target-directory> [workspace-name]"
    echo ""
    echo "Examples:"
    echo ""
    echo "  Fresh setup (clone both repos):"
    echo "    $0 ~/dev                    # Creates ~/dev/foyer-workspace"
    echo "    $0 ~/dev my-workspace       # Creates ~/dev/my-workspace"
    echo ""
    echo "  From existing foyer-studio repo:"
    echo "    cd /path/to/foyer-studio"
    echo "    ./scripts/bootstrap-workspace.sh  # Clones ardour sibling if missing"
    echo ""
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
        echo ">>> Cloning ardour..."
        git clone "$ARDOUR_REPO" "$WORKSPACE_DIR/ardour"
    elif [ "$FOYER_EXISTS" = false ] && [ "$ARDOUR_EXISTS" = true ]; then
        echo ">>> Cloning foyer-studio..."
        git clone "$FOYER_REPO" "$WORKSPACE_DIR/foyer-studio"
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

    echo ">>> Cloning ardour"
    git clone "$ARDOUR_REPO" "$WORKSPACE_DIR/ardour"
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
