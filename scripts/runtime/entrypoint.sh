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

# X server bring-up — same shape across both run modes so the user
# can `docker run -p 14500:14500` and peek at whatever's on the X
# session via xpra's HTML5 client (full desktop view, useful for
# diagnosing stuck plugin GUIs that the foyer-window iframe filter
# might be hiding). Two flavors:
#
#   * xpra present  → `xpra start :99 --xvfb=...` lets xpra OWN the
#     Xvfb. Same socket the foyer-server's `/ws/plugin-gui` proxy
#     connects to, so plugin GUI projection lights up automatically
#     when a user clicks the toggle in the schema panel. Mirrors
#     the dev-mode flags from the `just run` recipe.
#   * xpra missing  → bare Xvfb fallback. Foyer's xpra capability
#     probe will return false at startup so the UI hides the toggle
#     entirely; Ardour itself still paints onto :99 fine.
#
# Run in BOTH gui-dummy (where ardour-9 paints into the display)
# and jack-headless (where hardour doesn't open windows but xpra
# is harmless and gives the user a debug peephole) modes. Skipped
# only if `$DISPLAY` was already set externally (escape hatch:
# bind-mount the host's /tmp/.X11-unix and pass `-e DISPLAY=:0`
# for development against a host X server).
# xpra (and a handful of other XDG-respecting tools) wants a writable
# per-user runtime dir. The Cloud Run / `docker run` defaults don't
# create `/run/user/<uid>` and don't set `XDG_RUNTIME_DIR`, which makes
# xpra log a `using '/tmp'` warning and dump its sockets next to
# whatever else is in /tmp. Set it up explicitly so xpra's per-display
# state lives in a deterministic, owned spot — and so anything else
# that asks for `XDG_RUNTIME_DIR` (dbus session bus, gtk's settings
# daemon, etc.) gets a sane answer.
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
    uid=$(id -u)
    xdg_runtime="/run/user/${uid}"
    if mkdir -p "$xdg_runtime" 2>/dev/null && chmod 700 "$xdg_runtime" 2>/dev/null; then
        export XDG_RUNTIME_DIR="$xdg_runtime"
    else
        # `/run` not writable for our uid (gen2 sandbox sometimes
        # mounts it ro). Fall back to a per-uid dir under /tmp;
        # xpra accepts it and at least the path is namespaced so
        # multi-tenant containers don't collide.
        xdg_runtime="/tmp/xdg-runtime-${uid}"
        mkdir -p "$xdg_runtime" && chmod 700 "$xdg_runtime"
        export XDG_RUNTIME_DIR="$xdg_runtime"
    fi
fi
log "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}"

XPRA_PID=""
XVFB_PID=""
start_x_session() {
    if [ -n "${DISPLAY:-}" ] && [ "${DISPLAY}" != ":99" ]; then
        log "DISPLAY=${DISPLAY} already set externally — skipping in-container X spawn"
        return 0
    fi
    # If something else already listens on :99 / TCP 14500, reuse it.
    if [ -e /tmp/.X11-unix/X99 ] || (echo > /dev/tcp/127.0.0.1/14500) 2>/dev/null; then
        log "X session already up on :99 — reusing"
        export DISPLAY=:99
        return 0
    fi
    if command -v xpra >/dev/null 2>&1; then
        # Bind interface: default to `0.0.0.0` so that a host-side
        # `docker run -p 14500:14500` actually reaches xpra. With
        # `127.0.0.1` (container-loopback), docker-proxy can't
        # forward into the container's net namespace and you get
        # `ERR_EMPTY_RESPONSE` from the host browser. Binding to
        # 0.0.0.0 INSIDE the container doesn't widen the attack
        # surface — the container's network is already isolated;
        # only ports the operator explicitly publishes via `-p` (or
        # whatever Cloud Run does at the edge) reach the outside.
        # Override via `FOYER_XPRA_BIND=127.0.0.1` if you're
        # paranoid AND using `--network=host`.
        xpra_bind="${FOYER_XPRA_BIND:-0.0.0.0:14500}"
        log "starting xpra on :99 (HTML5 client at http://<host>:14500, bind=${xpra_bind})"
        # Flag rationale (mirrors `just run`):
        #   --auth=none --tcp-auth=none --ws-auth=none — xpra 19+
        #     defaults to credential prompts; the HTML5 client
        #     uses the WS path so --ws-auth is the load-bearing
        #     one. foyer-server's same-origin /ws/plugin-gui proxy
        #     is the typical client; the publishing operator is
        #     responsible for not exposing 14500 to the public
        #     internet (or layering their own auth in front of it).
        #   --resize-display=no + fixed 1920x1280 Xvfb — keep the
        #     virtual screen large enough that Ardour's editor
        #     mixer "tall enough" check passes regardless of the
        #     iframe size the user resizes to. ARDOUR_LOVES_STUPID_TINY_SCREENS
        #     below is belt-and-braces for the same modal.
        #   --html=on — serves xpra-html5 from xpra's bundled dist
        #     on the same TCP socket we publish for plugin GUI
        #     projection. So `http://localhost:14500/` in the host
        #     browser shows the full desktop without going through
        #     the foyer iframe (which only shows one matched
        #     window). That's the troubleshooting peephole.
        xpra start :99 \
            --bind-tcp="${xpra_bind}" --html=on \
            --auth=none --tcp-auth=none --ws-auth=none \
            --start-via-proxy=no --no-pulseaudio --no-mdns \
            --no-daemon \
            --dpi=96 --resize-display=no \
            --xvfb="Xvfb +extension Composite +extension DAMAGE +extension RANDR -extension MIT-SHM -screen 0 1920x1280x24+32 -nolisten tcp -noreset -dpi 96" \
            >/tmp/foyer-xpra.log 2>&1 &
        XPRA_PID=$!
        # Wait for the TCP socket — that's the binary readiness
        # signal across xpra versions (xpra 6+ uses abstract X11
        # sockets so the file under /tmp/.X11-unix isn't created).
        # 10s budget; xpra's Xvfb spawn dominates the cold-start.
        for _ in $(seq 1 100); do
            (echo > /dev/tcp/127.0.0.1/14500) 2>/dev/null && break
            sleep 0.1
        done
        if (echo > /dev/tcp/127.0.0.1/14500) 2>/dev/null; then
            log "xpra ready on :99 (PID ${XPRA_PID})"
        else
            log "WARNING: xpra spawned but TCP 14500 never came up — see /tmp/foyer-xpra.log"
        fi
    else
        log "xpra not installed — falling back to bare Xvfb on :99 (plugin GUI projection unavailable)"
        Xvfb :99 -screen 0 1920x1280x24 -nolisten tcp \
            >/tmp/foyer-xvfb.log 2>&1 &
        XVFB_PID=$!
        for _ in $(seq 1 30); do
            [ -e /tmp/.X11-unix/X99 ] && break
            sleep 0.1
        done
    fi
    export DISPLAY=:99
}
start_x_session
log "DISPLAY=${DISPLAY:-<unset>}"

if [ "${FOYER_RUNTIME_MODE}" = "gui-dummy" ]; then
    FOYER_JACK_MODE=none
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
    # file and the `backend="Foyer Dummy"` line that EngineControl
    # parses (line 2081 of engine_dialog.cc — backend property is
    # the load-bearing field).
    if [ -f "$cfg_dir/config" ] && grep -q 'backend="Foyer Dummy"' "$cfg_dir/config" 2>/dev/null; then
        log "Ardour config seed verified: $cfg_dir/config has Foyer Dummy backend pinned"
    else
        log "WARNING: $cfg_dir/config missing or lacks Dummy AMS state — GUI ardour-9 will pick JACK at startup"
        log "WARNING: contents of $cfg_dir (if any):"
        ls -la "$cfg_dir" 2>&1 | sed 's/^/[entrypoint]   /' >&2 || true
    fi
fi

# Ardour env setup: both Dockerfile variants land a wrapper at
# `/usr/bin/ardour9` and the real binary under `/usr/lib/ardour9/` —
#   * Dockerfile.source: `waf install --prefix=/usr --configdir=/etc`
#     generates the wrapper from gtk2_ardour/ardour.sh.in.
#   * Dockerfile.prebuilt: apt's `-t sid ardour` package ships the
#     same shape (Debian's `update-alternatives` registers
#     /usr/bin/ardour9 → /usr/bin/ardour-X.Y.Z~ds).
# Either way the wrapper exports LD_LIBRARY_PATH, GTK_PATH,
# ARDOUR_DATA_PATH, ARDOUR_CONFIG_PATH, ARDOUR_DLL_PATH, VAMP_PATH
# before exec'ing the binary, so we don't need to source anything
# here. foyer-cli's `detect_ardour_executable` finds `ardour9` on
# $PATH first (then falls back to plain `ardour`).
#
# `FOYER_ARDOUR_BUILD_ROOT` is still honored as an override for dev
# environments that prefer a sibling source build — see
# foyer-config::detect_ardour_executable for the resolution order.

# Make sure the foyer surface .so is reachable. The Dockerfile
# installs it under /opt/foyer/surfaces; ARDOUR_SURFACES_PATH is
# additive, so layering `/opt/foyer/surfaces` keeps Ardour's stock
# surfaces discoverable.
export ARDOUR_SURFACES_PATH="/opt/foyer/surfaces:${ARDOUR_SURFACES_PATH:-}"

# Same shape for the audio-backend path: Foyer ships its own
# patched "Foyer Dummy" backend (libfoyer_audiobackend.so —
# absolute-time-sleep timing fix vs. the upstream "None (Dummy)")
# that we install at /opt/foyer/backends. Layering it here lets
# Ardour discover it alongside the stock backends; the seeded
# AMS state asks for it by name so autostart picks it.
export ARDOUR_BACKEND_PATH="/opt/foyer/backends:${ARDOUR_BACKEND_PATH:-}"

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
    if [ -n "${XPRA_PID}" ] && kill -0 "${XPRA_PID}" 2>/dev/null; then
        log "shutting down xpra (pid ${XPRA_PID})"
        kill -TERM "${XPRA_PID}" 2>/dev/null || true
    fi
    if [ -n "${XVFB_PID}" ] && kill -0 "${XVFB_PID}" 2>/dev/null; then
        log "shutting down Xvfb (pid ${XVFB_PID})"
        kill -TERM "${XVFB_PID}" 2>/dev/null || true
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
