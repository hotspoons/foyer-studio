#!/usr/bin/env bash
# Thin wrapper so `just ui-probe <args>` works without cd-ing.
# See web/ui-tests/probe.js for the real entry point.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR/tests-ui"

if [ ! -d "node_modules" ]; then
    bun install
fi

export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

exec bun probe.js "$@"
