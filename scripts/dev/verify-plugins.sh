#!/usr/bin/env bash
# Verify the LV2 plugin pack the production Dockerfile installs
# resolves cleanly on Debian trixie (no broken deps, no GPG
# failures, no time64-rename issues). Runs against the host's apt
# config but writes its source-list + key files into a tempdir so
# /etc/apt is never touched.
#
# Usage:
#   ./scripts/dev/verify-plugins.sh                # full simulate
#   ./scripts/dev/verify-plugins.sh --resolve-only # skip simulate, just confirm key+repo work
#
# Exit code is the apt-get --simulate exit code; any package that
# fails to resolve will trip the script.
#
# Bumping the package list: keep this script, the Dockerfile, and
# the agent-discovered list in lockstep. Run this script first;
# only commit the Dockerfile change once the script reports
# success.
set -euo pipefail

mode="${1:---full}"

apt_root=$(mktemp -d -t foyer-plugins-verify.XXXXXX)
trap 'sudo rm -rf "$apt_root"' EXIT
mkdir -p "$apt_root"/{lists/partial,sources,keys,preferences.d}
# apt drops privileges to the `_apt` user when fetching repository
# Indexes, then writes them into Dir::State::Lists. Without the
# right ownership it logs a "Permission denied" warning and falls
# back to running unsandboxed as root — but on some apt builds the
# fall-back doesn't happen and the index download silently fails,
# leaving us with only the KXStudio repos visible. Make the lists
# dir _apt-writable so the sandboxed download just works.
if id _apt >/dev/null 2>&1; then
  # _apt's group is `nogroup`, not `_apt`. Use the user only.
  sudo chown -R _apt "$apt_root/lists"
fi

# Bring in the host's Debian sources so apt sees trixie main +
# security alongside KXStudio. Debian's sources file uses absolute
# `Signed-By:` paths into /usr/share/keyrings/, so the sources
# file is self-contained — no need to copy keyrings. (And on
# trixie /etc/apt/trusted.gpg.d/ holds ASCII-armored .asc files,
# not .gpg, so a naive `*.gpg` glob misses everything.)
shopt -s nullglob
src_files=(/etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list)
shopt -u nullglob
if [ "${#src_files[@]}" -gt 0 ]; then
  cp -L "${src_files[@]}" "$apt_root/sources/"
fi

# Fetch BOTH KXStudio signing keys from launchpad's keyserver into
# a single keyring. The .deb upstream ships only one of the two,
# which is why this is its own step.
curl -fsSL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x89195BA21C5CE3C72BAC1C0A0C955638F15F1FDC" \
  | gpg --dearmor -o "$apt_root/keys/kxstudio-archive-keyring.gpg"
curl -fsSL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0xDF1BC724E4ED8A947FF0B0A1F8599E482BD84BD9" \
  | gpg --dearmor >> "$apt_root/keys/kxstudio-archive-keyring.gpg"

KEY="$apt_root/keys/kxstudio-archive-keyring.gpg"
{
  for suite in bionic focal; do
    for repo in plugins libs apps kxstudio; do
      echo "deb [signed-by=$KEY] http://ppa.launchpad.net/kxstudio-debian/$repo/ubuntu $suite main"
    done
  done
} > "$apt_root/sources/kxstudio.list"

cat > "$apt_root/preferences.d/kxstudio.pref" <<EOF
Package: *
Pin: release o=LP-PPA-kxstudio-debian-libs
Pin-Priority: 100

Package: *
Pin: release o=LP-PPA-kxstudio-debian-plugins
Pin-Priority: 100

Package: *
Pin: release o=LP-PPA-kxstudio-debian-apps
Pin-Priority: 100

Package: *
Pin: release o=LP-PPA-kxstudio-debian-kxstudio
Pin-Priority: 100
EOF

apt_call() {
  sudo apt-get \
    -o Dir::State::Lists="$apt_root/lists" \
    -o Dir::Etc::sourcelist=/dev/null \
    -o Dir::Etc::sourceparts="$apt_root/sources" \
    -o Dir::Etc::trusted.gpg.d="$apt_root/keys" \
    -o Dir::Etc::preferencesparts="$apt_root/preferences.d" \
    "$@"
}

echo "==> apt-get update (transient sources)"
apt_call update >/dev/null

if [ "$mode" = "--resolve-only" ]; then
  echo "==> resolve-only: KXStudio repos visible + signed."
  exit 0
fi

# Same package list as the production Dockerfile. Keep in sync —
# any divergence between this list and the Dockerfile means the
# verification result doesn't reflect what a real build does.
PACKAGES=(
  ca-certificates python3 tini
  libgtkmm-2.4-1v5 libglibmm-2.4-1v5 libsigc++-2.0-0v5
  libxml2 libarchive13 libfftw3-double3 libfftw3-single3 libaubio5
  vamp-plugin-sdk liblrdf0 libtag2 liblo7 librubberband2 libreadline8
  libcurl4 libusb-1.0-0 libsamplerate0 libpulse0 libdbus-1-3
  libserd-0-0 libsord-0-0 liblilv-0-0 libsuil-0-0 libsratom-0-0
  libwebsockets19t64 libcwiid1 libasound2t64 libsndfile1 libopus0

  libjack-jackd2-0 jackd2 alsa-utils pulseaudio-utils

  ardour-lv2-plugins
  fluid-soundfont-gm fluid-soundfont-gs fluidr3mono-gm-soundfont
  timgm6mb-soundfont fluidsynth qsynth

  calf-plugins dpf-plugins-lv2 dragonfly-reverb-lv2
  lsp-plugins-lv2 mda-lv2 swh-lv2 x42-plugins zam-plugins
  tap-plugins caps fil-plugins cmt fomp abgate
  blop-lv2 invada-studio-plugins-lv2 eq10q bankstown-lv2 lv2vocoder
  mcp-plugins vco-plugins wah-plugins ir.lv2 rubberband-lv2
  zita-rev1 zita-at1 zita-bls1 zita-mu1

  avldrums.lv2 avldrums.lv2-soundfont
  drumkv1-lv2 padthv1-lv2 samplv1-lv2 synthv1-lv2
  so-synth-lv2 xsynth-dssi setbfree
  yoshimi yoshimi-data amsynth whysynth
  hydrogen hydrogen-data drumgizmo guitarix-lv2

  aida-x airwindows-lv2 master-me
  kxstudio-meta-audio-plugins-collection
)

echo "==> simulating install of ${#PACKAGES[@]} top-level packages"
# Capture exit code without tripping `set -e` — a non-zero from
# apt's simulate is the very thing we want to surface to the user.
sim_rc=0
apt_call install --simulate -y --no-install-recommends "${PACKAGES[@]}" \
  > "$apt_root/sim.log" 2>&1 || sim_rc=$?
if [ "$sim_rc" -ne 0 ]; then
  echo "::error::apt-get --simulate exited $sim_rc — last 30 lines:"
  tail -n 30 "$apt_root/sim.log"
  exit "$sim_rc"
fi
inst=$(grep -c '^Inst ' "$apt_root/sim.log" || true)
echo "==> would install $inst packages total"

echo "==> sampling marquee KXStudio plugins"
for p in dexed-lv2 obxd-lv2 geonkick tal-plugins-lv2 infamous-plugins fabla artyfx sorcer klangfalter-lv2; do
  if grep -q "^Inst $p " "$apt_root/sim.log"; then
    echo "    ✓ $p"
  else
    echo "    ✗ $p (NOT in simulated install)"
    exit 1
  fi
done

echo "==> capturing size estimate"
apt_call -d -y --no-install-recommends install "${PACKAGES[@]}" 2>&1 \
  | grep -E '(After|Need to)' | sed 's/^/    /'

echo "==> OK"
