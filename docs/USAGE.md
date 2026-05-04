# Foyer Studio — running it

End-user doc for getting Foyer up against your own Ardour install or
inside a container. Architecture lives in
[ARCHITECTURE.md](ARCHITECTURE.md); developer workflow (the dev
container, UI variants, test gate) lives in [DEVELOPMENT.md](DEVELOPMENT.md).

There are two supported deployment shapes:

1. **Docker** — Foyer + Ardour + the shim + a curated LV2 plugin
   pack all live inside a single image. The fastest way to see
   the UI: nothing on your machine but Docker. Use this when you
   want a one-shot deploy (Cloud Run, fly.io, a home server), or
   when you don't care about driving studio gear directly and
   just want a browser-reachable mixing surface.
2. **Host install** — `foyer` runs on your laptop / studio machine
   and drives the Ardour you already have installed. macOS and Linux,
   either Apple Silicon or x86_64 Linux. Use this when you want
   real audio hardware and the lowest-latency path.

## Path 1 — Docker

The published image bundles unmodified upstream Ardour 9.2, our
C++ shim, our [vendored "Foyer Dummy" audio backend](../shims/ardour/backends/dummy/)
(a fork of Ardour's "None (Dummy)" with an absolute-time-sleep
timing fix that keeps the audio clock locked to wall clock on
non-RT threads — what makes pop-free playback possible on Cloud
Run), the Rust sidecar, and a curated ~200-LV2-plugin pack.
Multi-arch (amd64 + arm64) on GHCR; `docker pull` auto-selects
the right arch.

### Standalone — works everywhere

```bash
docker run --rm -it --name foyer-studio \
  -p 3838:3838 --shm-size=1g \
  -v "$(pwd):/projects" \
  ghcr.io/hotspoons/foyer-studio:latest
```

Open <http://localhost:3838>. That's it.

This is the **gui-dummy** runtime mode (default): GUI Ardour
painting onto an in-container Xvfb, using libardour's "None
(Dummy)" backend. No JACK, no realtime scheduling, no privileged
flags. Audio leaves the container only via Foyer's WebSocket
egress — the DAW doesn't need a soundcard. Identical behavior on
Cloud Run, Docker Desktop, Colima, plain Linux.

Three flags worth understanding:

- **`-p 3838:3838`** — the only port Foyer needs to expose. The
  xpra endpoint at 14500 (used for native-plugin-GUI projection)
  is proxied through 3838 internally; you only publish 14500
  separately if you want raw access for debugging.
- **`--shm-size=1g`** — libardour reserves ~107 MB of POSIX shm
  during session load. Docker's default 64 MB tmpfs ENOMEMs the
  open. Cloud Run gen2 auto-sizes `/dev/shm` to ~50% of `--memory`,
  so this flag isn't needed there.
- **`-v "$(pwd):/projects"`** (or any host path you prefer) — see **Volumes** below. Without
  a mount, every project upload vanishes on container stop.

### Volumes

| Mount | What's there | When you need it |
|---|---|---|
| `/projects` | Ardour session dirs uploaded via the UI, plus anything copied in directly. | Always — without persistence, container restart loses everything. **Local examples** use `-v "$(pwd):/projects"` (`pwd` is POSIX — works in bash, zsh, ksh, `/bin/sh` on macOS/Linux); use a named volume (e.g. `-v foyer-projects:/projects`) or another path if you prefer. |
| `/dev/shm` | POSIX shm registry for the host's jackd. | Only when running in `jack-headless` mode against a host-running jackd (next section). |
| `/tmp` | JACK's filesystem socket files. | Same — only for host-jackd passthrough. |

For host-bind mounts, add `--user "$(id -u):$(id -g)"` so files
written from inside the container land owned by your host user
instead of the image's default uid 1000.

### Advanced — host JACK passthrough (real audio, Linux only)

For driving real audio hardware, flip into `jack-headless` mode and
share the host's running jackd:

```bash
# 1. Start jackd on the host (if not already running):
jackd -R -d alsa -d hw:0 -r 48000 -p 1024 &

# 2. Run the container against that jackd:
docker run --rm -it --name foyer-studio \
  -p 3838:3838 --shm-size=1g \
  --privileged --ulimit rtprio=95 --ulimit memlock=-1 \
  --ipc=host \
  -v /dev/shm:/dev/shm -v /tmp:/tmp:rw \
  -v "$(pwd):/projects" \
  --user "$(id -u):$(id -g)" --group-add audio \
  -e FOYER_RUNTIME_MODE=jack-headless \
  -e FOYER_JACK_MODE=shm \
  ghcr.io/hotspoons/foyer-studio:latest
```

What's different vs. standalone:

- **`FOYER_RUNTIME_MODE=jack-headless`** runs the headless `hardour`
  binary against jackd with realtime scheduling — same low-latency
  path Ardour uses normally on a desktop.
- **`--privileged --ulimit rtprio=95 --ulimit memlock=-1`** are
  non-negotiable for RT scheduling. Without them
  `pthread_setschedparam(SCHED_FIFO)` returns EPERM and Ardour's
  AudioEngine fatals at startup.
- **`FOYER_JACK_MODE=shm` + `--ipc=host` + the `/dev/shm` and
  `/tmp` bind mounts** let the container's libjack find the host's
  running jackd through its POSIX-shm registry.
- **`--user "$(id -u):$(id -g)" --group-add audio`** keep the
  in-container uid matching the host's shm-segment owner and add
  the runtime user to the host's `audio` group (needed for RT
  scheduling permission on most distros).

**macOS:** Docker Desktop's Linux VM doesn't expose host audio
devices at all, so JACK shm passthrough doesn't apply. Mac users
wanting real audio hardware should use **Path 2 (host install)**
— `Ardour9.app` against CoreAudio works without JACK, and Foyer
attaches identically.

Other JACK modes available via `FOYER_JACK_MODE` (see env-knobs
table below):

- **`embedded`** — in-container `jackd dummy`. The default for
  `jack-headless` mode if you don't pass `FOYER_JACK_MODE`. Useful
  on a host without its own jackd when you want the RT-scheduling
  path anyway (rare).
- **`netjack`** — the container connects to a remote NetJack2
  server over the LAN. Needs `FOYER_NETJACK_HOST` + optionally
  `FOYER_NETJACK_PORT` (default 19000).
- **`none`** — skip JACK entirely (only useful with
  `FOYER_BACKEND=stub` for demo mode).

### Container env knobs

The image's [`entrypoint.sh`](../scripts/runtime/entrypoint.sh)
honors these on every boot:

| Env var | Default | What it does |
|---|---|---|
| `PORT` | `3838` | Bind port. Cloud Run injects this. |
| `FOYER_BACKEND` | `ardour` | `stub` skips Ardour entirely. |
| `FOYER_JAIL` | `/projects` | File-picker root — bind a volume here. |
| `FOYER_RUNTIME_MODE` | `gui-dummy` | `gui-dummy` (works everywhere) or `jack-headless` (needs privileged + rtprio/memlock). `auto` picks based on rtprio probe. |
| `FOYER_JACK_MODE` | `embedded` | Only when `jack-headless`: one of `embedded` / `shm` / `netjack` / `none`. |
| `FOYER_NETJACK_HOST` / `FOYER_NETJACK_PORT` | _unset_ / `19000` | NetJack2 target when `FOYER_JACK_MODE=netjack`. |
| `FOYER_SAMPLE_RATE` | `48000` | Engine sample rate (Hz). |
| `FOYER_PERIOD_FRAMES` | `1024` | JACK period frames (latency vs. CPU). |
| `FOYER_TLS_CERT` / `FOYER_TLS_KEY` | _unset_ | Direct HTTPS without a fronting proxy. |

### Uploading and exporting projects

The UI's **Session → Upload Project…** takes a `.zip`, `.tar.gz`,
or `.tar.zst` archive and unpacks into `/projects`. **Session →
Export Project…** does the reverse. The upload pipeline runs four
layers of defense (symlink-reject, zip-bomb caps, XML scrubber for
`<Script>` / `<Videotimeline>` blocks, deletion of `instant.xml` /
`*.history`); legitimate Lua scripts in your own sessions are
preserved as inert XML comments and can be restored on a trusted
desktop via `foyer scrub-restore <session.ardour>`. Full
threat-model walk-through in [SECURITY.md](SECURITY.md).

### Building the image locally

```bash
just docker-build       # ~15 min for the Ardour compile, then cached
just docker-run         # standalone (gui-dummy) form
just docker-run-jack    # jack-headless form with the privileged flags
```

### GHCR tags

| Tag | When it updates | Pin lifetime |
|---|---|---|
| `ghcr.io/hotspoons/foyer-studio:latest` | After every merge to `main` | Mutable |
| `…:main-<sha>` | After every merge to `main` | Immutable |
| `…:snapshot-latest` | After every push to a non-main branch | Mutable |
| `…:snapshot-<sha>` | After every push (any branch) | Immutable |

Production: pin `main-<sha>`. Feature-branch previews:
`snapshot-<sha>` from the branch's most recent CI run.

### Deploying to Google Cloud Run

Cloud Run gen2 supports the standalone (gui-dummy) command directly
— no privileged flags or shm sizing needed (gen2 auto-sizes
`/dev/shm`). **One prerequisite:** Cloud Run can ONLY pull from
`gcr.io` / `*-docker.pkg.dev` / `docker.io`; ghcr.io URLs are
rejected. Set up an Artifact Registry remote-repo proxy once:

```bash
gcloud services enable artifactregistry.googleapis.com
gcloud artifacts repositories create ghcr-remote \
  --location=us-central1 \
  --repository-format=docker \
  --mode=remote-repository \
  --remote-docker-repo=https://ghcr.io
```

Then any `ghcr.io/<owner>/<name>:<tag>` is reachable as
`<region>-docker.pkg.dev/<project>/ghcr-remote/<owner>/<name>:<tag>`.

Deploy:

```bash
gcloud run deploy foyer-studio \
  --image=us-central1-docker.pkg.dev/YOUR_PROJECT/ghcr-remote/hotspoons/foyer-studio:latest \
  --region=us-central1 \
  --port=3838 --memory=2Gi --cpu=2 \
  --min-instances=0 --max-instances=1 \
  --execution-environment=gen2 --cpu-boost \
  --timeout=3600 \
  --allow-unauthenticated
```

Non-obvious flags:

- **`--execution-environment=gen2`** — gen2 auto-sizes `/dev/shm`
  (gen1 doesn't, and gen1 also strips capabilities Foyer's xpra
  spawn uses). Always pick gen2.
- **`--cpu-boost`** — Ardour's session load reads thousands of
  small files; cold-start without boost is ~15 s slower.
- **`--timeout=3600`** — Cloud Run's default request timeout is
  60 s; we want the WebSocket to survive longer than that.
- **`--max-instances=1`** — Foyer's state lives in the container
  and `/projects` is per-instance; multiple replicas would silently
  lose collaborative session state.

Persistent projects on Cloud Run: the free tier has no persistent
disk, so uploads survive only for the instance lifetime. For
anything beyond a public demo, mount a GCS bucket at `/projects`
via [GCS Fuse](https://cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts)
— Foyer's upload/export flows just work against it.

**Continuous deployment.** [`.github/workflows/cloudrun-deploy.yml`](../.github/workflows/cloudrun-deploy.yml)
auto-deploys `:latest` after every main build, gated on the
`GCP_PROJECT` repo variable. The workflow header has the one-time
WIF / service-account setup recipe.

## Path 2 — host install against your own Ardour 9.2

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
- **An audio backend Ardour can drive.** The shim is backend-agnostic;
  pick whichever you'd already use with stand-alone Ardour:
  - **macOS** — CoreAudio works out of the box (Ardour's default
    on macOS). JACK via Homebrew's `jack` package or the
    [jackaudio.org](https://jackaudio.org) installer is also fine.
  - **Linux** — JACK 2 (`jackd2`) for the typical low-latency path,
    or ALSA / PipeWire for a JACK-less setup.
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

If you don't have a cert pair, generate a self-signed one. Replace
`192.168.1.42` with this machine's LAN IP so the cert is valid when
the phone connects:

```bash
mkdir -p ~/.config/foyer
openssl req -x509 -newkey rsa:2048 -nodes -days 1825 \
  -keyout ~/.config/foyer/dev-key.pem \
  -out    ~/.config/foyer/dev.pem \
  -subj   "/CN=foyer-dev" \
  -addext "subjectAltName = IP:192.168.1.42, DNS:localhost"
```

Find your LAN IP with `ipconfig getifaddr en0` (macOS) or
`ip -4 addr show | grep inet` (Linux). Mobile browsers will
surface a one-time warning that you accept; after that the
origin is trusted enough for `getUserMedia` and the worklets.

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

### Optional: xpra for native plugin GUI projection

Some plugins (sample-based drums, complex synths, custom-painted
EQs) ship their own GUI that the schema-driven plugin panel can't
reproduce. With **xpra** installed on the host, Foyer projects those
GUIs into the plugin panel via an embedded HTML5 viewer — toggle
between the schema knobs and the native GUI per plugin.

If xpra isn't installed, the "Native GUI" toggle is hidden in the
UI and foyer-server logs an info line at startup pointing here.
Foyer otherwise runs identically.

| Distro | Install command |
|---|---|
| **Debian trixie** (13)        | `sudo apt install xpra xpra-x11 xpra-html5` after adding the [xpra.org](https://xpra.org/install.html) apt repo (the trixie debs were dropped from Debian's main archive at release time). |
| **Debian bookworm** (12) / Ubuntu 24.04+ | `sudo apt install xpra xpra-x11 xpra-html5` |
| **Fedora / RHEL**             | `sudo dnf install xpra xpra-html5` |
| **Arch**                      | `sudo pacman -S xpra` (xpra-html5 is an AUR package) |
| **macOS**                     | `brew install --cask xpra` (or [download](https://xpra.org/install.html#macos) and install the .dmg) |

`xpra-x11` is the X11-server side (modern xpra split it out from
the `xpra` meta-package); without it `xpra start :NN` aborts with
"you must install 'xpra-x11' to use 'seamless'". On Linux servers
without a graphical environment, xpra brings its own Xvfb internally
— no other X dependencies. Restart `foyer serve` after installing
and the toggle appears.

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

For chasing audio-thread issues specifically, the shim emits a
"cycle timing JITTER" warning in `daw.log` whenever the Dummy
backend's process loop sees > 5 ms inter-cycle spread, and a
"ring overflow" warning when the master-tap drain thread can't
keep up with audio production. Both are silent on a healthy
stream — `grep "JITTER\|ring overflow" ~/.local/state/foyer/daw.log`
is the fastest "is something wrong" check.

## Where to read next

- [DEVELOPMENT.md](DEVELOPMENT.md) — building from source, the dev
  container, UI authoring overlays, the CI test gate.
- [SECURITY.md](SECURITY.md) — RBAC, tunnel auth, owner vs. guest
  trust model.
- [ARCHITECTURE.md](ARCHITECTURE.md) — three-layer walkthrough,
  wire contract, conventions.
- [DECISIONS.md](DECISIONS.md) — every architectural tradeoff
  logged as a numbered ADR.
