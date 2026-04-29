# Foyer Studio — running it

End-user doc for getting Foyer up against your own Ardour install or
inside a container. Architecture lives in
[ARCHITECTURE.md](ARCHITECTURE.md); developer workflow (the dev
container, UI variants, test gate) lives in [DEVELOPMENT.md](DEVELOPMENT.md).

There are two supported deployment shapes:

1. **Host install** — `foyer` runs on your laptop / studio machine
   and drives the Ardour you already have installed. macOS and Linux,
   either Apple Silicon or x86_64 Linux. Use this when you want
   real audio hardware and the lowest-latency path.
2. **Docker** — Foyer + Ardour + the shim + a curated LV2 plugin
   pack all live inside a single image. Use this when you want a
   one-shot deploy (Cloud Run, fly.io, a home server), or when you
   don't care about driving studio gear directly and just want a
   browser-reachable mixing surface.

## Path 1 — host install against your own Ardour 9.2

The installer drops a single `foyer` binary on your `$PATH` and
copies the C++ shim into Ardour's surfaces directory so the next
time you launch Ardour, **Preferences → Control Surfaces → Foyer
Studio Shim** is the box you tick.

### Prerequisites

- **Ardour 9.2** (`ardour9`, or `Ardour9.app` on macOS). Other
  9.x point releases usually work because the shim is built against
  9.2 ABI; 8.x and 10.x do not. Get it from
  <https://community.ardour.org/download> — paying their suggested
  donation is the right call.
- **JACK 2** — Ardour's preferred audio backend. macOS: Homebrew's
  `jack` package, or the JACK installer at <https://jackaudio.org>.
  Linux: your distro's `jackd2` package. (Ardour can also run
  against ALSA / CoreAudio directly if you don't want JACK; the
  shim is agnostic.)
- A browser. Chrome/Edge/Safari/Firefox all work. Mobile Safari
  too — the UI is responsive.

### Install

```bash
# Linux x86_64 / macOS (both Intel and Apple Silicon — the
# installer auto-detects).
curl -fsSL https://raw.githubusercontent.com/hotspoons/foyer-studio/main/install.sh \
  | bash -s -- --latest-ci
```

The installer:

1. Detects OS + arch.
2. Downloads `foyer-<os>-<arch>.zip` from the most recent passing
   CI build (no GitHub auth needed — proxied via nightly.link).
3. Unpacks `foyer` into `$XDG_DATA_HOME/foyer/bin/` (or
   `~/.local/share/foyer/bin/`).
4. Installs the shim:
   - **Linux:** `~/.config/ardour9/surfaces/libfoyer_shim.so`
   - **macOS:** `~/Library/Preferences/Ardour9/surfaces/libfoyer_shim.dylib`
5. Adds the install bin dir to `PATH` in your shell rc.

Re-source your shell rc (`source ~/.zshrc`, `source ~/.bashrc`, or
just open a new terminal). Verify:

```bash
foyer --version
```

### Wire Ardour to the shim

One-time per machine:

1. Launch Ardour.
2. Open any session, or create a fresh one.
3. **Preferences → Control Surfaces → Foyer Studio Shim** → tick
   the **Enable** box, then **Edit** if you want to inspect the
   socket path it advertises (defaults to `/tmp/foyer.sock`).
4. Save the session. Ardour persists the surface activation per
   session, so the next time you open this project the shim
   re-attaches automatically.

### Run

With Ardour already running and the shim active, in another terminal:

```bash
foyer serve --backend ardour
```

Open <http://127.0.0.1:3838>. Foyer attaches over the shim's Unix
socket and the mixer / timeline / transport reflect Ardour's live
state. If you stop Ardour, Foyer surfaces a "backend lost" banner;
relaunch Ardour and the sidecar reconnects on the next shim
advertisement.

If you want the launcher experience (no Ardour running yet — Foyer
spawns it for you on a project pick), don't pre-launch Ardour:

```bash
foyer serve --backend ardour --jail ~/Music/Ardour
```

The `--jail` flag confines the file picker to that directory; click
a session in the browser and Foyer execs Ardour with that project,
waits for the shim socket, and attaches.

### Reaching it from another device

Plain HTTP only works from the host itself. To reach Foyer from a
phone or tablet on the same LAN you need TLS — the browser refuses
to load `AudioWorklet` over plain HTTP (which the mixer's
**Listen** button needs):

```bash
foyer serve --backend ardour --listen 0.0.0.0:3838 \
  --tls-cert ~/.config/foyer/dev.pem --tls-key ~/.config/foyer/dev-key.pem
```

If you don't have a cert pair, the dev container's `just run-tls`
recipe shows the openssl one-liner to generate a self-signed pair.
Mobile browsers will surface a one-time warning that you accept;
after that the origin is trusted enough for `getUserMedia` and the
worklets.

For sharing off-network — to a collaborator over the public
internet — open **Session → Remote Access…** in the UI. That spins
up a Cloudflare tunnel, mints an invite URL, and applies the
per-role RBAC rules. See [SECURITY.md](SECURITY.md) for the threat
model.

### Uninstall

```bash
foyer-studio-uninstall            # if it's still on $PATH
# or:
~/.local/share/foyer/install.sh uninstall
```

Pass `--purge` to also wipe `~/.local/share/foyer/` (the install
root, plus your config, recents, and saved layouts).

## Path 2 — Docker

The `Dockerfile` at the repo root produces a self-contained image:
Ardour 9.2 compiled from source, the C++ shim, the autovocoder LV2
plugin, the Rust sidecar, and ~200 LV2 plugins for tracks-with-
sound on day one. The image weighs in around 2 GB and the slow path
is the Ardour build (~15 min on a modern CPU); subsequent builds
benefit from BuildKit's layer cache.

```bash
just docker-build
# or, for a custom tag / extra build args:
just docker-build image=ghcr.io/me/foyer:dev args="--build-arg ARDOUR_TAG=master"
```

…and to spin one up locally:

```bash
just docker-run
# = docker run --rm -it -p 3838:3838 -v foyer-projects:/projects foyer-studio:latest
```

Open <http://127.0.0.1:3838>. The first boot lights up an internal
`jackd dummy` so the headless Ardour the picker spawns has a backend
to talk to; pick (or upload) a project and you're mixing.

### Container env knobs

The image's [`entrypoint.sh`](../scripts/runtime/entrypoint.sh) reads
these on every boot:

| Env var               | Default       | What it does                                                                                                  |
|-----------------------|---------------|---------------------------------------------------------------------------------------------------------------|
| `PORT`                | `3838`        | Port to bind. Cloud Run injects this; we honor it.                                                            |
| `FOYER_BACKEND`       | `ardour`      | Initial backend id. `stub` skips Ardour entirely.                                                             |
| `FOYER_JAIL`          | `/projects`   | Directory the file picker is confined to. Bind-mount a host volume here for persistent projects.              |
| `FOYER_JACK_MODE`     | `embedded`    | One of `embedded` / `shm` / `netjack` / `none`. See **JACK passthrough** below.                              |
| `FOYER_SAMPLE_RATE`   | `48000`       | Engine sample rate, Hz.                                                                                       |
| `FOYER_PERIOD_FRAMES` | `1024`        | JACK period frames (latency vs. CPU tradeoff). Honored only by `embedded` and `netjack` modes.                |
| `FOYER_NETJACK_HOST`  | _unset_       | NetJack2 server hostname or `host:port`. Required when `FOYER_JACK_MODE=netjack`.                             |
| `FOYER_NETJACK_PORT`  | `19000`       | NetJack2 server port; only used if `FOYER_NETJACK_HOST` doesn't already include a port.                       |
| `FOYER_TLS_CERT`      | _unset_       | PEM cert path (for direct HTTPS without a fronting proxy). Pair with `FOYER_TLS_KEY`.                         |
| `FOYER_TLS_KEY`       | _unset_       | PEM key path matching `FOYER_TLS_CERT`.                                                                       |
| `FOYER_LISTEN`        | `0.0.0.0:$PORT` | Override the listen address entirely. The defaults already DTRT; reach for this only if you need IPv6 or a unix socket. |

### JACK passthrough — the four modes

The container has its own `jackd` available. How (or whether) it
connects to host audio depends on `FOYER_JACK_MODE`:

#### `embedded` (default)

`jackd -d dummy` runs inside the container. No host audio. This is
the right mode for Cloud Run, fly.io, an off-site demo box —
anywhere the container has no hardware to drive. The browser still
gets audio via the master-tap egress over WebSocket; collaborators
can still send their mics in. The DAW just doesn't push samples to
a soundcard.

```bash
docker run --rm -p 3838:3838 -v foyer-projects:/projects foyer-studio:latest
```

#### `shm` — share the host's running JACK over `/dev/shm`

Host already has `jackd` running. The JACK client libs find their
server through `/dev/shm/jack-<uid>/*` and `/tmp/jack-<uid>/*`
sockets, so we bind-mount them in. **Linux hosts only** — JACK's
shm path doesn't exist on macOS Docker Desktop's VM.

```bash
# On the host first:
jackd -R -d alsa -d hw:0 -r 48000 -p 1024 &

# Then in the container:
docker run --rm -p 3838:3838 \
  --ipc=host \
  -v /dev/shm:/dev/shm \
  -v /tmp:/tmp:rw \
  -e FOYER_JACK_MODE=shm \
  -v foyer-projects:/projects \
  --user "$(id -u):$(id -g)" \
  --group-add audio \
  foyer-studio:latest
```

`--ipc=host` lets the container's JACK clients talk to the host
server's POSIX shm segments. `--user "$(id -u):$(id -g)"` keeps
file ownership predictable on the bind mounts (the image's default
`foyer:foyer` uid/gid is 1000, but if your host user is uid 1001
the shm segments belong to a different uid). `--group-add audio`
adds the runtime user to the host's `audio` group so realtime
priorities can be requested.

#### `netjack` — connect over the network

Useful when host and container are on different machines (e.g. a
home studio host and a cloud-rendered Foyer instance). The
container spawns a JACK client with the `net` driver pointed at
the remote NetJack2 server.

```bash
# On the audio host (linux):
#   apt install jack-tools  # for jack_load
jack_load netmanager &     # publishes the host's jackd over the LAN

# On the Foyer container's host:
docker run --rm -p 3838:3838 \
  -e FOYER_JACK_MODE=netjack \
  -e FOYER_NETJACK_HOST=192.168.1.42 \
  -e FOYER_NETJACK_PORT=19000 \
  -v foyer-projects:/projects \
  foyer-studio:latest
```

Latency tracks the LAN round-trip; on a quiet wired LAN this is
typically 5–10 ms. NetJack2 is built into JACK 2 — no extra
package needed in the container.

#### `none` — skip JACK entirely

For when you only want the stub backend (Foyer demo mode without
a real DAW behind it).

```bash
docker run --rm -p 3838:3838 \
  -e FOYER_JACK_MODE=none \
  -e FOYER_BACKEND=stub \
  foyer-studio:latest
```

### Docker on macOS — about audio passthrough

Docker Desktop on macOS runs containers inside a Linux VM that
**doesn't** expose CoreAudio devices. `embedded` and `netjack`
modes still work; `shm` does not (no host JACK to share). Mac users
who need real audio hardware should use **Path 1 (host install)**.

### Persistent projects

The image stores nothing in `/projects` itself, so without a volume
all uploads vanish on container stop. Pin a Docker volume:

```bash
docker volume create foyer-projects
docker run --rm -p 3838:3838 -v foyer-projects:/projects foyer-studio:latest
```

…or a host directory bind-mount if you want to inspect the
filesystem outside the container:

```bash
mkdir -p ~/foyer-projects
docker run --rm -p 3838:3838 \
  -v ~/foyer-projects:/projects \
  --user "$(id -u):$(id -g)" \
  foyer-studio:latest
```

### Uploading and exporting projects

Once the container is running, the UI's **Session → Upload
Project…** action takes a `.zip`, `.tar.gz`, or `.tar.zst` archive
and unpacks it into the jailed `/projects` directory. Collisions
get a numeric suffix (`my-session-2`). The matching **Export
Project…** action saves the open session and downloads it as a
`.tar.gz`. This is the easiest way to seed a fresh container with
existing Ardour sessions, or move sessions between an embedded
deploy and a desktop.

The upload pipeline runs four layers of defense before the
project lands in the jail — symlink-rejecting extractor, zip-bomb
caps, an XML scrubber that quarantines `<Script>` /
`<Videotimeline>` blocks (Ardour auto-executes them; we don't),
and outright deletion of `instant.xml` / `*.history` (parsed with
libxml2's `XML_PARSE_HUGE` → DoS surface). If you upload your own
session and it carried legitimate Lua scripts, the originals are
preserved as inert XML comments — restore them on a trusted
desktop with `foyer scrub-restore <session.ardour>`. Full
threat-model walk-through in [SECURITY.md](SECURITY.md).

### Pulling a prebuilt image from GHCR

CI publishes the image to GitHub Container Registry on every push.
Two tagging schemes:

| Tag | When it updates | Pin lifetime |
|---|---|---|
| `ghcr.io/<owner>/foyer-studio:latest` | After every merge to `main` | Mutable |
| `ghcr.io/<owner>/foyer-studio:main-<short-sha>` | After every merge to `main` | Immutable per commit |
| `ghcr.io/<owner>/foyer-studio:snapshot-latest` | After every push to a non-main branch | Mutable |
| `ghcr.io/<owner>/foyer-studio:snapshot-<short-sha>` | After every push (any branch) | Immutable per commit |

Production deployments pin `main-<sha>` (or `latest` if you accept
auto-update on every merge). Feature-branch previews — "let me see
what this PR ships in a real container" — pull
`snapshot-<short-sha>` from the branch's most recent CI run.

```bash
docker pull ghcr.io/hotspoons/foyer-studio:latest
docker run --rm -p 3838:3838 -v foyer-projects:/projects \
  ghcr.io/hotspoons/foyer-studio:latest
```

The first push of a fresh branch triggers a ~15-30 min Ardour
compile inside the builder stage; subsequent pushes restore from
the BuildKit cache and finish in 1-2 minutes. Cache scopes per
branch with `main` as fallback, so a new feature branch inherits a
warm cache.

### Deploying to Google Cloud Run

The image is shaped to fit the free tier. Cloud Run can pull
directly from GHCR (no need to push into Artifact Registry first):

```bash
gcloud run deploy foyer-studio \
  --image ghcr.io/hotspoons/foyer-studio:latest \
  --port 3838 \
  --memory 2Gi --cpu 2 \
  --min-instances 0 --max-instances 1 \
  --allow-unauthenticated \
  --execution-environment gen2
```

**Continuous deployment.** [`.github/workflows/cloudrun-deploy.yml`](../.github/workflows/cloudrun-deploy.yml)
auto-deploys the `:latest` GHCR image after every successful main
build. It's gated on the `GCP_PROJECT` repo variable being set —
the workflow file's header has the one-time setup recipe (Workload
Identity Federation, service account, the four secrets/variables
to add). Once configured, every merge to `main` lands on Cloud Run
within a couple of minutes of the GHCR push completing.

For private images, mirror to Artifact Registry first:

```bash
docker pull ghcr.io/hotspoons/foyer-studio:latest
docker tag ghcr.io/hotspoons/foyer-studio:latest \
  us-central1-docker.pkg.dev/$PROJECT/foyer/foyer-studio:latest
docker push us-central1-docker.pkg.dev/$PROJECT/foyer/foyer-studio:latest

gcloud run deploy foyer-studio \
  --image us-central1-docker.pkg.dev/$PROJECT/foyer/foyer-studio:latest \
  --port 3838 --memory 2Gi --cpu 2 \
  --min-instances 0 --max-instances 1 \
  --allow-unauthenticated --execution-environment gen2
```

`--execution-environment gen2` matters: gen1 doesn't expose `/dev/shm`
the way `jackd` expects. `--max-instances 1` is intentional —
multiple instances would each have their own in-memory state and
`/projects` volume, so a load-balancer hop between them would lose
the user's session. If you need horizontal scale, that's a
front-the-tunnel-with-a-real-orchestrator problem, not a Cloud Run
one.

Cloud Run has no persistent disk on the free tier; uploaded
projects survive only for the lifetime of the instance. For a
public demo that's usually fine; for anything beyond that, mount a
GCS bucket via [GCS Fuse](https://cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts)
at `/projects` and Foyer's upload/export flows just work.

## Logs and debugging

```bash
# Container path:
docker logs -f <container-id>
# Look for:
#   foyer-server listening on http://0.0.0.0:3838
#   tunnel config loaded — ngrok: …, cloudflare: …
#   RBAC policy loaded — roles: …

# Host install path:
RUST_LOG=foyer_server=debug foyer serve --backend ardour
# DAW stdout/stderr lands at $XDG_STATE_HOME/foyer/daw.log
# (defaults to ~/.local/state/foyer/daw.log on Linux,
#  ~/Library/Application Support/foyer/daw.log on macOS)
```

The `/console` HTTP endpoint streams the DAW log into the
**View → Console** panel in the UI; you don't need to tail the
file directly unless something is broken before the WebSocket
connection comes up.

## Where to read next

- [DEVELOPMENT.md](DEVELOPMENT.md) — building from source, the dev
  container, UI authoring overlays, the CI test gate.
- [SECURITY.md](SECURITY.md) — RBAC, tunnel auth, owner vs. guest
  trust model.
- [ARCHITECTURE.md](ARCHITECTURE.md) — three-layer walkthrough,
  wire contract, conventions.
- [DECISIONS.md](DECISIONS.md) — every architectural tradeoff
  logged as a numbered ADR.
