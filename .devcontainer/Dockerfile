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
      # ---- foyer native deps ----
      libopus-dev \
      # ---- tauri/wry desktop shell (M4.5) ----
      libwebkit2gtk-4.1-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libsoup-3.0-dev \
    && rm -rf /var/lib/apt/lists/*

# Create vscode user (UID 1000) with passwordless sudo, mirroring the devcontainer convention.
RUN groupadd --gid 1000 vscode \
    && useradd --uid 1000 --gid vscode --shell /bin/bash --create-home vscode \
    && echo 'vscode ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/vscode \
    && chmod 0440 /etc/sudoers.d/vscode

# Install `just` task runner
RUN curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh \
      | bash -s -- --to /usr/local/bin \
    && just --version

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
