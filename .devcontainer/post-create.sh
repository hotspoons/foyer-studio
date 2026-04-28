#!/bin/bash
set -x

# Mark workspace safe for git (permissions mismatch across bind mounts)
git config --global --add safe.directory /workspaces/foyer-studio
# Ardour lives under ext/ now — same bind mount as the main repo.
git config --global --add safe.directory /workspaces/foyer-studio/ext/ardour
# Legacy sibling layout — still honored so existing workstations
# keep working until they migrate to `ext/`.
git config --global --add safe.directory /workspaces/ardour

#######################
# Ardour source tree
#######################
# Default Ardour ref for shim ABI compatibility — same default as
# scripts/dev/ardour.sh and the CI workflows. To track a different
# version, set ARDOUR_TAG in your environment (e.g. .bashrc) and rerun
# `just ardour ensure`.
ARDOUR_TAG="${ARDOUR_TAG:-9.2}"
ARDOUR_REPO_EXT="/workspaces/foyer-studio/ext/ardour"
ARDOUR_LEGACY_SIBLING="/workspaces/ardour"

ardour_ref_check() {
    local dir="$1"
    local current
    current="$(git -C "$dir" describe --tags --always 2>/dev/null || echo unknown)"
    if [ "$current" = "$ARDOUR_TAG" ]; then
        echo "✅ ardour detected at $dir (on $ARDOUR_TAG)"
    else
        echo "⚠️  ardour detected at $dir but on '$current' (target: $ARDOUR_TAG)"
        echo "   Switch with:  ARDOUR_TAG=$ARDOUR_TAG just ardour ensure"
        echo "   Or pick a different ref:  ARDOUR_TAG=<tag|branch|sha> just ardour ensure"
    fi
}

if [ -d "$ARDOUR_REPO_EXT/.git" ]; then
    ardour_ref_check "$ARDOUR_REPO_EXT"
elif [ -d "$ARDOUR_LEGACY_SIBLING/.git" ]; then
    ardour_ref_check "$ARDOUR_LEGACY_SIBLING"
    echo "   (to migrate: mv $ARDOUR_LEGACY_SIBLING $ARDOUR_REPO_EXT — optional)"
else
    echo "⚠️  ardour source not found — shim builds will fail until you run:"
    echo ""
    echo "     just ardour clone     # fetches Ardour @ $ARDOUR_TAG"
    echo "     just ardour build     # slow, one-time"
    echo ""
    echo "Override the ref:  ARDOUR_TAG=<tag|branch|sha> just ardour clone"
    echo "Continuing — stub-backend development (just run) works without ardour."
fi

#######################
# Rust toolchain info
#######################
rustc --version
cargo --version

#######################
# opencode CLI
#######################
curl -fsSL https://opencode.ai/install | bash

#######################
# Optional user post-install hook
#######################
DEVCONTAINER_USER_POST_SCRIPT_FILE=".devcontainer/.user-post-install.sh"
if [ -f "${DEVCONTAINER_USER_POST_SCRIPT_FILE}" ]; then
    bash ${DEVCONTAINER_USER_POST_SCRIPT_FILE}
else
    echo "${DEVCONTAINER_USER_POST_SCRIPT_FILE} not found, creating stub"
    {
        echo "#!/bin/bash"
        echo "# Add any user-specific post-install commands here."
        echo "# Example:"
        echo "# cargo install cargo-watch"
    } > "${DEVCONTAINER_USER_POST_SCRIPT_FILE}"
fi

echo "✅ Post-install complete!"
