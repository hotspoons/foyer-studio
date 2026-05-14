#!/usr/bin/env bash
# Wrap `bunx playwright test` so callers don't have to cd into ui-tests
# or worry about bun/node availability. Forwards all args to Playwright.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR/tests-ui"

# Make sure node_modules are populated (idempotent; bun detects when
# the lockfile says we're up-to-date).
if [ ! -d "node_modules" ]; then
    bun install
fi

# Cache browsers per-user so repeated rebuilds don't re-download.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

# Bootstrap the Chromium binary the same way we bootstrap node_modules:
# if the cache has no `chromium_headless_shell-*` dir, fetch it once.
# The devcontainer Dockerfile deliberately doesn't run `playwright
# install` at image-build time — the binary is ~110 MB and most
# contributors never touch the UI tests, so paying for it lazily on
# the first `just test-ui` keeps fresh-container setup fast while
# still being self-healing here. The devcontainer Dockerfile already
# provides the system libs Playwright needs (libnss3, libdrm2, …);
# we deliberately skip `--with-deps` (which needs root + apt).
if ! compgen -G "$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-*" >/dev/null; then
    echo "ui-test: chromium not in $PLAYWRIGHT_BROWSERS_PATH — fetching (one-time)"
    bunx playwright install chromium
fi

exec bunx playwright test "$@"
