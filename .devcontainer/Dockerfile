# Debian trixie base. Rust toolchain installed via rustup below.
#
# Full `debian:trixie` (NOT `-slim`) — same call as the production
# runtime image. The dev container already pulls in ~3 GB of audio
# build deps + plugins; the ~30 MB difference between `trixie` and
# `trixie-slim` is rounding error and slim drops procps, psmisc,
# iproute2, etc., which makes inner-loop debugging painful (no `ss`,
# no `pgrep`). Going full trixie + the explicit diagnostic-pack
# below keeps the dev shell at parity with the runtime container.
FROM debian:trixie

ARG TARGETPLATFORM
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

# System dependencies split into three logical groups:
#   1. base dev tooling
#   2. ardour build deps (waf needs these to build the sibling ardour checkout)
#   3. foyer-specific native deps (rust crates that link to C libs; tauri/wry)
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      pkg-config \
      cmake \
      ninja-build \
      clang \
      lld \
      # gdb for post-mortem crash analysis (core file backtraces when
      # hardour or the shim SIGSEGV); file for quick binary inspection.
      gdb \
      file \
      git \
      git-lfs \
      curl \
      wget \
      ca-certificates \
      gnupg \
      lsb-release \
      bash-completion \
      fzf \
      ripgrep \
      shellcheck \
      sudo \
      vim \
      less \
      # ---- diagnostic / process-introspection pack ----
      # Mirror of the runtime image's diag pack (Dockerfile in repo
      # root). Full trixie ships some of these by default; explicit
      # install means a `docker exec` shell into either container
      # gets the same set. procps = pgrep/ps/top, psmisc = pstree/
      # killall/fuser, iproute2 = ss/ip, lsof = "who has :14500?",
      # net-tools = legacy netstat/ifconfig.
      procps \
      psmisc \
      iproute2 \
      lsof \
      net-tools \
      htop \
      # bun's installer unpacks a zip into BUN_INSTALL.
      # `zip` is needed by `just release-bundle` to package the
      # platform-specific foyer-<os>-<arch>.zip artifacts.
      unzip \
      zip \
      # musl-tools provides musl-gcc — used by `just release-bundle`
      # to produce fully-static Linux binaries (matching what CI
      # ships).
      musl-tools \
      python3 \
      python3-pip \
      libssl-dev \
      # ---- ardour build deps ----
      libboost-dev \
      libgtkmm-2.4-dev \
      libglibmm-2.4-dev \
      libsigc++-2.0-dev \
      libxml2-dev \
      libarchive-dev \
      libfftw3-dev \
      libaubio-dev \
      vamp-plugin-sdk \
      liblrdf-dev \
      libtag1-dev \
      liblo-dev \
      librubberband-dev \
      libreadline-dev \
      libcurl4-openssl-dev \
      libusb-1.0-0-dev \
      libserd-dev \
      libsord-dev \
      liblilv-dev \
      libsuil-dev \
      libsratom-dev \
      libsamplerate0-dev \
      libpulse-dev \
      libdbus-1-dev \
      libwebsockets-dev \
      libcwiid-dev \
      libasound2-dev \
      libjack-jackd2-dev \
      libsndfile1-dev \
      # ---- audio runtime (optional — dummy mode works without hardware) ----
      # jackd2 ships the `jackd` daemon so Ardour can use its native backend
      # inside the container via `jackd -d dummy` (no audio device required).
      # See `just jack-dummy` in the root justfile. On Linux hosts you can
      # also pass /dev/snd + the PulseAudio socket through for real audio —
      # see the commented block in devcontainer.json.
      jackd2 \
      alsa-utils \
      pulseaudio-utils \
      # ---- headless X for GUI Ardour + plugin window projection ----
      # Foyer prefers GUI Ardour when $DISPLAY is set (see
      # foyer-config::scan_ardour_build_tree). On Mac/Colima the dev
      # container has no native X, so we run Xvfb in-container as a
      # no-op display Ardour can paint into. xpra is added in a
      # separate RUN block below — it isn't packaged in trixie's
      # main repos, so we pull it from xpra.org's apt repo.
      xvfb \
      # ---- foyer native deps ----
      libopus-dev \
      # ---- tauri/wry desktop shell (M4.5) ----
      libwebkit2gtk-4.1-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libsoup-3.0-dev \
    && rm -rf /var/lib/apt/lists/*

# ── xpra (HTML5 X11 server, for peeking at GUI Ardour + plugin GUIs) ──
#
# xpra was dropped from Debian trixie's main repos at release time
# (RC bugs in the packaging — fixed upstream but didn't make the
# freeze). xpra.org publishes their own apt repo with current builds
# for trixie, signed by the project maintainer's key.
#
# Used by the in-container peek workflow: `xpra start :99 --bind-tcp=
# 127.0.0.1:14500 --html=on` runs an Xvfb under xpra's control and
# serves a JS canvas viewer at :14500. VS Code's port forwarding
# brings that to the host browser without any X forwarding.
RUN curl -fsSL --retry 5 --retry-delay 10 --retry-connrefused --retry-all-errors --max-time 60 \
        https://xpra.org/xpra.asc \
      | gpg --dearmor -o /usr/share/keyrings/xpra-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/xpra-keyring.gpg] https://xpra.org/ trixie main" \
      > /etc/apt/sources.list.d/xpra.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      xpra xpra-x11 xpra-html5 \
 && rm -rf /var/lib/apt/lists/*
# `xpra-x11` is the load-bearing piece for `xpra start :NN`. xpra ≥6
# split the X11 server modes (`seamless`/`desktop`/`shadow`) into a
# separate package; without it `just run-dummy`'s xpra spawn aborts
# with `you must install 'xpra-x11' to use 'seamless'` and the dev
# loop's plugin GUI projection silently doesn't come up.

# ── LV2 plugin + soundfont bundle (devcontainer = release parity) ──
#
# Same plugin pack the production runtime image ships (Dockerfile
# at the repo root). Keeping the dev container at parity means
# UI/UX work, plugin-panel testing, and record-arm workflows
# exercise the same plugin surface a deployed Foyer instance has.
# Total install: ~91 packages, ~378 MB on disk.
#
# Plugin sourcing strategy + KXStudio gotchas are documented in
# the runtime Dockerfile. tl;dr: KXStudio's PPA fills the gaps
# Debian doesn't ship (Dexed, OB-Xd, Geonkick, TAL, MOD pedalboard,
# Cardinal, AIDA-X, Master-Me, …); pinning at priority 100 keeps
# Debian winning on any name collision.
RUN apt-get update && apt-get install -y --no-install-recommends \
      gpg dirmngr ca-certificates curl \
 && curl -fsSL --retry 5 --retry-delay 10 --retry-connrefused --retry-all-errors --max-time 60 \
        "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x89195BA21C5CE3C72BAC1C0A0C955638F15F1FDC" \
      | gpg --dearmor -o /usr/share/keyrings/kxstudio-archive-keyring.gpg \
 && curl -fsSL --retry 5 --retry-delay 10 --retry-connrefused --retry-all-errors --max-time 60 \
        "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0xDF1BC724E4ED8A947FF0B0A1F8599E482BD84BD9" \
      | gpg --dearmor >> /usr/share/keyrings/kxstudio-archive-keyring.gpg \
 && for suite in bionic focal; do \
      for repo in plugins libs apps kxstudio; do \
        echo "deb [signed-by=/usr/share/keyrings/kxstudio-archive-keyring.gpg] http://ppa.launchpad.net/kxstudio-debian/$repo/ubuntu $suite main" \
          >> /etc/apt/sources.list.d/kxstudio.list ; \
      done ; \
    done \
 && printf '%s\n' \
      'Package: *' 'Pin: release o=LP-PPA-kxstudio-debian-libs' 'Pin-Priority: 100' '' \
      'Package: *' 'Pin: release o=LP-PPA-kxstudio-debian-plugins' 'Pin-Priority: 100' '' \
      'Package: *' 'Pin: release o=LP-PPA-kxstudio-debian-apps' 'Pin-Priority: 100' '' \
      'Package: *' 'Pin: release o=LP-PPA-kxstudio-debian-kxstudio' 'Pin-Priority: 100' \
      > /etc/apt/preferences.d/kxstudio.pref \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ardour-lv2-plugins \
      fluid-soundfont-gm fluid-soundfont-gs fluidr3mono-gm-soundfont \
      timgm6mb-soundfont fluidsynth qsynth \
      \
      calf-plugins dpf-plugins-lv2 dragonfly-reverb-lv2 \
      lsp-plugins-lv2 mda-lv2 swh-lv2 x42-plugins zam-plugins \
      tap-plugins caps fil-plugins cmt fomp abgate \
      blop-lv2 invada-studio-plugins-lv2 eq10q bankstown-lv2 lv2vocoder \
      mcp-plugins vco-plugins wah-plugins ir.lv2 rubberband-lv2 \
      zita-rev1 zita-at1 zita-bls1 zita-mu1 \
      \
      avldrums.lv2 avldrums.lv2-soundfont \
      drumkv1-lv2 padthv1-lv2 samplv1-lv2 synthv1-lv2 \
      so-synth-lv2 xsynth-dssi setbfree \
      yoshimi yoshimi-data amsynth whysynth \
      hydrogen hydrogen-data drumgizmo guitarix-lv2 \
      \
      aida-x airwindows-lv2 master-me \
      kxstudio-meta-audio-plugins-collection \
 && rm -rf /var/lib/apt/lists/*

# Create vscode user (UID 1000) with passwordless sudo, mirroring the devcontainer convention.
# Also add vscode to `audio` so `/dev/snd/*` nodes are readable when the
# host passes them through via `--device=/dev/snd` (opt-in via
# devcontainer.json — see the commented runArgs block there). Harmless
# on Mac/Colima where /dev/snd doesn't exist at the container boundary.
RUN groupadd --gid 1000 vscode \
    && useradd --uid 1000 --gid vscode --shell /bin/bash --create-home vscode \
    && usermod -aG audio vscode \
    && echo 'vscode ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/vscode \
    && chmod 0440 /etc/sudoers.d/vscode

# Install `just` task runner
RUN curl --proto '=https' --tlsv1.2 -sSf \
        --retry 5 --retry-delay 10 --retry-connrefused --retry-all-errors --max-time 60 \
        https://just.systems/install.sh \
      | bash -s -- --to /usr/local/bin \
    && just --version

# Install Bun (JS runtime / package manager) system-wide. We keep it in
# /usr/local so non-interactive shells — `just ci`, CI subprocesses,
# the Playwright harness's `exec bunx` — pick it up on PATH without
# sourcing ~/.bashrc. The per-user install path (see
# `.user-post-install.sh`) skips if `bun` is already on PATH, so this
# is the single source of truth in a fresh container.
RUN curl -fsSL --retry 5 --retry-delay 10 --retry-connrefused --retry-all-errors --max-time 60 \
        https://bun.sh/install \
      | BUN_INSTALL=/usr/local bash \
    && bun --version

# Install fastfetch (arch-aware)
RUN ARCH=$(uname -m) \
    && case $ARCH in \
         x86_64)  FF_ARCH="amd64" ;; \
         aarch64) FF_ARCH="aarch64" ;; \
         *) echo "Unknown architecture: $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL --retry 5 --retry-delay 10 --retry-connrefused --retry-all-errors --max-time 60 \
         -o /tmp/fastfetch.deb \
         "https://github.com/fastfetch-cli/fastfetch/releases/download/2.54.0/fastfetch-linux-${FF_ARCH}.deb" \
    && dpkg -i /tmp/fastfetch.deb \
    && rm /tmp/fastfetch.deb

RUN git lfs install --system

USER vscode

# Pre-create XDG base-dir paths owned by vscode. Without this, bind mounts
# in devcontainer.json whose targets are under /home/vscode/.local/ cause
# Docker (running as root) to auto-create the missing parents as root:root,
# which then blocks tools like opencode from mkdir'ing sibling state dirs
# (e.g. ~/.local/state) at runtime.
RUN mkdir -p \
      /home/vscode/.local/share \
      /home/vscode/.local/state \
      /home/vscode/.local/bin \
      /home/vscode/.cache \
      /home/vscode/.config

# Install Rust via rustup (stable) + extra components useful for development.
ENV RUSTUP_HOME=/home/vscode/.rustup \
    CARGO_HOME=/home/vscode/.cargo \
    PATH=/home/vscode/.cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf \
        --retry 5 --retry-delay 10 --retry-connrefused --retry-all-errors --max-time 60 \
        https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --profile minimal \
    && rustup component add rustfmt clippy rust-src rust-analyzer

# Shell setup for the vscode user
RUN { \
      echo ''; \
      echo '# Bash completion'; \
      echo 'if ! shopt -oq posix; then'; \
      echo '  if [ -f /usr/share/bash-completion/bash_completion ]; then'; \
      echo '    . /usr/share/bash-completion/bash_completion'; \
      echo '  elif [ -f /etc/bash_completion ]; then'; \
      echo '    . /etc/bash_completion'; \
      echo '  fi'; \
      echo 'fi'; \
      echo ''; \
      echo '# Just completion'; \
      echo 'command -v just &>/dev/null && source <(just --completions bash)'; \
      echo ''; \
      echo '# Cargo env'; \
      echo '[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"'; \
      echo ''; \
      echo '# Aliases'; \
      echo 'alias ll="ls -la"'; \
      echo 'alias grep="grep --color=auto"'; \
      echo 'export LESS="-rXF"'; \
      echo ''; \
      echo '# Fastfetch'; \
      echo 'command -v fastfetch &>/dev/null && fastfetch'; \
    } >> /home/vscode/.bashrc

WORKDIR /workspaces/foyer-studio

CMD ["/bin/bash"]
