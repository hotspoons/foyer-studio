#!/usr/bin/env bash
# Local-dev hygiene: wipe the extracted web assets under
# $XDG_DATA_HOME/foyer/web before each run so yesterday's build can't
# silently serve half-stale files under today's binary.
#
# The install dir is the canonical "user-facing" path (see
# web/HACKING.md). Devs on the repo serve via `--web-root web`
# instead, so this nuke never touches the working copy. Called from
# the Justfile `prep` target and logged so it's obvious when it runs.
set -euo pipefail

DST="${XDG_DATA_HOME:-$HOME/.local/share}/foyer/web"
if [ -d "$DST" ]; then
    echo "[dev] nuking extracted web assets at $DST (will re-extract on next foyer boot without --web-root)"
    rm -rf "$DST"
else
    echo "[dev] no extracted web assets at $DST (nothing to nuke)"
fi
