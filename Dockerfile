# Production Dockerfile — Foyer Studio + Ardour + autovocoder + shim.
#
# Two-stage build:
#   * `builder` stage compiles Ardour from source, the C++ shim that
#     drives it, the autovocoder LV2 plugin, and the Rust sidecar
#     binary in release mode. None of this tooling stays in the final
#     image.
#   * `runtime` stage starts from a slim Debian base, copies in the
#     built artifacts, and ships an entrypoint script that lights up
#     JACK + Foyer the way `just run` does in dev — minus the
#     hot-reload flags. Default backend is `ardour` jailed under
#     `/projects` so a Cloud Run instance gives every visitor a
#     persistent project workspace under one mount.
#
# Networking notes for Cloud Run / single-port hosts:
#   * Listen address obeys `$PORT` (Cloud Run injects this; defaults
#     to 3838 when unset so local `docker run -p 3838:3838` works).
#   * No TLS in-container — Cloud Run terminates HTTPS at its edge,
#     and behind a reverse proxy a Foyer install is plain HTTP. If
#     you're standing this up bare-metal you'll want a fronting nginx
#     or a `--tls-cert` flag on the entrypoint command.
#
# JACK passthrough toggles (see `entrypoint.sh` for the truth table):
#   * `FOYER_JACK_MODE=embedded`   (default) — start jackd dummy on
#     boot. No host audio; everything stays inside the container.
#   * `FOYER_JACK_MODE=shm`        — assume the host already started
#     jackd and bind-mounted /dev/shm + /tmp; we just connect.
#   * `FOYER_JACK_MODE=netjack`    — connect to a remote netjack
#     server pointed at by `FOYER_NETJACK_HOST`.
#
# To build:
#   docker build -t foyer-studio:latest .
# To run locally:
#   docker run --rm -p 3838:3838 -v "$(pwd):/projects" foyer-studio:latest
# To deploy to Cloud Run:
#   gcloud run deploy foyer-studio --image gcr.io/$PROJECT/foyer-studio \
#       --port 3838 --memory 2Gi --cpu 2 --allow-unauthenticated

# ─────────────────────────────────────────────────────────────────
# Stage 1 — builder
# ─────────────────────────────────────────────────────────────────
FROM debian:trixie-slim AS builder

ARG ARDOUR_TAG=9.2
ARG AUTOVOCODER_REF=master
ARG GMSYNTH_VERSION=0.6.4
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

# Add Debian sid as a low-priority apt source so we can pull
# Ardour 9.2.0+ds from there (trixie's main archive carries
# Ardour 8.12 which is ABI-incompatible with the shim's 9.x build
# expectations). Pin sid Pin-Priority=100 / trixie=990 so apt
# default-pulls from trixie EXCEPT for the explicit `-t sid`
# requests below — minimizes drift onto a sid stack.
#
# What sid's `ardour` package transitively pulls in (also onto
# trixie): gcc-16-base, libgcc-s1, libstdc++6, libxml2-16,
# librubberband3, libqm-dsp0t64, libblas3, libgfortran5, liblapack3.
# These are leaf-end runtime libs; pulling them from sid widens
# the libstdc++ ABI to gcc-16's, which is forward-compatible with
# trixie's gcc-14 system libs (newer libstdc++ runs older code).
RUN echo "deb http://deb.debian.org/debian sid main" > /etc/apt/sources.list.d/sid.list \
 && printf '%s\n' \
      'Package: *' \
      'Pin: release a=unstable' \
      'Pin-Priority: 100' \
      > /etc/apt/preferences.d/sid-pin

# Build-time deps. Most of these are -dev packages for libs
# transitively used by Ardour's headers (the shim includes them).
# The Ardour BINARIES + LIBRARIES come from `apt -t sid ardour`
# below, so we no longer need the toolchain to compile Ardour
# itself — just the shim + backend + sidecar against Ardour's
# already-installed shared libraries.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      pkg-config \
      cmake \
      ninja-build \
      git \
      curl \
      ca-certificates \
      python3 \
      python3-pip \
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
      libcurl4-gnutls-dev \
      libusb-1.0-0-dev \
      libserd-dev \
      libsord-dev \
      liblilv-dev \
      libsuil-dev \
      libsratom-dev \
      libsamplerate0-dev \
      libpulse-dev \
      libdbus-1-dev \
      libcwiid-dev \
      libasound2-dev \
      libjack-jackd2-dev \
      libsndfile1-dev \
      libopus-dev \
      libudev-dev \
      libltc-dev \
 && apt-get install -y --no-install-recommends -t sid \
      ardour \
 && rm -rf /var/lib/apt/lists/*
# Two omissions worth noting:
#
# 1. `libwebsockets-dev` intentionally omitted — the Rust sidecar
#    uses pure-Rust tokio-tungstenite for its WS surface; the shim
#    doesn't touch websockets. The package was a defensive include
#    for an Ardour build path we no longer take. Removing it also
#    drops a transitive `libssl-dev` puller, but the pin fix above
#    is the load-bearing thing — the `Pin: a=unstable Pin-Priority:
#    100` on sid (and absence of an explicit `a=stable` boost)
#    leaves trixie/main and trixie-security tied at the default 500
#    so apt naturally picks the security-updated `libssl-dev=u2`
#    over `=u1` from main. Earlier revisions of this Dockerfile
#    boosted `a=stable` to 990, which (because trixie-security is
#    `a=stable-security`, not `a=stable`) demoted security to 500
#    while main went to 990, flipping the version preference.
#
# 2. `libcurl4-dev` is the GnuTLS flavor (not the OpenSSL one).
#    Functionally identical for our build path (waf configure picks
#    libcurl via pkg-config), and avoids transitively pulling
#    libssl-dev — belt-and-braces against any future puller.

# Rust toolchain — minimal profile keeps the builder lean.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf \
        --retry 5 --retry-delay 10 --retry-connrefused --retry-all-errors --max-time 60 \
        https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path

# ── Ardour source headers ────────────────────────────────────────
# Even though we apt-installed Ardour binaries above, Debian (like
# upstream Ardour) doesn't ship a `-dev` package — Ardour isn't
# designed as a library. We still need the SOURCE TREE for headers
# the shim + backend include (`ardour/session.h` etc.), and we need
# `waf configure` to generate a handful of config headers
# (`libardour-config.h` etc. — these encode CMake-flag-equivalent
# build-time switches that the headers `#ifdef`-guard on).
#
# Critically we DON'T run `waf build` — that's the 15-min hot
# path. Configure-only takes ~30 s and produces every header we
# need; the actual .so files come from the apt install.
RUN git -c advice.detachedHead=false clone --depth 1 \
        --branch "${ARDOUR_TAG}" \
        https://github.com/Ardour/ardour.git /opt/ardour

WORKDIR /opt/ardour
RUN CXXFLAGS="-Wno-deprecated-declarations" \
    CFLAGS="-Wno-deprecated-declarations" \
    python3 waf configure --optimize --noconfirm

# ── Foyer shim + sidecar + autovocoder ────────────────────────────
WORKDIR /workspace
COPY . /workspace

# Build the shim against the Ardour source tree we just compiled.
RUN cmake -S /workspace/shims/ardour -B /workspace/shims/ardour/cmake-build \
        -DCMAKE_BUILD_TYPE=RelWithDebInfo \
        -DFOYER_ARDOUR_SOURCE=/opt/ardour \
 && cmake --build /workspace/shims/ardour/cmake-build -j"$(nproc)"

# Build the autovocoder LV2 plugin. AUTOVOCODER_REF defaults to
# `master` since the upstream doesn't tag releases yet. The
# install-lv2.sh helper builds + drops the bundle under
# $INSTALL_DIR/autovocoder.lv2/, which we'll copy into the runtime
# image as part of the LV2 plugin pack.
RUN if ! git -c advice.detachedHead=false clone --depth 1 \
            --branch "${AUTOVOCODER_REF}" \
            https://github.com/hotspoons/autovocoder.git /opt/autovocoder; then \
        echo "autovocoder: ref ${AUTOVOCODER_REF} missing; falling back to master"; \
        git clone --depth 1 https://github.com/hotspoons/autovocoder.git /opt/autovocoder; \
    fi \
 && cd /opt/autovocoder \
 && INSTALL_DIR=/opt/lv2 ./scripts/install-lv2.sh

# x42 General MIDI Synth (x42-gmsynth) prebuilt LV2 bundle.
# Stage into /opt/lv2 so runtime gets it via the existing COPY.
RUN case "${TARGETARCH}" in \
      amd64|x86_64) GMSYNTH_ARCH="x86_64" ;; \
      arm64|aarch64) GMSYNTH_ARCH="arm64" ;; \
      *) echo "Unsupported TARGETARCH for x42-gmsynth: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && tmpdir="$(mktemp -d)" \
 && curl -fsSL --retry 5 --retry-delay 10 --retry-connrefused --retry-all-errors --max-time 60 \
      -o "${tmpdir}/gmsynth.tar.gz" \
      "https://x42-plugins.com/x42/linux/x42-gmsynth-v${GMSYNTH_VERSION}-${GMSYNTH_ARCH}.tar.gz" \
 && tar -xzf "${tmpdir}/gmsynth.tar.gz" -C "${tmpdir}" \
 && install -d /opt/lv2 \
 && cp -a "${tmpdir}/x42-gmsynth/gmsynth.lv2" /opt/lv2/ \
 && rm -rf "${tmpdir}"

# Tailwind CSS — must run BEFORE the Rust release build because
# `cargo build --release` bakes the web tree into the binary via
# `include_dir!` (see crates/foyer-cli/build.rs). The output file
# `web/styles/tw.build.css` is gitignored and `.dockerignored`'s sibling
# (rebuilt fresh per build), so without this step the production image
# ships an unstyled UI. tw.sh auto-detects arch and downloads the
# matching tailwindcss standalone binary; works under buildx for
# linux/amd64 and linux/arm64.
RUN /workspace/scripts/dev/tw.sh build

# Build the foyer binary in release mode. `cargo build --release`
# bakes the web tree into the binary via include_dir!, which is the
# canonical ship path (see Justfile run-static).
RUN cargo build --release --manifest-path /workspace/Cargo.toml --bin foyer

# ─────────────────────────────────────────────────────────────────
# Stage 2 — runtime
# ─────────────────────────────────────────────────────────────────
#
# Base: full `debian:trixie` (NOT `-slim`). The image already weighs
# ~5 GB once the LV2 plugin pack lands, so the ~30 MB you save by
# starting from slim is rounding error — and slim drops procps,
# psmisc, lsof, net-tools, less, file, etc., which makes
# `docker exec` debugging genuinely painful (no `pgrep`, no `ps`,
# no `netstat`). With full trixie + the diag pack below the user
# can introspect the live container with the standard set.
FROM debian:trixie AS runtime

# Toggle for the KXStudio PPA + the four packages only it carries
# (aida-x, airwindows-lv2, master-me, kxstudio-meta-audio-plugins-
# collection). Default `1` keeps the full plugin set. Set to `0`
# (CI: `--build-arg WITH_KXSTUDIO=0`) to skip when launchpad is
# unreachable — the resulting image loses ~16 KXStudio-exclusive
# plugins (Dexed, OB-Xd, Geonkick, TAL, AIDA-X, Airwindows,
# Master-Me, …) but everything in Debian trixie still installs.
ARG WITH_KXSTUDIO=1

ENV DEBIAN_FRONTEND=noninteractive

# Diagnostic / shell-comfort pack. Most of these would be in any
# Debian "real install" — full trixie ships some, this RUN
# guarantees the rest. Pulled in as a separate, early layer so
# rebuilds during plugin-pack churn keep this layer cached.
#
#   procps    — pgrep, ps, top, kill, free, uptime
#   psmisc    — pstree, killall, fuser
#   iproute2  — ss, ip (already in full trixie, listed for clarity)
#   lsof      — open-file/socket inspection ("who has :14500?")
#   net-tools — netstat, ifconfig (legacy but still in some muscle memory)
#   less      — pager (man-page reader, log scroll)
#   file      — quick mime-type sniffing on session artifacts
#   vim-tiny  — minimal editor for the inevitable in-container poke
#   htop      — sometimes you just want to watch ardour's RSS climb
RUN apt-get update && apt-get install -y --no-install-recommends \
      procps psmisc iproute2 lsof net-tools \
      # gdb for crash forensics on the Ardour child. With
      # FOYER_DEBUG_ARDOUR=1 the foyer-cli bash launcher wraps
      # Ardour in `gdb --batch --ex run --ex "thread apply all bt full"`
      # so a SIGSEGV / SIGABRT dumps a stack trace into the daw log
      # instead of the silent exit Cloud Run / docker shows otherwise.
      gdb \
      less file vim-tiny htop \
 && rm -rf /var/lib/apt/lists/*

# ── Runtime deps: Ardour .so set + JACK + a stacked plugin pack ───
#
# Plugin sourcing strategy:
#   1. Debian trixie's own LV2 packages cover the core suites
#      (LSP, x42, ZAM, swh, mda, Calf, etc).
#   2. KXStudio's PPA fills the gaps Debian doesn't ship — Dexed,
#      OB-Xd, Geonkick, TAL, Infamous, MOD pedalboard plugins,
#      Klangfalter, Sorcer, Fabla, ArtyFX, etc. KXStudio targets
#      Ubuntu bionic/focal but binaries are built against an older
#      glibc and forward-compat fine on trixie. We pin KXStudio at
#      priority 100 so Debian wins on any name collision (the
#      KXStudio build of `calf-plugins` references `libgdk-pixbuf2.0-0`
#      which trixie renamed to `libgdk-pixbuf-2.0-0`); KXStudio only
#      gets used for packages Debian doesn't carry at all.
#
# Verified install: 88 packages, ~122 MB download, ~378 MB on disk.
# Verification command lives in `scripts/dev/verify-plugins.sh`.

# Stage 1: enable the KXStudio PPA. .deb from upstream ships only
# one of the two signing keys their `Release` files use, and uses
# the deprecated /etc/apt/trusted.gpg.d/ mechanism that Debian 13's
# `sqv` verifier ignores. Workaround: fetch both keys from
# launchpad's keyserver into /usr/share/keyrings/, and write our
# own source files with explicit `[signed-by=...]`.
#
# Both `bionic` and `focal` suites are listed because KXStudio's
# arm64 plugin coverage is split across them — bionic has ~145
# packages including marquee synths (dexed, geonkick, OB-Xd, TAL,
# klangfalter); focal has ~40 *newer* packages (Cardinal, AIDA-X,
# Master-Me, Odin2, Airwindows, fresher LSP/DPF builds). apt picks
# the highest version available across both.
RUN if [ "$WITH_KXSTUDIO" = "0" ]; then \
      echo "[Dockerfile] WITH_KXSTUDIO=0 — skipping KXStudio PPA setup"; \
      exit 0; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends \
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
      'Package: *' \
      'Pin: release o=LP-PPA-kxstudio-debian-libs' \
      'Pin-Priority: 100' '' \
      'Package: *' \
      'Pin: release o=LP-PPA-kxstudio-debian-plugins' \
      'Pin-Priority: 100' '' \
      'Package: *' \
      'Pin: release o=LP-PPA-kxstudio-debian-apps' \
      'Pin-Priority: 100' '' \
      'Package: *' \
      'Pin: release o=LP-PPA-kxstudio-debian-kxstudio' \
      'Pin-Priority: 100' \
      > /etc/apt/preferences.d/kxstudio.pref

# Stage 2: install the runtime libs + plugin pack in one apt-get
# pass. Packages stacked many-per-line to keep the Dockerfile
# scannable; logical groups separated by blank lines. Roughly
# alphabetical inside each group for grep-ability. The KXStudio
# meta-package is the last entry — its `Depends:` pulls in ~12
# plugins (Dexed/DX7, OB-Xd, Geonkick, TAL, Infamous, MOD
# pedalboard, Klangfalter, Sorcer, Fabla, ArtyFX, sherlock.lv2,
# moony.lv2, …) that have no Debian counterpart.
RUN KXSTUDIO_PKGS=""; \
    if [ "$WITH_KXSTUDIO" = "1" ]; then \
      KXSTUDIO_PKGS="aida-x airwindows-lv2 master-me kxstudio-meta-audio-plugins-collection"; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates python3 tini \
      # GTK/Pango/Cairo runtime support that the dev container gets
      # transitively via its `-dev` packages (libgtkmm-2.4-dev pulls
      # in libpango1.0-dev → fontconfig → fonts-dejavu-core; etc.).
      # The runtime image only installs the bare runtime libs, so
      # without these explicit additions Ardour's first dialog with
      # any rendered text dies inside Pango — fontconfig has no
      # actual font files to discover, Pango calls Cairo with a
      # null font face, Cairo aborts. This was the cause of "DAW
      # crashes on plugin add / MIDI region add" in container
      # deploys (works fine in dev because the dev image gets the
      # transitive set). Tested minimum:
      #   fontconfig + fonts-dejavu-core    → text renders
      #   adwaita-icon-theme hicolor-...    → toolbar icons render
      #   gtk2-engines + librsvg2-common    → theme + SVG icons
      #   shared-mime-info gsettings-...    → file-picker mime types
      #   dbus-x11                          → session bus stub for
      #                                        plugins that probe it
      # (Note: libcanberra-gtk-module was dropped from trixie — only
      # the GTK3 variant remains, and Ardour is GTK2. Its absence is
      # cosmetic (no audible button-clicks); harmless unless someone
      # runs with `G_DEBUG=fatal-warnings`, which we don't.)
      fontconfig fonts-dejavu-core fonts-liberation \
      adwaita-icon-theme hicolor-icon-theme gtk2-engines \
      librsvg2-common shared-mime-info gsettings-desktop-schemas \
      dbus-x11 \
      libgtkmm-2.4-1v5 libglibmm-2.4-1v5 libsigc++-2.0-0v5 \
      libxml2 libarchive13 libfftw3-double3 libfftw3-single3 libaubio5 \
      vamp-plugin-sdk liblrdf0 libtag2 liblo7 librubberband2 libreadline8 \
      libcurl4 libusb-1.0-0 libsamplerate0 libpulse0 libdbus-1-3 \
      libserd-0-0 libsord-0-0 liblilv-0-0 libsuil-0-0 libsratom-0-0 \
      libwebsockets19t64 libcwiid1 libasound2t64 libsndfile1 libopus0 \
      \
      libjack-jackd2-0 jackd2 alsa-utils pulseaudio-utils \
      \
      # Xvfb for the GUI-Ardour-on-headless-X path. In non-privileged
      # contexts (Cloud Run gen2, plain `docker run`) JACK can't acquire
      # SCHED_FIFO and the headless `hardour` cascades into a fatal
      # `failed_constructor`. Switching to GUI Ardour painting onto an
      # in-container Xvfb sidesteps that — libardour's "None (Dummy)"
      # backend has a non-RT fallback, and the entrypoint pre-seeds
      # the AMS state so first-run dialogs never block boot. xpra is
      # NOT installed here (it's a dev-only diagnostic for peeking at
      # what the Xvfb is showing); the dev container Dockerfile pulls
      # it from xpra.org's repo separately.
      xvfb \
      \
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
      $KXSTUDIO_PKGS \
 && if [ "$WITH_KXSTUDIO" = "1" ]; then apt-get purge -y gpg dirmngr; fi \
 && apt-get autoremove -y --purge \
 && rm -rf /var/lib/apt/lists/*

# ── xpra (HTML5 X11 server, for native plugin GUI projection) ────
#
# xpra was dropped from Debian trixie's main repos at release time
# (RC bugs in the packaging — fixed upstream but didn't make the
# freeze). xpra.org publishes their own apt repo with current builds
# for trixie, signed by the project maintainer's key. Same source
# the dev container Dockerfile uses; keeps prod and dev at parity.
#
# Without xpra installed: foyer-server's startup probe sets the
# `native_plugin_gui` feature flag to false, which hides the
# "Native GUI" toggle in the plugin panel. Image still boots
# happily; users just lose the native-GUI-projection feature.
RUN apt-get update && apt-get install -y --no-install-recommends \
      gpg ca-certificates curl \
 && curl -fsSL --retry 5 --retry-delay 10 --retry-connrefused --retry-all-errors --max-time 60 \
        https://xpra.org/xpra.asc \
      | gpg --dearmor -o /usr/share/keyrings/xpra-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/xpra-keyring.gpg] https://xpra.org/ trixie main" \
      > /etc/apt/sources.list.d/xpra.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      xpra xpra-x11 xpra-html5 \
 && apt-get purge -y gpg \
 && apt-get autoremove -y --purge \
 && rm -rf /var/lib/apt/lists/*
# `xpra-x11` is the load-bearing piece for the in-container `xpra
# start :NN` path. Modern xpra (≥6) split the package: `xpra` is
# the client + protocol core, and the X11 server modes (`seamless`,
# `desktop`, `shadow`) live in `xpra-x11`. Without it, `xpra start`
# aborts at boot with `you must install 'xpra-x11' to use 'seamless'`
# and the container's xpra never comes up. `xpra-html5` ships the
# JS dist served at /_xpra/.

# A non-root user. Cloud Run rewrites uid/gid for us anyway, but
# running as a real user keeps file ownership predictable when a
# host volume is mounted at `/projects`. Member of `audio` so any
# `/dev/snd/*` passthrough is readable.
RUN groupadd --gid 1000 foyer \
 && useradd --uid 1000 --gid foyer --shell /bin/bash --create-home foyer \
 && usermod -aG audio foyer

# ── Ardour 9.2 from sid ──────────────────────────────────────────
# Same trick as the builder stage: trixie's archive carries Ardour
# 8.12 only; we want 9.2. Pin sid at low priority so its packages
# only get used for what we explicitly request, and pull just
# `ardour` (which Depends on `ardour-data` and `ardour-lv2-plugins`
# by version, so apt cascades both transitively from sid too).
#
# What this gives us:
#   /usr/bin/ardour          — wrapper script (sets LD_LIBRARY_PATH,
#                              GTK_PATH, ARDOUR_DATA_PATH, …) then
#                              exec's the real binary.
#   /usr/lib/ardour9/        — private libs + helper bins +
#                              backends/ + surfaces/ + engines/.
#   /usr/bin/ardour9-*       — session_utils helpers (incl.
#                              ardour9-new_empty_session that
#                              foyer-cli's bash launcher invokes
#                              for new-session bootstrapping).
#
# foyer-cli's executable detection (foyer-config::detect_ardour_executable)
# uses $PATH first, so `/usr/bin/ardour` is picked up automatically.
# `find_new_empty_session_helper` looks for `ardour*-new_empty_session`
# in the same dir as the resolved exec — `/usr/bin/` matches, no
# manual paths to maintain.
RUN echo "deb http://deb.debian.org/debian sid main" > /etc/apt/sources.list.d/sid.list \
 && printf '%s\n' \
      'Package: *' \
      'Pin: release a=unstable' \
      'Pin-Priority: 100' \
      > /etc/apt/preferences.d/sid-pin \
 && apt-get update \
 && apt-get install -y --no-install-recommends -t sid \
      ardour \
 && rm -rf /var/lib/apt/lists/*

# `foyer-config::detect_ardour_executable` searches $PATH first, so
# `/usr/bin/ardour` (apt's wrapper script that sets env vars + execs
# the real binary at /usr/lib/ardour9/ardour-9.2.0~ds) is found
# automatically. `find_new_empty_session_helper` scans the same dir
# as the resolved exec for `ardour*-new_empty_session` — apt installs
# `/usr/bin/ardour9-new_empty_session` so that picker hits cleanly.

# ── Foyer shim + autovocoder + sidecar binary ────────────────────
COPY --from=builder /workspace/shims/ardour/cmake-build/libfoyer_shim.so \
     /opt/foyer/shim/libfoyer_shim.so
COPY --from=builder /workspace/shims/ardour/cmake-build/libfoyer_audiobackend.so \
     /opt/foyer/backends/libfoyer_audiobackend.so
COPY --from=builder /opt/lv2 /opt/lv2
COPY --from=builder /workspace/target/release/foyer /usr/local/bin/foyer

# A fresh image starts with an empty /projects. The
# `.dockerignore` excludes the dev tree's `sessions/` so we don't
# accidentally bake personal projects into a public image. Drop demo
# bundles into `/opt/foyer/sample-sessions/` via a separate COPY (or
# `--build-arg`) when you want preloaded content for visitors.

# Wire the shim onto Ardour's surface search path.
#
# IMPORTANT: install to ONE location only. Ardour's `find_files_matching_pattern`
# does not dedupe across search-path entries (libs/pbd/file_utils.cc), so
# the same .so under two scanned dirs becomes two `ControlProtocolInfo`
# rows with identical `name="Foyer Studio Shim"`. The session XML's
# `<ControlProtocols>` then contains TWO matching `<Protocol>` children;
# our XML preflight flips the first to `active="1"` but the second stays
# `active="0"`, and `ControlProtocolManager::set_state` iterates in order
# (libs/ardour/control_protocol_manager.cc:534) — instantiate-then-teardown
# leaves the shim with no IPC server, no advert, and foyer-cli times out
# at 30 s. The dev `shim.sh` install path (~/.config/ardour9/surfaces/)
# is single-source so this never reproduces locally.
#
# /opt/foyer/surfaces wins over ~/.config/ardour9/surfaces because the
# entrypoint exports ARDOUR_SURFACES_PATH=/opt/foyer/surfaces — works
# regardless of $HOME, which matters when Cloud Run rewrites uid/gid
# and the home dir resolves somewhere other than /home/foyer.
RUN install -D /opt/foyer/shim/libfoyer_shim.so \
      /opt/foyer/surfaces/libfoyer_shim.so

# Project jail root + initial seeding — populated on first boot if
# empty so visitors land on a usable state instead of an empty
# picker.
RUN mkdir -p /projects /home/foyer/.lv2 \
 && cp -a /opt/lv2/. /home/foyer/.lv2/ \
 && chown -R foyer:foyer /projects /home/foyer

COPY scripts/runtime/entrypoint.sh /usr/local/bin/foyer-entrypoint
COPY scripts/runtime/seed-ardour-config.sh /usr/local/bin/foyer-seed-ardour-config
RUN chmod +x /usr/local/bin/foyer-entrypoint /usr/local/bin/foyer-seed-ardour-config

USER foyer
WORKDIR /home/foyer

# Cloud Run injects $PORT; the entrypoint honors it. 3838 is the
# documented default.
#
# `FOYER_ARDOUR_BUILD_ROOT` no longer set — the apt-installed Ardour
# is found via $PATH (foyer-config's detect path #1), so there's no
# build root to point at. The variable still works as an override
# for dev contexts where someone has a sibling source build.
ENV PORT=3838 \
    FOYER_JACK_MODE=embedded \
    FOYER_BACKEND=ardour \
    FOYER_JAIL=/projects \
    FOYER_SAMPLE_RATE=48000 \
    LV2_PATH=/usr/lib/lv2:/home/foyer/.lv2
# 3838 = foyer sidecar (HTTP+WS, the user-facing port).
# 14500 = xpra HTML5 / TCP socket. Foyer's own UI proxies this through
# `/_xpra/*` + `/ws/plugin-gui` on 3838 so the typical `docker run` only
# needs to publish 3838. Publish 14500 too when you want to view the
# whole headless X session in your browser (full Ardour desktop, useful
# for diagnosing stuck plugin GUIs that the foyer-window iframe filter
# might be hiding) — see `docs/USAGE.md` for the troubleshooting recipe.
EXPOSE 3838 14500

# tini reaps zombies + forwards SIGTERM cleanly to the foyer + jackd
# children, which matters when the orchestrator (Cloud Run, Docker
# Compose) sends a stop signal during a deploy.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/foyer-entrypoint"]
