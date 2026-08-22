# Flatpak real-hardware test checklist

First-run validation of the flatpak bundle on a physical Linux
machine — the browserless (`foyer-desktop`) path with the bundled
Ardour. Companion to the manifest
([ai.patapsco.FoyerStudio.yml](ai.patapsco.FoyerStudio.yml)) and
DECISION 56/57.

## Preconditions

- x86_64 Linux desktop with **PipeWire** running (any mainstream
  2024+ distro; `systemctl --user status pipewire` to confirm).
- `flatpak` ≥ 1.14 and the Flathub remote:
  `flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo`
- A bundle cut from a main commit **at or after** the
  adjacent-shim / `desktop.listen` fixes (2026-08-22) — check the
  `flatpak-latest` release notes for the SHA before downloading:
  <https://github.com/hotspoons/foyer-studio/releases/tag/flatpak-latest>

## Install

```bash
curl -LO https://github.com/hotspoons/foyer-studio/releases/download/flatpak-latest/ai.patapsco.FoyerStudio.flatpak
flatpak install --user ai.patapsco.FoyerStudio.flatpak   # first time pulls the GNOME 50 runtime (~500 MB)
```

## Test matrix

Run from a terminal so foyer/foyer-desktop logs are visible:

```bash
flatpak run ai.patapsco.FoyerStudio
```

| # | Step | Expected |
|---|------|----------|
| 1 | Bare launch | Foyer Studio window (1440×900) opens; web UI paints (no white screen). No mode picker — flatpak goes straight to host mode. |
| 2 | Create a session from the launcher | Ardour's own GTK window appears alongside Foyer's. **First run only:** Ardour's Audio/MIDI Setup dialog — pick *JACK* (PipeWire's) or *ALSA*, start. |
| 3 | Session opens | Foyer UI switches from launcher to the session; transport bar live; play/stop from Foyer moves Ardour's playhead. |
| 4 | Ardour → Edit → Preferences → Control Surfaces | Exactly **one** "Foyer Studio Shim" row, enabled. (Two rows = DECISION 57 regression.) |
| 5 | Audio | Add an audio track, arm, record a few seconds from a real input, play back. Watch for xruns at default buffer size. |
| 6 | MIDI hardware (if present) | Controller shows up; notes reach a MIDI track (`--device=all` passthrough). |
| 7 | Plugins | `flatpak install org.freedesktop.LinuxAudio.Plugins.LSP` → relaunch → LSP plugins listed in Foyer's plugin browser (extension-point `LV2_PATH` wiring). |
| 8 | Remote client | Edit `~/.var/app/ai.patapsco.FoyerStudio/config/foyer/config.yaml`: under `desktop:` add `listen: 0.0.0.0:3838`. Relaunch, then point a phone browser at `http://<machine-ip>:3838/` — same session, RBAC applies. |
| 9 | Shutdown | Close the Foyer window → `foyer` + Ardour exit within ~5 s. `pgrep -af 'foyer|ardour'` on the host shows nothing from the sandbox. |
| 10 | Relaunch | No AMS dialog (engine state persisted); launcher's Recents lists the session from step 2. |
| 11 | Crash recovery | `kill -9` the Ardour PID mid-session → Foyer surfaces the crash/orphan flow; reopening the session recovers or discards cleanly. |

## Where things live inside the sandbox

| What | Path |
|------|------|
| Foyer config | `~/.var/app/ai.patapsco.FoyerStudio/config/foyer/config.yaml` |
| Ardour user config | `~/.var/app/ai.patapsco.FoyerStudio/config/ardour9/` |
| DAW log (Ardour stdout/stderr) | `~/.var/app/ai.patapsco.FoyerStudio/.local/state/foyer/daw.log` |
| Extracted web tree | `~/.var/app/ai.patapsco.FoyerStudio/data/foyer/web/` |
| Shell inside the sandbox | `flatpak run --command=sh ai.patapsco.FoyerStudio` |

## Troubleshooting

- **White window, DOM present** — right-click → Inspect Element
  (devtools are compiled in). Known webkit2gtk foreign-window
  failure modes are documented in
  [crates/foyer-desktop/src/main.rs](../../crates/foyer-desktop/src/main.rs)
  (`build_gtk` rationale); a GNOME-50-runtime regression would be
  new information.
- **"Cannot create Audio/MIDI engine"** — host PipeWire socket
  missing from the sandbox: `ls $XDG_RUNTIME_DIR/pipewire-0` on the
  host, and `flatpak info --show-permissions ai.patapsco.FoyerStudio`
  should list `xdg-run/pipewire-0`. ALSA backend is the fallback.
- **Shim discovery timeout** (90 s) — read `daw.log` (path above);
  the session XML's `<Protocol name="Foyer Studio Shim">` entry and
  the surfaces scan log lines tell you which side failed.
- **Verbose server logs** —
  `flatpak run --env=RUST_LOG=foyer_server=debug,foyer=debug ai.patapsco.FoyerStudio`

## Results log

| Date | SHA | Machine / distro | Steps passing | Notes |
|------|-----|------------------|---------------|-------|
| _fill on first run_ | | | | |
