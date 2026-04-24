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
ARDOUR_REPO_EXT="/workspaces/foyer-studio/ext/ardour"
ARDOUR_LEGACY_SIBLING="/workspaces/ardour"
if [ -d "$ARDOUR_REPO_EXT/.git" ]; then
    echo "✅ ardour detected at $ARDOUR_REPO_EXT (in-repo ext/)"
elif [ -d "$ARDOUR_LEGACY_SIBLING/.git" ]; then
    echo "✅ ardour detected at $ARDOUR_LEGACY_SIBLING (legacy sibling layout)"
    echo "   (to migrate: mv $ARDOUR_LEGACY_SIBLING $ARDOUR_REPO_EXT — optional)"
else
    echo "⚠️  ardour source not found — shim builds will fail until you run:"
    echo ""
    echo "     just ardour clone"
    echo "     just ardour build    # slow, one-time"
    echo ""
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
