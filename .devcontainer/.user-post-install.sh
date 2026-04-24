#!/bin/bash
# Dev-container user post-install — persistent across rebuilds.
#
# Installs Node (via nvm), Bun, and Playwright + its Chromium deps for
# browser-driven UI tests. These are DEV-TIME ONLY tools — the shipping
# Foyer pipeline does not use npm/Node/bundlers; `web/` stays vendored
# ES modules + import map served directly from the Rust binary.
#
# Idempotent: safe to re-run; skips anything already present.

set -euo pipefail

log() { printf '\033[1;36m[user-post-install]\033[0m %s\n' "$*"; }

#######################
# Node via nvm
#######################
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    log "installing nvm"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
if ! command -v node >/dev/null 2>&1; then
    log "installing node lts"
    nvm install --lts
    nvm alias default 'lts/*'
fi
log "node $(node --version)"

#######################
# Bun
#######################
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
    log "installing bun"
    curl -fsSL https://bun.sh/install | bash
fi
log "bun $(bun --version)"

#######################
# Playwright (global via bun, plus Chromium browser + system deps)
#######################
# Keep a per-user cache for browsers so rebuilds don't re-download.
export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

# Install @playwright/test globally so `bunx playwright` works without
# needing a repo-local node_modules. We still check per-repo deps in
# web/ui-tests separately so the repo is self-contained.
if ! bunx --bun playwright --version >/dev/null 2>&1; then
    log "installing @playwright/test globally via bun"
    bun add -g @playwright/test || true
fi

# System deps + Chromium for headless runs. Needs sudo; skip quietly
# if we can't get it (e.g. running this script outside the container).
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    log "installing Chromium system deps via playwright"
    sudo -E "$(command -v bunx)" --bun playwright install-deps chromium || true
fi
log "installing Chromium browser into $PLAYWRIGHT_BROWSERS_PATH"
bunx --bun playwright install chromium || true

#######################
# Shell wiring — make sure future shells see node + bun + playwright
# without the interactive login prompt dance.
#######################
BASHRC="$HOME/.bashrc"
marker="# >>> foyer-dev tooling >>>"
if ! grep -qF "$marker" "$BASHRC" 2>/dev/null; then
    log "wiring $BASHRC"
    cat >>"$BASHRC" <<EOF

$marker
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
export BUN_INSTALL="\$HOME/.bun"
export PATH="\$BUN_INSTALL/bin:\$PATH"
export PLAYWRIGHT_BROWSERS_PATH="\$HOME/.cache/ms-playwright"
# <<< foyer-dev tooling <<<
EOF
fi

log "done — node, bun, playwright (chromium) ready for dev"
