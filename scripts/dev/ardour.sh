#!/usr/bin/env bash
set -euo pipefail

# Resolve Ardour source tree. Priority:
#   1. $FOYER_ARDOUR_DIR (explicit override)
#   2. <repo>/ext/ardour (in-repo convention — gitignored)
#   3. /workspaces/ardour (legacy sibling-workspace layout)
# Resolve via BASH_SOURCE so this works whether the script is invoked
# directly (./scripts/dev/ardour.sh) or sourced (`source scripts/dev/ardour.sh`).
# $0 is the shell when sourced, which gave us REPO_ROOT="/" silently.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -n "${FOYER_ARDOUR_DIR:-}" ]; then
    ARDOUR_DIR="$FOYER_ARDOUR_DIR"
elif [ -d "$REPO_ROOT/ext/ardour" ]; then
    ARDOUR_DIR="$REPO_ROOT/ext/ardour"
else
    ARDOUR_DIR="/workspaces/ardour"
fi

ARDOUR_UPSTREAM="${FOYER_ARDOUR_UPSTREAM:-https://github.com/Ardour/ardour.git}"
# Source project + per-dev .env files for ARDOUR_TAG and friends.
# Precedence: shell env > .env.local (gitignored) > .env (committed).
# `set -a` exports every assignment, so `ARDOUR_TAG=...` lines in the
# files become real env vars; `set +a` turns it off after.
load_env_file() {
    [ -f "$1" ] || return 0
    set -a
    # shellcheck disable=SC1090
    . "$1"
    set +a
}
__foyer_env_already_set="${ARDOUR_TAG:+1}"
if [ -z "$__foyer_env_already_set" ]; then
    load_env_file "$REPO_ROOT/.env"
    load_env_file "$REPO_ROOT/.env.local"
fi
unset __foyer_env_already_set

# Ardour git ref the shim is built against. Default lives in `.env`.
# Final fallback (when no .env exists) is `9.5`. ABI compatibility
# with the user's installed Ardour matters more than master parity.
ARDOUR_TAG="${ARDOUR_TAG:-9.5}"

# When non-empty AND equal to ARDOUR_TAG, `ensure` apt-installs Ardour
# from Debian sid instead of running the 25-min `waf build`. Source
# tree is still cloned + `waf configure`-d for shim headers. See `.env`
# for the rationale and the production Dockerfile for the same trick.
DEBIAN_SID_ARDOUR_VER="${DEBIAN_SID_ARDOUR_VER:-}"

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
Current DEBIAN_SID_ARDOUR_VER: ${DEBIAN_SID_ARDOUR_VER:-(unset — full source build)}
Override with: FOYER_ARDOUR_DIR=/path/to/ardour, ARDOUR_TAG=9.5
EOF
}

# Whether to short-circuit the source build by apt-installing Ardour
# from Debian sid. True only when:
#   * DEBIAN_SID_ARDOUR_VER is set and equals ARDOUR_TAG (.env opts in)
#   * the host has apt-get + dpkg (Debian-derived)
#   * we can become root (already root, or sudo -n succeeds)
# Returns 1 silently otherwise — caller falls through to waf build.
apt_path_applicable() {
    local ver="${DEBIAN_SID_ARDOUR_VER:-}"
    [ -n "$ver" ] || return 1
    [ "$ARDOUR_TAG" = "$ver" ] || return 1
    command -v apt-get >/dev/null 2>&1 || return 1
    [ -f /etc/debian_version ] || return 1
    if [ "$(id -u)" -ne 0 ] && ! sudo -n true 2>/dev/null; then
        return 1
    fi
    return 0
}

sudo_run() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

# Apt-install Ardour from Debian sid. Mirrors the runtime Dockerfile's
# trick (search for "Ardour 9.2 from sid" in the repo Dockerfile):
# add sid as a low-priority source so apt only pulls from it on the
# explicit `-t sid` request. Idempotent — re-runs are ~1 s no-ops.
do_apt_install_from_sid() {
    local sid_list=/etc/apt/sources.list.d/sid.list
    local sid_pref=/etc/apt/preferences.d/sid-pin
    if [ ! -f "$sid_list" ] || ! grep -q '^deb .* sid main' "$sid_list" 2>/dev/null; then
        echo "ardour: enabling Debian sid as low-priority apt source"
        echo "deb http://deb.debian.org/debian sid main" \
            | sudo_run tee "$sid_list" >/dev/null
    fi
    if [ ! -f "$sid_pref" ]; then
        printf '%s\n' \
            'Package: *' \
            'Pin: release a=unstable' \
            'Pin-Priority: 100' \
            | sudo_run tee "$sid_pref" >/dev/null
    fi
    # Already installed at the right major.minor? Skip the install.
    # `dpkg-query` prints e.g. `install ok installed 1:9.2.0+ds-1`; we
    # strip the Debian epoch (`1:`) and revision/+ds/+~ suffixes, then
    # prefix-match against ARDOUR_TAG so "9.2" matches "9.2.0".
    local installed
    installed="$(dpkg-query -W -f='${Status} ${Version}\n' ardour 2>/dev/null \
                 | awk '/^install ok installed/ { sub(/^[0-9]+:/, "", $4); print $4 }')"
    if [ -n "$installed" ]; then
        local trimmed="${installed%%+*}"
        trimmed="${trimmed%%~*}"
        trimmed="${trimmed%%-*}"
        case "$trimmed" in
            "$ARDOUR_TAG"|"$ARDOUR_TAG".*)
                echo "ardour: apt package already at $installed (matches $ARDOUR_TAG) — skipping install"
                return 0
                ;;
        esac
    fi
    echo "ardour: installing ardour $ARDOUR_TAG from sid (one-time, ~5 min)"
    # Always refresh apt's lists — sid moves daily and "the sid line
    # is already there" doesn't prove the index carries the version
    # we want.
    sudo_run apt-get update
    sudo_run apt-get install -y --no-install-recommends -t sid ardour
}

# Lightweight runtime probe of the apt-installed Ardour. Replaces
# `do_check` on the apt path — there's no `build/gtk2_ardour/ardour-*`
# to point at; the binary lives at /usr/bin/ardour (a wrapper that
# sets LD_LIBRARY_PATH then exec's /usr/lib/ardour9/ardour-X.Y.Z).
apt_check() {
    local bin
    bin="$(command -v ardour 2>/dev/null || true)"
    if [ -z "$bin" ]; then
        echo "ardour: no ardour on \$PATH (apt install failed?)"
        return 1
    fi
    if ! "$bin" --version >/tmp/foyer-ardour-check.log 2>&1; then
        echo "ardour: --version probe failed"
        sed -n '1,20p' /tmp/foyer-ardour-check.log
        return 1
    fi
    echo "ardour: ok ($bin)"
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
    # GUI Ardour only — Foyer depends on X11 for plugin / instrument
    # GUI projection, so the `build/headless/hardour-*` binary is
    # intentionally NOT considered (matches the Rust-side
    # `scan_ardour_build_tree`). A container without DISPLAY runs
    # this binary against an in-container Xvfb; the entrypoint +
    # `seed-ardour-config.sh` arrange that.
    ls -1 "$ARDOUR_DIR"/build/gtk2_ardour/ardour-* 2>/dev/null | sort -V | tail -n1 || true
}

ensure_tags() {
    if [ -z "$(git -C "$ARDOUR_DIR" tag -l | head -n1)" ]; then
        echo "ardour: no git tags found, fetching from origin..."
        git -C "$ARDOUR_DIR" fetch --tags origin
        return
    fi
    # We already have SOME tags but the target may be a fresh upstream
    # release that landed after our clone. Fetch when the specific
    # `$ARDOUR_TAG` isn't resolvable locally — covers the version-bump
    # case (clone is on 9.2, .env now requests 9.5, tag was published
    # after clone). Skip when `$ARDOUR_TAG` is a SHA / branch name that
    # `rev-parse` can already resolve, to avoid pointless network hits.
    if ! git -C "$ARDOUR_DIR" rev-parse --verify --quiet "$ARDOUR_TAG^{commit}" >/dev/null 2>&1; then
        echo "ardour: '$ARDOUR_TAG' not resolvable locally — fetching tags from origin..."
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
    # Ardour's vendored ydk/ytk/ydkmm/ytkmm uses GLib types deprecated
    # since 2.62 (GTimeVal etc.) — every gtk2_ardour compile unit
    # emits dozens of `-Wdeprecated-declarations` warnings. Ardour
    # upstream lives with this; we'd just rather not have it flood
    # CI logs. Suppress the warning class globally during the Ardour
    # build. Doesn't affect correctness — the symbols still link.
    local cflags="${CFLAGS:-} -Wno-deprecated-declarations"
    local cxxflags="${CXXFLAGS:-} -Wno-deprecated-declarations"

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
        CFLAGS="$cflags" \
        CXXFLAGS="$cxxflags" \
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
        echo "ardour: no runnable ardour binary under $ARDOUR_DIR/build/gtk2_ardour/"
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
    # `--version` doesn't open the GUI; GTK init runs after argument
    # parsing in gtk2_ardour, so this works even on a tty with no
    # DISPLAY. Log file name kept generic so subsequent renames don't
    # break tail-on-failure handlers.
    if ! "$bin" --version >/tmp/foyer-ardour-check.log 2>&1; then
        echo "ardour: runtime probe failed"
        sed -n '1,20p' /tmp/foyer-ardour-check.log
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
        #   2. configure + build if the GUI binary isn't there
        #      (or apt-install from sid when DEBIAN_SID_ARDOUR_VER
        #      matches ARDOUR_TAG — see `apt_path_applicable` above)
        #   3. write the resulting executable path into
        #      `$XDG_DATA_HOME/foyer/config.yaml` via
        #      `foyer configure --backend ardour --force`
        # Idempotent — once everything is in place this short-circuits
        # in < 1 s. The cold-cache slow path is either ~25 min (waf
        # build) or ~5 min (apt install + waf configure for headers).
        if apt_path_applicable; then
            # Apt path: pre-built Ardour from sid + just enough source
            # for the shim's CMake to find generated headers under
            # build/libs/. Skips the 25 min `waf build` step entirely.
            do_apt_install_from_sid
            if [ ! -d "$ARDOUR_DIR" ]; then
                echo "ardour: source tree missing at $ARDOUR_DIR — cloning (for shim headers)"
                do_clone
            fi
            ensure_tags
            current_ref="$(git -C "$ARDOUR_DIR" describe --tags --always 2>/dev/null || echo unknown)"
            if [ "$current_ref" != "$ARDOUR_TAG" ]; then
                if [ -n "$(git -C "$ARDOUR_DIR" status --porcelain)" ]; then
                    echo "ardour: ⚠ uncommitted changes — staying on $current_ref (target: $ARDOUR_TAG)"
                else
                    echo "ardour: switching $current_ref → $ARDOUR_TAG"
                    git -C "$ARDOUR_DIR" -c advice.detachedHead=false checkout "$ARDOUR_TAG"
                    # Wipe build/ on ref switch so `waf configure` re-
                    # runs against the new tree (mirrors the source-build
                    # branch — same staleness concern applies to the
                    # generated headers, just at smaller scale).
                    rm -rf "$ARDOUR_DIR/build"
                fi
            fi
            # Run waf configure if the build dir or its key generated
            # header is missing. Mirrors the production Dockerfile —
            # the shim's CMakeLists requires `<src>/build/` to exist
            # for `libardour-config.h` and friends. ~30 s vs the 25 min
            # `waf build` we're skipping.
            if [ ! -f "$ARDOUR_DIR/build/libs/ardour/libardour-config.h" ]; then
                echo "ardour: waf configure (one-time, ~30s — for shim headers, no full build)"
                do_configure
            fi
            apt_check
            # Write the apt path into config.yaml. Same fast-path skip
            # as the source-build branch — `cargo run --quiet` still
            # costs a couple seconds per `just prep` tick.
            bin="$(command -v ardour 2>/dev/null || true)"
            config_yaml="${XDG_DATA_HOME:-$HOME/.local/share}/foyer/config.yaml"
            if [ -n "$bin" ] && [ -f "$config_yaml" ] \
                 && grep -qF "  executable: $bin" "$config_yaml"; then
                echo "  id=ardour exec=$bin (config up-to-date, skipped configure)"
            else
                (
                    cd "$REPO_ROOT"
                    cargo run --quiet --bin foyer -- configure --backend ardour --force
                )
            fi
        else
            if [ ! -d "$ARDOUR_DIR" ]; then
                echo "ardour: source tree missing at $ARDOUR_DIR — cloning (large, one-time)"
                do_clone
            fi
            ensure_tags
            # Switch the working tree to $ARDOUR_TAG when it doesn't
            # match. Skip if there are local modifications — user may be
            # mid-hack and we don't want to clobber. Triggers a rebuild
            # below since the .so files will be stale for the new ref.
            current_ref="$(git -C "$ARDOUR_DIR" describe --tags --always 2>/dev/null || echo unknown)"
            if [ "$current_ref" != "$ARDOUR_TAG" ]; then
                if [ -n "$(git -C "$ARDOUR_DIR" status --porcelain)" ]; then
                    echo "ardour: ⚠ uncommitted changes — staying on $current_ref (target: $ARDOUR_TAG)"
                else
                    echo "ardour: switching $current_ref → $ARDOUR_TAG"
                    git -C "$ARDOUR_DIR" -c advice.detachedHead=false checkout "$ARDOUR_TAG"
                    # `waf` incremental builds can leave stale objects when
                    # source moves a lot (e.g. removed classes like
                    # PBD::Mutex/RWLock between master ↔ tag). The headless
                    # binary was the symptom: it kept its old name
                    # (`hardour-9.2.591`) and stale undefined-symbol refs
                    # because not every .o was rebuilt. Clean wipe of
                    # generated outputs forces a fresh build, ~30 min, but
                    # only once per ref switch.
                    echo "ardour: cleaning stale build outputs for ref switch"
                    ( cd "$ARDOUR_DIR" && python3 waf clean >/dev/null 2>&1 || true )
                    rm -f "$ARDOUR_DIR/build/gtk2_ardour/ardev_common_waf.sh"
                    rm -rf "$ARDOUR_DIR"/build/headless "$ARDOUR_DIR"/build/gtk2_ardour
                fi
            fi
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
