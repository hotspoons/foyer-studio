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

exec bunx playwright test "$@"
