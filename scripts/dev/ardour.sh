#!/usr/bin/env bash
set -euo pipefail

# Resolve Ardour source tree. Priority:
#   1. $FOYER_ARDOUR_DIR (explicit override)
#   2. <repo>/ext/ardour (in-repo convention — gitignored)
#   3. /workspaces/ardour (legacy sibling-workspace layout)
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -n "${FOYER_ARDOUR_DIR:-}" ]; then
    ARDOUR_DIR="$FOYER_ARDOUR_DIR"
elif [ -d "$REPO_ROOT/ext/ardour" ]; then
    ARDOUR_DIR="$REPO_ROOT/ext/ardour"
else
    ARDOUR_DIR="/workspaces/ardour"
fi

ARDOUR_UPSTREAM="${FOYER_ARDOUR_UPSTREAM:-https://github.com/Ardour/ardour.git}"
# Pin the Ardour ref the shim is built against. Accepts a tag
# (`9.2`), branch name (`master`), or commit SHA. Default is a
# specific master commit because the shim source uses APIs added
# after tag 9.2 — `PBD::RWLock` and the 2-arg `IO::connect`. Until
# the shim grows `#if ARDOUR_VERSION_AT_LEAST(...)` compat shims,
# we have to track post-9.2 master to compile cleanly. Bump this
# to whatever SHA you've been hacking against locally.
ARDOUR_TAG="${ARDOUR_TAG:-a1d709fd14}"

usage() {
    cat <<EOF
ardour subcommands:
  help        Print this help
  clone       Clone Ardour into $REPO_ROOT/ext/ardour (if not present)
  configure   Run waf configure --optimize
  build       Run waf build
  ensure      Soft-check build, auto-build only when needed
  check       Hard-check existing build
  clean       Run waf clean
  test        Run waf test

Current ARDOUR_DIR: $ARDOUR_DIR
Current ARDOUR_TAG: $ARDOUR_TAG
Override with: FOYER_ARDOUR_DIR=/path/to/ardour, ARDOUR_TAG=9.2
EOF
}

do_clone() {
    if [ -d "$ARDOUR_DIR/.git" ]; then
        echo "ardour: already present at $ARDOUR_DIR"
        return 0
    fi
    mkdir -p "$REPO_ROOT/ext"
    local target="$REPO_ROOT/ext/ardour"
    if [ -d "$target" ] && [ ! -d "$target/.git" ]; then
        echo "ardour: $target exists but isn't a git checkout — refusing to clone into it"
        exit 1
    fi
    echo "ardour: cloning $ARDOUR_UPSTREAM @ $ARDOUR_TAG → $target (~250 MB shallow)"
    # `git clone --branch` doesn't accept commit SHAs. Try the fast
    # branch/tag path first; on failure fall back to init + fetch +
    # checkout, which works for any ref the server accepts (GitHub
    # has supported uploadpack.allowReachableSHA1InWant since 2020).
    if git -c advice.detachedHead=false clone \
            --depth 1 \
            --branch "$ARDOUR_TAG" \
            "$ARDOUR_UPSTREAM" "$target" 2>/dev/null; then
        :
    else
        echo "ardour: '$ARDOUR_TAG' isn't a tag/branch — fetching as commit SHA"
        rm -rf "$target"
        mkdir -p "$target"
        git -C "$target" init -q
        git -C "$target" remote add origin "$ARDOUR_UPSTREAM"
        git -C "$target" fetch --depth 1 origin "$ARDOUR_TAG"
        git -C "$target" -c advice.detachedHead=false checkout FETCH_HEAD
    fi
    echo "ardour: done. Next: \`just ardour configure && just ardour build\`"
    ARDOUR_DIR="$target"
}

latest_bin() {
    ls -1 "$ARDOUR_DIR"/build/headless/hardour-* 2>/dev/null | sort -V | tail -n1 || true
}

ensure_tags() {
    if [ -z "$(git -C "$ARDOUR_DIR" tag -l | head -n1)" ]; then
        echo "ardour: no git tags found, fetching from origin..."
        git -C "$ARDOUR_DIR" fetch --tags origin
    fi
}

require_repo() {
    if [ ! -d "$ARDOUR_DIR" ]; then
        echo "ardour: missing $ARDOUR_DIR"
        exit 1
    fi
}

patch_for_darwin() {
    # Ardour's vendored ydk/ytk (forks of GTK+'s gdk/gtk) use
    # `__attribute((alias("IA__foo")))` symbol aliases for ELF symbol
    # visibility games. Mach-O on darwin doesn't support the `alias`
    # attribute → clang errors with "aliases are not supported on
    # darwin" against `gdkaliasdef.c` and `gtkaliasdef.c`. Both files
    # are wrapped in `#ifndef DISABLE_VISIBILITY`, so defining that
    # macro short-circuits them entirely.
    #
    # Upstream Ardour builds on macOS use their bundled GTK stack
    # (which side-steps these files); compiling the in-tree ydk/ytk on
    # darwin requires this patch. Sentinel-marked grep makes it
    # idempotent so a cached `ext/ardour` only patches once.
    local sentinel="# foyer-studio: DISABLE_VISIBILITY on darwin"
    for f in "$ARDOUR_DIR/libs/tk/ydk/wscript" "$ARDOUR_DIR/libs/tk/ytk/wscript"; do
        [ -f "$f" ] || continue
        if grep -qF "$sentinel" "$f"; then
            continue
        fi
        # Inject `DISABLE_VISIBILITY` into the darwin defines list. The
        # darwin block in both wscripts is "if sys.platform == 'darwin':"
        # followed by `obj.source = ... + ..._quartz_sources`. Add a
        # `obj.defines += ['DISABLE_VISIBILITY']` line right after the
        # source assignment.
        python3 - "$f" "$sentinel" <<'PY'
import re, sys
path, sentinel = sys.argv[1], sys.argv[2]
src = open(path).read()
# Capture the indent of the `obj.source` line in group 2 so we know
# how much leading whitespace to use for the inserted lines (the
# wscripts use 8-space indent for these blocks).
pattern = re.compile(
    r"(if sys\.platform == 'darwin':\s*\n([ \t]+)obj\.source\s*=\s*[^\n]*_quartz_sources\b[^\n]*)\n",
    re.MULTILINE,
)
m = pattern.search(src)
if not m:
    sys.stderr.write(f"ardour: failed to locate darwin source line in {path}\n")
    sys.exit(1)
indent = m.group(2)
patched = (
    src[:m.end(1)]
    + "\n"
    + indent + sentinel + "\n"
    + indent + "obj.defines += ['DISABLE_VISIBILITY']\n"
    + src[m.end(1):]
)
open(path, "w").write(patched)
print(f"ardour: patched DISABLE_VISIBILITY into {path}")
PY
    done
}

do_configure() {
    local extra_args=()
    local cppflags="${CPPFLAGS:-}"
    local ldflags="${LDFLAGS:-}"
    local pkg_path="${PKG_CONFIG_PATH:-}"

    # macOS: Ardour's wscript probes boost via `check_cxx` against
    # `<boost/version.hpp>` and pulls every other dep through pkg-config.
    # Homebrew installs to /opt/homebrew (Apple Silicon) or /usr/local
    # (Intel); `brew --prefix` resolves the right one. Without these
    # hints waf can't find boost (header search) or the keg-only
    # `libarchive` (pkg-config), which fails configure with
    # "Checking for boost library >= 1.68 : no" or "libarchive: not
    # found".
    if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
        local brew_prefix
        brew_prefix="$(brew --prefix)"
        cppflags="-I$brew_prefix/include ${cppflags}"
        ldflags="-L$brew_prefix/lib ${ldflags}"
        # Keg-only formulas don't symlink into the global prefix, so
        # they need their per-formula include + lib dirs surfaced
        # explicitly. `libarchive` is required: its header is included
        # by `libs/pbd/pbd/file_archive.h`, which gets dragged into
        # libardour compilation units that don't have libpbd's
        # per-cell `ARCHIVE` uselib in scope.
        if brew --prefix libarchive >/dev/null 2>&1; then
            local libarchive_prefix
            libarchive_prefix="$(brew --prefix libarchive)"
            cppflags="-I$libarchive_prefix/include ${cppflags}"
            ldflags="-L$libarchive_prefix/lib ${ldflags}"
            pkg_path="$libarchive_prefix/lib/pkgconfig:$pkg_path"
        fi
        # `raptor` (raptor2) ships headers under `include/raptor2/` on
        # Homebrew, so `<raptor.h>` doesn't resolve via the default
        # `-I$brew_prefix/include`. lrdf.h `#include`s it directly,
        # and that include trickles into libardour units (e.g.
        # `audio_library.cc`) that aren't tagged with the LRDF uselib,
        # so the per-cell pkg-config flags don't reach them. Surface
        # raptor2's include dir globally.
        if brew --prefix raptor >/dev/null 2>&1; then
            local raptor_prefix
            raptor_prefix="$(brew --prefix raptor)"
            cppflags="-I$raptor_prefix/include/raptor2 -I$raptor_prefix/include ${cppflags}"
            ldflags="-L$raptor_prefix/lib ${ldflags}"
        fi
        if brew --prefix boost >/dev/null 2>&1; then
            extra_args+=("--boost-include=$(brew --prefix boost)/include")
        fi
        patch_for_darwin
    fi

    (
        cd "$ARDOUR_DIR"
        CPPFLAGS="$cppflags" \
        LDFLAGS="$ldflags" \
        PKG_CONFIG_PATH="$pkg_path" \
        python3 waf configure --optimize "${extra_args[@]}"
    )
}

do_build() {
    (cd "$ARDOUR_DIR" && python3 waf build)
}

do_check() {
    local bin
    bin="$(latest_bin)"
    if [ -z "$bin" ] || [ ! -x "$bin" ]; then
        echo "ardour: no runnable hardour binary under $ARDOUR_DIR/build/headless/"
        exit 1
    fi
    if [ ! -f "$ARDOUR_DIR/build/gtk2_ardour/ardev_common_waf.sh" ]; then
        echo "ardour: missing ardev_common_waf.sh (build incomplete)"
        exit 1
    fi
    export TOP="$ARDOUR_DIR"
    export ASAN_COREDUMP="${ASAN_COREDUMP:-0}"
    # shellcheck disable=SC1090
    source "$ARDOUR_DIR/build/gtk2_ardour/ardev_common_waf.sh"
    if ! "$bin" --version >/tmp/foyer-hardour-check.log 2>&1; then
        echo "ardour: runtime probe failed"
        sed -n '1,20p' /tmp/foyer-hardour-check.log
        exit 1
    fi
    echo "ardour: ok ($bin)"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
    help)
        usage
        ;;
    clone)
        do_clone
        ;;
    configure)
        require_repo
        ensure_tags
        do_configure
        ;;
    build)
        require_repo
        do_build
        ;;
    check)
        require_repo
        do_check
        ;;
    ensure)
        # Called by `just prep` before every `just run[-tls]`. Full
        # bootstrap:
        #   1. clone into ext/ardour if source tree missing (~1 GB)
        #   2. configure + build if the headless binary isn't there
        #   3. write the resulting executable path into
        #      `$XDG_DATA_HOME/foyer/config.yaml` via
        #      `foyer configure --backend ardour --force`
        # Idempotent — once everything is in place this short-circuits
        # in < 1 s. The one-time slow path clones + builds Ardour, so
        # fresh-clone devs get a real DAW on `just run` without having
        # to remember separate setup steps.
        if [ ! -d "$ARDOUR_DIR" ]; then
            echo "ardour: source tree missing at $ARDOUR_DIR — cloning (large, one-time)"
            do_clone
        fi
        ensure_tags
        need_build=0
        bin="$(latest_bin)"
        if [ -z "$bin" ] || [ ! -x "$bin" ]; then
            need_build=1
        fi
        if [ ! -f "$ARDOUR_DIR/build/gtk2_ardour/ardev_common_waf.sh" ]; then
            need_build=1
        fi
        if [ "$need_build" -eq 1 ]; then
            echo "ardour: bootstrapping build (slow path — ~15 min)"
            do_configure
            do_build
        fi
        if ! do_check; then
            echo "ardour: retrying incremental build after failed probe..."
            do_build
            do_check
        fi
        # Write the resolved executable path into config.yaml so the
        # sidecar (and the UI's backend launcher) can spawn it. Uses
        # `foyer configure --backend ardour --force` with
        # FOYER_ARDOUR_BUILD_ROOT pinned to the resolved ARDOUR_DIR
        # so detection finds the binary deterministically.
        #
        # Fast path: if config.yaml already contains the resolved
        # executable line, skip the `cargo run` entirely. Even with
        # `--quiet` and a warm target dir, cargo pays a couple seconds
        # for workspace lock + dep graph rebuild. `just prep` runs on
        # every `just run`, so that overhead lands on every dev tick.
        bin="$(latest_bin)"
        config_yaml="${XDG_DATA_HOME:-$HOME/.local/share}/foyer/config.yaml"
        if [ -n "$bin" ] && [ -f "$config_yaml" ] \
             && grep -qF "  executable: $bin" "$config_yaml"; then
            echo "  id=ardour exec=$bin (config up-to-date, skipped configure)"
        else
            (
                cd "$REPO_ROOT"
                FOYER_ARDOUR_BUILD_ROOT="$ARDOUR_DIR" \
                    cargo run --quiet --bin foyer -- configure --backend ardour --force
            )
        fi
        ;;
    clean)
        require_repo
        (cd "$ARDOUR_DIR" && python3 waf clean)
        ;;
    test)
        require_repo
        (cd "$ARDOUR_DIR" && python3 waf test)
        ;;
    *)
        echo "Unknown ardour subcommand: $cmd"
        usage
        exit 1
        ;;
esac
