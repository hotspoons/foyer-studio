set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @echo "Top-level recipes:"
    @just --list
    @echo ""
    @echo "Subcommands:"
    @./scripts/dev/ardour.sh help
    @./scripts/dev/shim.sh help
    @./scripts/dev/tw.sh help
    @./scripts/dev/jack.sh help

prep:
    ./scripts/dev/tw.sh check
    ./scripts/dev/ardour.sh ensure
    ./scripts/dev/jack.sh start
    ./scripts/dev/shim.sh check

run *args='': prep
    cargo run --bin foyer -- serve --listen 0.0.0.0:3838 {{args}}

run-tls *args='': prep
    #!/usr/bin/env bash
    tls_dir="${XDG_DATA_HOME:-$HOME/.local/share}/foyer/tls"
    mkdir -p "$tls_dir"
    cert="$tls_dir/dev.pem"
    key="$tls_dir/dev-key.pem"
    if [ ! -f "$cert" ] || [ ! -f "$key" ]; then
        echo "Generating self-signed cert at $tls_dir/"
        san_lines=("DNS:localhost" "IP:127.0.0.1" "IP:::1")
        for ip in $(hostname -I 2>/dev/null); do
            case "$ip" in
                127.*|172.17.*|172.18.*|172.19.*|172.20.*) continue ;;
            esac
            san_lines+=("IP:$ip")
        done
        san_joined=$(IFS=,; echo "${san_lines[*]}")
        openssl req -x509 -newkey rsa:2048 -nodes             -days 365             -keyout "$key" -out "$cert"             -subj "/CN=foyer-dev"             -addext "subjectAltName=$san_joined"             2>/dev/null
        echo "SAN: $san_joined"
    fi
    cargo run --bin foyer -- serve         --listen 0.0.0.0:3838         --tls-cert "$cert" --tls-key "$key"         {{args}}

clippy:
    cargo clippy --workspace --all-targets -- -D warnings

test:
    cargo test --workspace --all-targets

e2e:
    ./scripts/dev/shim.sh e2e

config-reset:
    #!/usr/bin/env bash
    cfg_path="$(cargo run --bin foyer -- config-path | awk 'NF { line=$0 } END { print line }')"
    if [ -n "$cfg_path" ] && [ -f "$cfg_path" ]; then
        rm -f "$cfg_path"
        echo "Removed $cfg_path"
    fi
    cargo run --bin foyer -- configure --force

tw-build:
    ./scripts/dev/tw.sh build

ardour cmd='help' *args='':
    ./scripts/dev/ardour.sh {{cmd}} {{args}}

shim cmd='help' *args='':
    ./scripts/dev/shim.sh {{cmd}} {{args}}

tw cmd='help' *args='':
    ./scripts/dev/tw.sh {{cmd}} {{args}}

jack cmd='help' *args='':
    ./scripts/dev/jack.sh {{cmd}} {{args}}
