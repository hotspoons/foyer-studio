# `foyer-snapshot`

Reproducible Ardour project packaging — turn a session directory into a
self-contained, runnable OCI image.

## Why?

Music projects bit-rot.  An Ardour session saved in 2024 may fail to open
in 2026 because:

* The distro upgraded `libfftw3` and the old Ardour binary links the
  previous soname.
* A VST vendor pulled the installer from their website.
* A custom LV2 lived in `/home/user/.lv2` on a laptop that died.

`foyer snapshot` freezes the **entire runnable universe** of a project —
the DAW, every plugin, every shared library they depend on, and the
project itself — into a portable OCI image.  `docker run` opens the
session exactly as it sounded on the day it was captured.

## What it captures

1. **DAW layer** — Ardour executable + `ldd` traced libraries.
2. **Plugin layers** — one per LV2/VST2/VST3/LADSPA binary found in the
   session XML, again traced with `ldd`.
3. **Debian metadata** — when a file belongs to an APT package, the
   Dockerfile installs that package instead of copying raw files, so the
   layer cache is reusable across projects.
4. **Wine layer** — if any Windows VST or the DAW needs Wine, the Wine
   runtime and prefix are included.
5. **Project layer** — the session directory + audio sources, with
   mtimes normalised to the Unix epoch for reproducibility.

## Quick start

```bash
# Just emit the build context
foyer snapshot /path/to/MySong.ardour --out-dir ./snapshot

# Build immediately with Docker
foyer snapshot /path/to/MySong.ardour --build --tag mysong:latest

# Save a portable tarball
foyer snapshot /path/to/MySong.ardour --tarball

# Push to a registry
foyer snapshot /path/to/MySong.ardour --build --push --registry ghcr.io/user
```

## Output layout

```
out-dir/
├── Dockerfile              # multi-stage, layer-cached
├── snapshot-plan.json      # machine-readable manifest
├── layer0/ … layerN/       # non-APT plugin trees
└── project/                # the session directory
```

## Design notes

* **No OS bundling.** The base image is the slim Debian/Ubuntu variant
  that matches the host (`debian:trixie-slim` on Debian 13).  We do NOT
  ship a full OS — only the DAW chain and plugins are layered on top.
* **Deterministic mtimes.** Every `COPY` layer is followed by `find …
  touch -t 197001010000` so Docker layer hashes are content-addressable,
  not timestamp-addressable.
* **Cache-friendly stacking.** The DAW is layer 0, each plugin is a
  subsequent layer, and the project is the final layer.  Two projects
  that share the same Ardour version share the base DAW layer.

## Limitations

* Only Debian/Ubuntu hosts today (`dpkg -S` is required for APT
  integration).  RPM / Arch mapping is future work.
* JACK is replaced by Ardour’s Dummy backend inside the container.
  Realtime audio output requires additional `--device` flags on
  `docker run`; the image defaults to offline-safe behaviour.
* Windows and macOS hosts are not supported (the tooling relies on
  `ldd`, ELF parsing, and Debian package metadata).

## License

Apache-2.0 — same as the rest of the Rust workspace.  The Ardour shim
under `shims/ardour/` remains GPL-2.0-or-later and is NOT included in
this crate.
