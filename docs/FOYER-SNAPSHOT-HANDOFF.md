# Handoff: `foyer snapshot` Implementation

**Date:** 2026-05-03
**Last touched:** continuation pass — all five handoff blockers fixed,
plus host-vs-container parity bugs that the previous build couldn't
have caught from `--help` alone.
**Status:** Image builds. `--version` works inside the container.
Ardour reaches GUI init under xvfb and loads its config (the right
config, with Foyer Dummy backend pinned). Final session-load lap is
gated on a couple of GTK-runtime symptoms that smell like a missing
xpra/xkb plumbing layer rather than snapshot bugs — see "What's still
TODO" below.

---

## What shipped this pass

| Handoff blocker | Status | Where |
|---|---|---|
| #1 `dpkg -S` diversion parser | **Fixed** | `parse_dpkg_search` in `crates/foyer-snapshot/src/deps.rs` + 4 unit tests |
| #2 `LD_LIBRARY_PATH` segfault risk | **Fixed (option B)** | `oci::enumerate_base_lib_basenames` + the SONAME-diff filter in `trace_daw` |
| #3 `nm` / `libbfd` warning | **Fixed** | `apt-get install -y binutils` in the base stage |
| #4 `$HOME/.lv2` discovery | **Fixed** | `lv2_search_roots` on `SnapshotPlan` → `LV2_PATH` env in the final stage |
| #5 fontconfig warning | **Fixed** | `apt-get install -y fontconfig` in the base stage |

Beyond the explicit blockers, this pass found and fixed several
issues the previous "Ardour `--help` works" milestone hid:

* **Wrapper script copy was overscoped.** The `daw-wrapper` layer
  copied all of `/usr/bin` (host's), shadowing the base image's `nm`,
  `find`, `apt-get`, etc. with host versions linked against host-only
  libs. Now copies just the wrapper file. (`copy_tree` in
  `oci.rs` learned to handle file-source layers.)
* **`LD_LIBRARY_PATH` lost the binary tree.** Set to
  `/opt/foyer-syslibs` only — fine for ardour through the wrapper,
  but `hardour` (no wrapper) errored out with `libardourcp.so:
  cannot open shared object file`. Now `bin_dir:syslib_dir`.
* **All the wrapper's `export VAR=...` env vars are now baked into
  the container ENV.** `ARDOUR_DATA_PATH`, `ARDOUR_CONFIG_PATH`,
  `ARDOUR_DLL_PATH`, `GTK_PATH` were only set by the wrapper script;
  any process invoking the binary differently (entrypoint override,
  hardour, debugging shell) lost them.
* **User config (`~/.config/ardour9/`) is now a real layer.** Plain
  files (`config`, `instant.xml`, `.a9`) + the `backends/` directory
  go into `/root/.config/ardour9/`. Without this, Ardour boots with
  no audio backend pinned, falls back to JACK, dies. (`.a9` is the
  zero-byte first-run-wizard-already-done marker — without it Ardour
  walks the welcome wizard on every container boot.)
* **`xvfb-run` wraps the entrypoint.** GUI Ardour needs an X server;
  `--server-args="-screen 0 1920x1080x24"` is what the production
  runtime entrypoint uses to keep Ardour's hard-coded "screen too
  small" gate silent. The same gate has an env-var escape hatch
  (`ARDOUR_LOVES_STUPID_TINY_SCREENS=1`) that we also set, both for
  belt-and-braces and because the gate fires before the X resize
  takes effect on slow Xvfb boots.
* **`ARDOUR_BACKEND_PATH=/root/.config/ardour9/backends`** points
  Ardour at the Foyer Dummy backend `.so` that we ship. Otherwise the
  pinned `<EngineState backend="Foyer Dummy">` in `config` resolves
  against the stock backend dir which doesn't have it.
* **Base image gets GTK runtime deps**: `adwaita-icon-theme`,
  `hicolor-icon-theme`, `gsettings-desktop-schemas`, `dbus-x11`,
  `shared-mime-info`, plus `xvfb xauth`. Each one of these surfaced
  as a fatal warning during the boot logs of the previous build.
* **`FOYER_DOCKER` env override.** Both the SONAME-diff probe and
  the build call go through `oci::docker_cmd()`, which honours
  `FOYER_DOCKER="sudo docker"` (or `podman`, etc.). Devcontainers
  commonly need `sudo docker` because the host docker socket is
  root-owned; the previous build either silently fell back to the
  static glibc blocklist or failed `--build`.
* **Clippy hygiene.** The eight `needless_borrows_for_generic_args`
  errors in `deps.rs` that were blocking `just verify` are gone; new
  unit + integration tests respect `items_after_test_module` and
  `doc_overindented_list_items`.

`just verify` is **clean.** Includes both my new tests and the
existing 32 UI specs.

---

## What runs

```bash
# 1. Generate the snapshot plan + Dockerfile (no Docker daemon needed yet).
./target/debug/foyer snapshot sessions/asdf \
    --daw-exec /usr/bin/ardour \
    --out-dir /tmp/foyer-snap \
    --tag asdf-test

# 2. Build the image. FOYER_DOCKER is the escape hatch for sudo-required
#    sockets (devcontainer default).
FOYER_DOCKER="sudo docker" \
    ./target/debug/foyer snapshot sessions/asdf \
    --daw-exec /usr/bin/ardour \
    --out-dir /tmp/foyer-snap --tag asdf-test --build

# 3. Smoke the binary.
sudo docker run --rm asdf-test --version
# → Ardour9.2.0~ds (built using 9.2.0~ds-1 and GCC version 15.2.0)

# 4. Smoke session boot (xvfb-run → GUI ardour → loads /root/.config/ardour9/config).
sudo docker run --rm asdf-test
# → Reaches GUI init, loads system_config + user config, parses
#   bindings, then stalls (see "What's still TODO" below).
```

What you see in `docker logs` from a clean run:

```text
Ardour9.2.0~ds (built using 9.2.0~ds-1 and GCC version 15.2.0)
...
Ardour: [INFO]: Loading user configuration file /root/.config/ardour9/config
Ardour: [INFO]: No H/W specific optimizations in use
Ardour: [INFO]: Set Clip Library directory to '/root/.local/share/sounds/clips'
Ardour: [INFO]: Loading plugin meta data file /usr/share/ardour9/plugin_metadata/plugin_tags
Ardour: [INFO]: add_lrdf_data '/root/.config/ardour9/rdf:/usr/share/ardour9/rdf:...'
Ardour: [ERROR]: ControlProtocolManager: cannot load module ".../libardour_websockets.so"
Ardour: [ERROR]: ControlProtocolManager: cannot load module ".../libardour_wiimote.so"
Ardour: [INFO]: Loading default ui configuration file /etc/ardour9/default_ui_config
Ardour: [INFO]: Loading 470 MIDI patches from /usr/share/ardour9/patchfiles
Ardour: [INFO]: Loading color file /usr/share/ardour9/themes/dark-ardour.colors
Ardour: [INFO]: Loading ui configuration file /etc/ardour9/clearlooks.rc
Ardour: [INFO]: Loading bindings from /etc/ardour9/ardour.keys
Loading ui configuration file /etc/ardour9/clearlooks.rc
[stall here at 90+s]
```

The two `ControlProtocolManager: cannot load module` errors
(`libardour_websockets`, `libardour_wiimote`) are **expected** —
they're optional surface plugins, missing because `libwebsockets.so.19`
and `libcwiid.so.1` aren't ldd-discovered through the main binary so
they don't make it into `/opt/foyer-syslibs`. They don't block boot.

---

## What's still TODO

### 1. GUI Ardour stall after `Loading bindings from .../ardour.keys`

Ardour's main thread enters Gtk after this log line. With xvfb
backing it, the next phase (window creation → engine autostart →
session load) doesn't progress. Working hypotheses, in priority
order:

* **xkbcommon + keyboard layout.** Ardour uses Gtk2's keyboard
  bindings; missing `xkb-data` or a default layout under Xvfb can
  cause a silent hang on the first real keypress dispatch. Try
  adding `xkb-data x11-xkb-utils` to the base apt-install and
  passing `-keybd evdev` or `-keybd kbd` to xvfb.
* **dbus session bus not running.** I added `dbus-x11` but the
  entrypoint doesn't `dbus-launch` the user session bus. Ardour 9.2
  uses GIO/GDBus for the recent-files menu; without a session bus,
  some calls block waiting for the bus to come up. Wrap the
  entrypoint with `dbus-run-session` (or have xvfb-run do it via
  `--auto-servernum --listen-tcp`).
* **Splash screen modal not actually skipped.** Even with
  `--no-splash` Ardour 9.2 sometimes shows a tiny "loading session…"
  dialog the moment a session path is on argv. With xvfb that dialog
  appears but never gets focus / events. Try invoking ardour without
  the session arg first to confirm the GUI itself paints, then add
  the session arg.
* **Plugin scan deadlock.** Ardour scans LV2 + LADSPA on first run.
  With our `LV2_PATH` pointing at `/home/vscode/.lv2` (which contains
  exactly one bundle) plus the standard dirs (which the base image
  doesn't populate), the scan should be a noop — but if `lilv`
  fails to walk the directory it can sit on a futex. Add a `-d`
  (`--disable-plugins`) check to the entrypoint and confirm boot
  proceeds.

The right way to debug this is `strace -f -e trace=futex,read,poll
-p $(pgrep ardour)` from inside the container, but `strace` isn't in
the slim base. Easiest unstick: add `procps strace` to the
**diagnostic** apt-install (gated on a `--debug` flag), then attach.

The infrastructure side is correct — the `Loading user configuration
file /root/.config/ardour9/config` line proves the right config is
being read, and `ldd` of the Foyer Dummy backend `.so` resolves all
symbols cleanly inside the container with the SONAME-diff filter
applied. So this is "Ardour boots into headless-X plumbing it
doesn't quite like" not "snapshot tool is missing files."

### 2. Make headless-CI integration test actually drive Ardour

`tests/integration.rs` has two cases: an always-on Dockerfile
contract test, and an opt-in `FOYER_SNAPSHOT_DOCKER_TEST=1`
docker-build smoke. The opt-in case stops at `--version` because the
session-load stall above isn't deterministic enough yet. Once #1 is
nailed down, extend it to:
- `docker run --rm IMG` (default CMD = load session)
- assert "Loading session: /workspaces/.../asdf" appears in logs
- assert `Ardour: [INFO]:` lines stop changing (session settled)

### 3. `gmsynth` is unresolved on the host

The asdf session references `http://gareus.org/oss/lv2/gmsynth`
which isn't installed locally. Snapshot correctly flags this as
`MISSING` and bakes a comment into the Dockerfile. Once you have a
host with `gmsynth-lv2` (apt: `x42-gmsynth`?), re-snapshotting will
pick it up automatically — no code change needed.

### 4. Optional control surfaces aren't traced

`libwebsockets.so.19` and `libcwiid.so.1` are dlopened by Ardour at
runtime (not linked) so `ldd /usr/lib/ardour9/ardour-9.2.0~ds`
doesn't see them. Two options:
- ldd each `/usr/lib/ardour9/surfaces/*.so` after the main DAW trace
  and union the discovered libs into the syslib stage.
- Or just `apt-get install` `libwebsockets19t64 libcwiid1` in the
  base stage. Cleaner — it's two lines.

These don't block session loading; the surfaces are optional and
the manager logs the failure and moves on. Worth fixing for log
hygiene though.

---

## Files touched this pass

```
crates/foyer-snapshot/src/deps.rs        (dpkg parser, SONAME filter,
                                          wrapper-only copy, ENV vars,
                                          user-config layer)
crates/foyer-snapshot/src/oci.rs         (FOYER_DOCKER, base-lib
                                          enumeration, xvfb entrypoint,
                                          extra apt deps, file-source
                                          COPY handling)
crates/foyer-snapshot/src/lib.rs         (lv2_search_roots, runtime_env
                                          for xvfb-tiny-screens +
                                          backend path, base-libs
                                          plumbing)
crates/foyer-snapshot/tests/integration.rs   NEW
docs/FOYER-SNAPSHOT-HANDOFF.md           (this file)
```

---

*Plan-JSON inspection (`cat /tmp/foyer-snap/snapshot-plan.json`) is
the fastest way to diff what changed across snapshot runs — every
layer + env-var decision lives there.*
