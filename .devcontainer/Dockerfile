# Debian trixie base. Rust toolchain installed via rustup below.
FROM debian:trixie-slim

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
      # bun's installer unpacks a zip into BUN_INSTALL
      unzip \
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
      # ---- foyer native deps ----
      libopus-dev \
      # ---- tauri/wry desktop shell (M4.5) ----
      libwebkit2gtk-4.1-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libsoup-3.0-dev \
      # ---- LV2 plugin + soundfont bundle ----
      # Gives Ardour something real to load in the devcontainer so feature
      # work (plugin-panel rendering, MIDI piano roll, instrument tracks,
      # record-arm testing) has actual audio / MIDI targets instead of an
      # empty plugin list. ardour-lv2-plugins pulls in fluidsynth so
      # a-Fluid Synth works as a GM synth backed by fluid-soundfont-gm.
      # AVL drums + soundfont gives us a ready drum instrument; synthv1
      # / samplv1 / drumkv1 / padthv1 cover the old-school synth shapes;
      # calf / lsp / swh / mda / dpf / x42 / zam / dragonfly are the
      # standard Linux-audio effects suites. Total install: ~200 LV2
      # plugins under /usr/lib/lv2/ + GM soundfont under
      # /usr/share/sounds/sf2/.
      ardour-lv2-plugins \
      avldrums.lv2 \
      avldrums.lv2-soundfont \
      calf-plugins \
      dpf-plugins-lv2 \
      dragonfly-reverb-lv2 \
      drumkv1-lv2 \
      fluid-soundfont-gm \
      fluidsynth \
      lsp-plugins-lv2 \
      mda-lv2 \
      padthv1-lv2 \
      samplv1-lv2 \
      setbfree \
      swh-lv2 \
      synthv1-lv2 \
      timgm6mb-soundfont \
      x42-plugins \
      zam-plugins \
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
RUN curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh \
      | bash -s -- --to /usr/local/bin \
    && just --version

# Install Bun (JS runtime / package manager) system-wide. We keep it in
# /usr/local so non-interactive shells — `just ci`, CI subprocesses,
# the Playwright harness's `exec bunx` — pick it up on PATH without
# sourcing ~/.bashrc. The per-user install path (see
# `.user-post-install.sh`) skips if `bun` is already on PATH, so this
# is the single source of truth in a fresh container.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && bun --version

# Install fastfetch (arch-aware)
RUN ARCH=$(uname -m) \
    && case $ARCH in \
         x86_64)  FF_ARCH="amd64" ;; \
         aarch64) FF_ARCH="aarch64" ;; \
         *) echo "Unknown architecture: $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL -o /tmp/fastfetch.deb \
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
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
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
