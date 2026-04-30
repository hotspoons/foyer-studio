#!/usr/bin/env bash
# Container entrypoint for the production Foyer Studio image.
#
# Responsibilities:
#   1. Light up a JACK server based on $FOYER_JACK_MODE.
#       - embedded — start jackd dummy in the background. Fully
#         self-contained; no host audio.
#       - shm      — assume the host already has jackd running and
#         the container's /dev/shm + /tmp are bind-mounted so the
#         JACK client libs find the shared registry. We just sleep
#         briefly to confirm the registry is visible.
#       - netjack  — connect to a remote JACK server via NetJack2.
#         Uses jackd's `net` driver pointed at $FOYER_NETJACK_HOST
#         (defaults to 127.0.0.1; non-blank disables `dummy`).
#       - none     — skip JACK entirely. Useful when the operator
#         only wants the stub backend (no Ardour).
#
#   2. Make sure the surfaces dir + LV2 path are wired up so Ardour
#      can find the Foyer shim + the bundled plugin pack.
#
#   3. exec the `foyer` sidecar with the right flags. Everything
#      after `--` is forwarded to the binary so docker run's
#      `command:` override still works.
#
# Read by every fresh container start. Idempotent — re-running it on
# a long-lived container should not produce stale jackd sockets.

set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# ── env defaults ─────────────────────────────────────────────────
PORT="${PORT:-3838}"
FOYER_BACKEND="${FOYER_BACKEND:-ardour}"
FOYER_JAIL="${FOYER_JAIL:-/projects}"
FOYER_JACK_MODE="${FOYER_JACK_MODE:-embedded}"
FOYER_SAMPLE_RATE="${FOYER_SAMPLE_RATE:-48000}"
FOYER_PERIOD_FRAMES="${FOYER_PERIOD_FRAMES:-1024}"
FOYER_LISTEN="${FOYER_LISTEN:-0.0.0.0:${PORT}}"
FOYER_NETJACK_HOST="${FOYER_NETJACK_HOST:-}"
FOYER_NETJACK_PORT="${FOYER_NETJACK_PORT:-19000}"
# Realtime-scheduling probe. Cloud Run gen2 strips CAP_SYS_NICE
# and zeroes the rtprio rlimit, so `jackd -R` makes Ardour's
# `JackClient::AcquireSelfRealTime` fail with EPERM on thread
# create — fatal `failed_constructor` at session load. The dummy
# backend doesn't need RT (no hardware deadline to hit) so we
# probe and only pass `-R -P 10` when the kernel will allow it.
#
# `auto`: probe `ulimit -r`. >0 → use RT; 0 → don't.
# `on`: force RT (fails fast on Cloud Run; use only when you know
#       the container is privileged).
# `off`: never use RT.
FOYER_JACK_REALTIME="${FOYER_JACK_REALTIME:-auto}"
JACK_RT_ARGS=""
rtprio_max=$(ulimit -r 2>/dev/null || echo 0)
case "${FOYER_JACK_REALTIME}" in
    on)
        JACK_RT_ARGS="-R -P 10"
        ;;
    off)
        ;;
    auto|*)
        if [ "${rtprio_max}" -gt 0 ] 2>/dev/null; then
            JACK_RT_ARGS="-R -P 10"
        fi
        ;;
esac

# Runtime mode resolution. Two paths:
#
#   gui-dummy      (DEFAULT): GUI Ardour painting onto an in-container
#                  Xvfb, using libardour's "None (Dummy)" backend.
#                  Works everywhere — Cloud Run gen2, plain
#                  `docker run`, no special flags. The shipping
#                  default because (a) most deploys are headless
#                  / non-privileged, (b) the alternative needs
#                  CAP_SYS_NICE which most container hosts strip.
#
#   jack-headless  (opt-in): hardour + jackd + RT scheduling. Real
#                  audio path. Requires the container to have
#                  CAP_SYS_NICE and a non-zero rtprio rlimit — i.e.
#                  `docker run --privileged --ulimit rtprio=95
#                  --ulimit memlock=-1 ...`. Set
#                  `FOYER_RUNTIME_MODE=jack-headless` (and optionally
#                  `FOYER_JACK_MODE=shm` to consume a host-mounted
#                  jackd registry).
#
# `auto` keeps the legacy probe behavior (rtprio>0 → jack-headless,
# else gui-dummy) and is available for users who want their image to
# adapt without env var pinning. Default is now `gui-dummy` so
# fresh `docker run` and Cloud Run deploys just work.
FOYER_RUNTIME_MODE="${FOYER_RUNTIME_MODE:-gui-dummy}"
case "${FOYER_RUNTIME_MODE}" in
    jack-headless|gui-dummy)
        ;;
    auto)
        if [ "${rtprio_max}" -gt 0 ] 2>/dev/null && \
           [ "${FOYER_JACK_MODE}" != "none" ]; then
            FOYER_RUNTIME_MODE=jack-headless
        else
            FOYER_RUNTIME_MODE=gui-dummy
        fi
        ;;
    *)
        log "WARNING: unknown FOYER_RUNTIME_MODE='${FOYER_RUNTIME_MODE}', falling back to gui-dummy"
        FOYER_RUNTIME_MODE=gui-dummy
        ;;
esac
log "runtime mode: ${FOYER_RUNTIME_MODE} (rtprio_max=${rtprio_max})"

# In gui-dummy mode: spin up an Xvfb, seed Ardour's config so the
# first-run wizard + AMS dialogs don't block boot, and skip the
# jackd boot below (libardour's Dummy backend doesn't need it).
XVFB_PID=""
if [ "${FOYER_RUNTIME_MODE}" = "gui-dummy" ]; then
    FOYER_JACK_MODE=none
    if [ -z "${DISPLAY:-}" ]; then
        if [ ! -e /tmp/.X11-unix/X99 ]; then
            log "starting Xvfb on :99 (no \$DISPLAY set)"
            Xvfb :99 -screen 0 1280x720x24 -nolisten tcp \
                >/tmp/xvfb.log 2>&1 &
            XVFB_PID=$!
            for _ in $(seq 1 30); do
                [ -e /tmp/.X11-unix/X99 ] && break
                sleep 0.1
            done
        fi
        export DISPLAY=:99
    fi
    log "DISPLAY=${DISPLAY}"
    # Seed ~/.config/ardour9/{.a9,config} so first-run wizard and
    # AMS dialogs are skipped. We use `--force-ams-dummy` here (not
    # `--ams-dummy`) because in gui-dummy mode WE own the config —
    # any pre-existing config file is either:
    #   (a) a stale leftover from a prior `jack-headless` run on a
    #       reused volume, in which case it pins JACK and ardour-9
    #       tries to acquire RT scheduling and dies with
    #       `failed_constructor`; or
    #   (b) something Ardour itself wrote during a prior session
    #       save/load that doesn't carry a usable `<EngineStates>`
    #       block, so `EngineControl::set_state` falls through to
    #       `set_default_state` which picks the first backend from
    #       `ARDOUR_BACKEND_PATH` — and that's JACK. Same death.
    # The GUI binary IGNORES the `ARDOUR_BACKEND` env var (only
    # `hardour` honors it via our patches/002 — search_paths.cc
    # only knows `ARDOUR_BACKEND_PATH`), so a seeded
    # `<EngineStates>` block is the only knob that actually pins
    # the GUI to Dummy. Force-overwrite is the safe move.
    cfg_dir="${ARDOUR_CONFIG_DIR:-$HOME/.config/ardour9}"
    if [ -x /usr/local/bin/foyer-seed-ardour-config ]; then
        /usr/local/bin/foyer-seed-ardour-config --force-ams-dummy || \
            log "WARNING: foyer-seed-ardour-config exited non-zero — Ardour will likely fall back to JACK and die"
    elif [ -x /workspace/scripts/runtime/seed-ardour-config.sh ]; then
        /workspace/scripts/runtime/seed-ardour-config.sh --force-ams-dummy || \
            log "WARNING: seed-ardour-config.sh exited non-zero — Ardour will likely fall back to JACK and die"
    else
        log "WARNING: no seed-ardour-config script found — Ardour will fall back to JACK and die under non-privileged container runtimes"
    fi
    # Post-seed verification — surface this in `docker logs` so a
    # JACK fallback is unambiguous to debug. Looks for both the
    # file and the `backend="None (Dummy)"` line that EngineControl
    # parses (line 2081 of engine_dialog.cc — backend property is
    # the load-bearing field).
    if [ -f "$cfg_dir/config" ] && grep -q 'backend="None (Dummy)"' "$cfg_dir/config" 2>/dev/null; then
        log "Ardour config seed verified: $cfg_dir/config has Dummy backend pinned"
    else
        log "WARNING: $cfg_dir/config missing or lacks Dummy AMS state — GUI ardour-9 will pick JACK at startup"
        log "WARNING: contents of $cfg_dir (if any):"
        ls -la "$cfg_dir" 2>&1 | sed 's/^/[entrypoint]   /' >&2 || true
    fi
fi

# Ardour build root — the binary lives at $FOYER_ARDOUR_BUILD_ROOT/build/headless/hardour-*
# (hardour) or $FOYER_ARDOUR_BUILD_ROOT/build/gtk2_ardour/ardour-* (gui).
# foyer-config picks based on $DISPLAY automatically.
FOYER_ARDOUR_BUILD_ROOT="${FOYER_ARDOUR_BUILD_ROOT:-/opt/ardour}"

# Ardour's runtime needs ARDOUR_DATA_PATH, ARDOUR_DLL_PATH, etc. The
# upstream waf build emits a script that sets all of them — sourcing
# it is the easiest way to keep up with new vars Ardour adds across
# releases. Skip in stub-only mode (no Ardour install present).
if [ -f "${FOYER_ARDOUR_BUILD_ROOT}/build/gtk2_ardour/ardev_common_waf.sh" ]; then
    export TOP="${FOYER_ARDOUR_BUILD_ROOT}"
    # ardev_common.sh.in:62 reads `[ x$ASAN_COREDUMP != x ]` with an
    # unquoted expansion, and there are similar patterns later in the
    # file for diagnostic-only vars (LIBJACK, MALLOC_CONF, …). Under
    # the entrypoint's `set -u` they all abort boot. Drop -u for the
    # source, restore it after — the script's job is just to populate
    # path env vars, not to enforce strictness on us.
    set +u
    # shellcheck disable=SC1091
    source "${FOYER_ARDOUR_BUILD_ROOT}/build/gtk2_ardour/ardev_common_waf.sh"
    set -u
fi

# Make sure the foyer surface .so is reachable. The Dockerfile
# installs it under /opt/foyer/surfaces; ARDOUR_SURFACES_PATH is
# additive, so layering `/opt/foyer/surfaces` keeps Ardour's stock
# surfaces discoverable.
export ARDOUR_SURFACES_PATH="/opt/foyer/surfaces:${ARDOUR_SURFACES_PATH:-}"

# Suppress Ardour's "this screen is not tall enough to display
# the editor mixer" modal — fatal in container deploys where
# nobody can click OK. The env var is Ardour's own escape hatch
# for exactly this case (gtk2_ardour/editor_mixer.cc:91).
export ARDOUR_LOVES_STUPID_TINY_SCREENS=1

# Initial seed: if the jail is empty, copy any sample sessions in so
# new visitors land on something useful instead of a blank picker.
mkdir -p "${FOYER_JAIL}"
if [ -d /opt/foyer/sample-sessions ] && [ -z "$(ls -A "${FOYER_JAIL}" 2>/dev/null || true)" ]; then
    log "seeding ${FOYER_JAIL} from /opt/foyer/sample-sessions"
    cp -a /opt/foyer/sample-sessions/. "${FOYER_JAIL}/" || true
fi

# ── JACK boot ────────────────────────────────────────────────────
JACKD_PID=""
case "${FOYER_JACK_MODE}" in
    embedded)
        # `jackd -d dummy` — the all-software backend. Matches what
        # `scripts/dev/jack.sh start` does in the dev loop. Period
        # frames + sample rate are the two knobs that change latency
        # vs. CPU spend; defaults are fine for a free-tier instance.
        if pgrep -x jackd >/dev/null 2>&1; then
            log "jackd already running — reusing"
        else
            log "starting embedded jackd dummy (sr=${FOYER_SAMPLE_RATE}, frames=${FOYER_PERIOD_FRAMES}, rt=${JACK_RT_ARGS:-off})"
            # shellcheck disable=SC2086 # JACK_RT_ARGS is "" or "-R -P 10" — must word-split
            jackd ${JACK_RT_ARGS} -d dummy \
                  -r "${FOYER_SAMPLE_RATE}" -p "${FOYER_PERIOD_FRAMES}" \
                  >/tmp/jackd.log 2>&1 &
            JACKD_PID=$!
            # Spin briefly until JACK is happy. A failure here is
            # non-fatal — Ardour will surface a "no jack" error in
            # the UI and the operator can switch to stub via the
            # backend picker.
            for _ in $(seq 1 20); do
                if pgrep -x jackd >/dev/null 2>&1; then break; fi
                sleep 0.1
            done
        fi
        ;;
    shm)
        # Host already runs jackd. We need its registry visible —
        # /dev/shm/jack-* lives on /dev/shm; the JACK client libs
        # also poke at /tmp/jack-* sockets on some distros.
        # Container must be launched with:
        #   --ipc=host \
        #   -v /dev/shm:/dev/shm \
        #   -v /tmp/.X11-unix:/tmp/.X11-unix:ro
        # …or equivalent.
        if [ ! -d /dev/shm ]; then
            log "ERROR: FOYER_JACK_MODE=shm but /dev/shm missing — bind-mount it from the host"
            exit 1
        fi
        log "FOYER_JACK_MODE=shm — assuming host jackd via /dev/shm"
        ;;
    netjack)
        # Connect to a remote NetJack2 master. The client side
        # spawns its own jackd with the `net` driver pointed at the
        # remote. Useful for hooking the container into a host's
        # already-running jackd over the LAN without IPC tricks.
        if [ -z "${FOYER_NETJACK_HOST}" ]; then
            log "ERROR: FOYER_JACK_MODE=netjack requires FOYER_NETJACK_HOST=<host[:port]>"
            exit 1
        fi
        log "starting netjack client → ${FOYER_NETJACK_HOST}:${FOYER_NETJACK_PORT} (rt=${JACK_RT_ARGS:-off})"
        # shellcheck disable=SC2086 # JACK_RT_ARGS is "" or "-R -P 10" — must word-split
        jackd ${JACK_RT_ARGS} -d net \
              -h "${FOYER_NETJACK_HOST}" -p "${FOYER_NETJACK_PORT}" \
              >/tmp/jackd.log 2>&1 &
        JACKD_PID=$!
        for _ in $(seq 1 30); do
            pgrep -x jackd >/dev/null 2>&1 && break
            sleep 0.1
        done
        ;;
    none)
        log "FOYER_JACK_MODE=none — skipping jack boot (stub backend recommended)"
        ;;
    *)
        log "ERROR: unknown FOYER_JACK_MODE=${FOYER_JACK_MODE}"
        exit 1
        ;;
esac

# Make sure the sidecar inherits a clean shutdown of jackd when the
# container is asked to stop. tini propagates SIGTERM to us; we then
# need to forward it to jackd before exec'ing foyer (foyer itself
# replaces this shell, so trap firing after exec is impossible —
# tini handles termination of foyer directly).
shutdown() {
    if [ -n "${JACKD_PID}" ] && kill -0 "${JACKD_PID}" 2>/dev/null; then
        log "shutting down jackd (pid ${JACKD_PID})"
        kill -TERM "${JACKD_PID}" 2>/dev/null || true
    fi
}
trap shutdown EXIT INT TERM

# ── foyer sidecar ────────────────────────────────────────────────
declare -a foyer_args
foyer_args=(
    serve
    --backend "${FOYER_BACKEND}"
    --listen "${FOYER_LISTEN}"
    --jail "${FOYER_JAIL}"
    --sample-rate "${FOYER_SAMPLE_RATE}"
)

# Optional TLS pair — Cloud Run terminates HTTPS at the edge so the
# common case is plain HTTP. A bare-metal deploy can mount a cert +
# key and point us at them.
if [ -n "${FOYER_TLS_CERT:-}" ] && [ -n "${FOYER_TLS_KEY:-}" ]; then
    foyer_args+=(--tls-cert "${FOYER_TLS_CERT}" --tls-key "${FOYER_TLS_KEY}")
fi

log "exec foyer ${foyer_args[*]} $*"
# Forward any extra positional args (`docker run … foyer-image --foo`
# lands here as `$@`).
exec foyer "${foyer_args[@]}" "$@"
