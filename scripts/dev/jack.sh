#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
jack subcommands:
  help    Print this help
  start   Start JACK dummy backend if not running
  stop    Stop JACK dummy backend
  status  Show JACK status
EOF
}

start_jack() {
    if pgrep -x jackd >/dev/null; then
        echo "jack: already running (pid $(pgrep -x jackd))"
        return
    fi
    rm -rf /dev/shm/jack-"$(id -u)" /dev/shm/jack_default_* 2>/dev/null || true
    echo "jack: starting dummy backend @ 48kHz, 720 frames"
    jackd -R -P 10 -d dummy -r 48000 -p 720 >/tmp/jackd.log 2>&1 &
    for _ in {1..20}; do
        pgrep -x jackd >/dev/null && break
        sleep 0.1
    done
    sleep 0.3
    if pgrep -x jackd >/dev/null; then
        echo "jack: up (pid $(pgrep -x jackd))"
    else
        echo "jack: failed to start"
        sed -n '1,80p' /tmp/jackd.log
        exit 1
    fi
}

stop_jack() {
    if pgrep -x jackd >/dev/null; then
        pkill -TERM -x jackd || true
        for _ in {1..20}; do
            pgrep -x jackd >/dev/null || break
            sleep 0.1
        done
        rm -rf /dev/shm/jack-"$(id -u)" /dev/shm/jack_default_* 2>/dev/null || true
        echo "jack: stopped"
    else
        echo "jack: not running"
    fi
}

status_jack() {
    if pgrep -x jackd >/dev/null; then
        echo "jack: running (pid $(pgrep -x jackd))"
    else
        echo "jack: not running"
    fi
}

cmd="${1:-help}"
shift || true

case "$cmd" in
    help) usage ;;
    start) start_jack ;;
    stop) stop_jack ;;
    status) status_jack ;;
    *)
        echo "Unknown jack subcommand: $cmd"
        usage
        exit 1
        ;;
esac
