#!/bin/bash
set -x

# Mark both workspace directories safe for git (permissions mismatch across bind mounts)
git config --global --add safe.directory /workspaces/foyer-studio
git config --global --add safe.directory /workspaces/ardour

#######################
# Ardour sibling check
#######################
if [ ! -d "/workspaces/ardour" ]; then
    echo "⚠️  ardour workspace not found at /workspaces/ardour"
    echo ""
    echo "This dev container expects ardour to be available as a sibling project."
    echo "On the host, run from the foyer-studio repo:"
    echo "  ./scripts/bootstrap-workspace.sh"
    echo ""
    echo "Continuing without ardour mount..."
else
    echo "✅ ardour sibling detected at /workspaces/ardour"
fi

#######################
# Rust toolchain info
#######################
rustc --version
cargo --version

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
