# Handoff — fix Foyer Studio shim load on macOS Ardour9

You're picking up a partially-debugged macOS-only blocker. Branch the dev container left this on: `main` (latest changes are committed). The Linux-side dev container can build + test the Rust sidecar fine, but the shim → Ardour load path is fundamentally a macOS problem and the dev container has no Mac to test against. That's why this is on your plate now.

## TL;DR

**Goal:** Foyer Studio Shim should appear in Ardour's `Edit → Preferences → Control Surfaces` list on macOS (currently only the built-in surfaces show up — Mackie, OSC, etc.).

**Current state on the user's Mac:**
- `Ardour9.app` is installed at `/Applications/Ardour9.app`, version 9.2.0.
- Foyer installed via `install.sh --latest-ci` from `main`.
- Foyer surface is **NOT** loading.
- Ardour was crashing on startup at one point with `Namespace CODESIGNING, Code 2, Invalid Page` after a `codesign --force --deep --sign -` we ran on the bundle. May or may not still be crashing — confirm before doing anything else (see "First-thing checks" below).

**What we know is wrong:**
1. **Absolute paths in the shim's load commands.** The CI-built dylib has `/Users/runner/work/foyer-studio/foyer-studio/ext/ardour/build/libs/ardour/libardour.dylib` (and similar) baked into its `LC_LOAD_DYLIB` entries. dyld follows that literal path on the user's Mac, fails, kills the load. **CI is now patched** to rewrite these to `@executable_path/../lib/<name>` post-build via `install_name_tool` ([.github/workflows/ci.yml](../.github/workflows/ci.yml) — search for "Fix dylib paths"), but the user is testing against an OLD CI build that predates the fix. Either rebuild + push to trigger CI and reinstall, OR fix the user's already-installed dylib in place.

2. **`codesign --deep` corrupts page hashes.** When we tried to re-sign Ardour with `--deep` after dropping our shim into the bundle, it left some of Ardour's own bundled dylibs (e.g. `libardour_faderport16.dylib`) with mismatched page hashes — Ardour SIGKILL'd on next launch with a code-signature page error. **Install script has been switched** to per-file ad-hoc signing instead of `--deep` ([install.sh](../install.sh) — search for "Don't use \\\`codesign --deep\\\`").

## Repo layout (you probably need)

- `install.sh` — the macOS install path. Detects `/Applications/Ardour9.app`; if present, drops the dylib into `Contents/lib/surfaces/`, ad-hoc signs it, and re-signs Ardour9's main executable. Falls back to `~/Library/Preferences/Ardour9/surfaces/` if Ardour isn't installed.
- `.github/workflows/ci.yml` — CI build for the shim. The macOS job has a "Fix dylib paths + ad-hoc sign (macOS)" step that rewrites runner-baked absolute paths to `@executable_path/../lib/...` and ad-hoc signs the dylib.
- `shims/ardour/` — the shim source. CMake build. Built against `ext/ardour/` (cloned at `ARDOUR_TAG` — currently `9.2`) on the runner. **The build itself is fine; the issue is purely about how the resulting dylib references its dependencies on the runner's filesystem.**
- `crates/foyer-cli/src/main.rs` — Rust sidecar entry. Doesn't matter for this bug, but `foyer serve` is the binary the user runs to start the sidecar that talks to the shim.

## First-thing checks

Run these before trying anything else, so you know what state the user's Mac is actually in:

```bash
# 1. Is Ardour itself launchable?
codesign --verify --verbose=2 /Applications/Ardour9.app 2>&1 | head -20
# If this errors with "invalid signature" / "code object is not signed at all"
# / "page hash mismatch" — Ardour's bundle is corrupted by our earlier --deep
# attempts. Repair OR reinstall Ardour from the .dmg before doing anything else.

# 2. Is the foyer shim currently in the bundle?
ls -la /Applications/Ardour9.app/Contents/lib/surfaces/libfoyer_shim.dylib 2>/dev/null
ls -la "$HOME/Library/Preferences/Ardour9/surfaces/libfoyer_shim.dylib" 2>/dev/null

# 3. If it IS, what does its dependency graph look like?
otool -L /Applications/Ardour9.app/Contents/lib/surfaces/libfoyer_shim.dylib 2>/dev/null
otool -L "$HOME/Library/Preferences/Ardour9/surfaces/libfoyer_shim.dylib" 2>/dev/null
# Anything starting with /Users/runner/... is broken and needs install_name_tool
# rewriting. The fix per dep is:
#   install_name_tool -change <runner-abs-path> @executable_path/../lib/<basename> <shim>

# 4. Confirm dyld actually loads the shim before Ardour even sees it:
python3 -c "
import ctypes
try:
    ctypes.CDLL('/Applications/Ardour9.app/Contents/lib/surfaces/libfoyer_shim.dylib')
    print('LOADED OK')
except OSError as e:
    print('DYLD ERROR:', e)
"
# This bypasses Ardour entirely. If this prints LOADED OK, the dylib is fine
# and any remaining issue is in Ardour's protocol_descriptor() handling.

# 5. Ardour's own stderr (bundled apps redirect stdio here):
tail -200 "$HOME/Library/Preferences/Ardour9/stderr.log"

# 6. Most recent Ardour crash report (if any):
ls -lt ~/Library/Logs/DiagnosticReports/Ardour9-* 2>/dev/null | head -3
```

## Repair Ardour if `codesign --verify` failed

The user's earlier `--deep` attempt may have left the bundle unverifiable. Two repair paths in order of escalation:

```bash
# Path A: per-file ad-hoc resign of every Mach-O in the bundle. Don't use --deep.
sudo find /Applications/Ardour9.app \
  \( -type f -name "*.dylib" -o -type f -name "*.so" \) \
  -exec codesign --force --sign - {} \;
sudo codesign --force --sign - /Applications/Ardour9.app/Contents/MacOS/Ardour9
sudo codesign --force --sign - /Applications/Ardour9.app
sudo codesign --verify --verbose=2 /Applications/Ardour9.app

# Path B: nuke and reinstall from the official .dmg.
# https://ardour.org/download.html — "I am a subscriber" flow gives the .dmg.
# Then run install.sh again (the latest version handles signing correctly).
```

After repair, **launch Ardour with NO foyer shim installed** to confirm it boots clean. THEN install the shim.

## Install the shim correctly

Once Ardour itself is healthy:

```bash
# 1. Get a fresh shim. Two options:
#    (a) Wait for the next CI run on `main` to complete (the workflow now
#        includes the install_name_tool rewrite). Then:
#          curl -fsSL https://raw.githubusercontent.com/hotspoons/foyer-studio/main/install.sh \
#            | bash -s -- --latest-ci
#    (b) Use the existing CI build but fix the paths manually:
#          (already-installed shim flow — see step 2)

# 2. If using the existing CI build, install + fix paths manually:
SHIM_SRC="$HOME/Library/Preferences/Ardour9/surfaces/libfoyer_shim.dylib"
SHIM_DST=/Applications/Ardour9.app/Contents/lib/surfaces/libfoyer_shim.dylib

sudo cp "$SHIM_SRC" "$SHIM_DST"

# Rewrite every /Users/runner/... reference to @executable_path/../lib/<name>
otool -L "$SHIM_DST" | awk '/\/Users\/runner/ {print $1}' | while read -r dep; do
    name=$(basename "$dep")
    sudo install_name_tool -change "$dep" "@executable_path/../lib/$name" "$SHIM_DST"
done

# Verify nothing's left pointing at the runner:
otool -L "$SHIM_DST" | grep "/Users/runner" && echo "STILL BROKEN" || echo "paths look clean"

# Ad-hoc sign the rewritten shim:
sudo codesign --force --sign - "$SHIM_DST"

# Re-sign Ardour9's main executable so library validation accepts the
# (now ad-hoc) dylib. DO NOT use --deep here — it corrupts page hashes
# on already-signed bundled dylibs.
sudo codesign --force --sign - /Applications/Ardour9.app/Contents/MacOS/Ardour9

# 3. Truncate stderr + relaunch:
osascript -e 'tell application "Ardour9" to quit' 2>/dev/null
sleep 2
: > "$HOME/Library/Preferences/Ardour9/stderr.log"
open -a Ardour9

# 4. Wait ~10s, check the surfaces list AND the stderr:
grep -iE "foyer|cannot load|protocol.*not found" "$HOME/Library/Preferences/Ardour9/stderr.log"
```

If "Foyer Studio Shim" appears in `Edit → Preferences → Control Surfaces`, tick its `Enable` box. The shim then advertises a Unix socket at `/tmp/foyer/ardour-<pid>.sock` and the foyer sidecar can attach.

## What the working state looks like

After a successful install, every one of these should hold:

```bash
# Shim is at the bundle path:
ls -la /Applications/Ardour9.app/Contents/lib/surfaces/libfoyer_shim.dylib
# -rwxr-xr-x@ 1 root admin <size> ...

# All deps resolve via @executable_path:
otool -L /Applications/Ardour9.app/Contents/lib/surfaces/libfoyer_shim.dylib | grep -v "^/" | head
# Shows lines like "@executable_path/../lib/libardour.dylib (compatibility ...)"

# Shim has an ad-hoc signature:
codesign -dv /Applications/Ardour9.app/Contents/lib/surfaces/libfoyer_shim.dylib 2>&1 | grep -E "Signature|flags"
# Signature=adhoc

# Ardour's bundle still verifies:
codesign --verify --verbose=2 /Applications/Ardour9.app 2>&1 | tail -3
# (no errors)

# python ctypes can dlopen it standalone:
python3 -c "
import ctypes, sys
try:
    ctypes.CDLL('/Applications/Ardour9.app/Contents/lib/surfaces/libfoyer_shim.dylib')
    print('OK')
except OSError as e:
    print('FAIL:', e); sys.exit(1)
"
# OK

# After Ardour launch, surface enumerated:
grep -i "foyer studio shim" "$HOME/Library/Preferences/Ardour9/stderr.log"
# (might be empty — Ardour doesn't log discovery in non-debug mode)

# In Ardour: Edit → Preferences → Control Surfaces lists "Foyer Studio Shim".
# Tick Enable.

# Shim socket appears:
ls /tmp/foyer/ardour-*.sock
```

## If you find something deeper

The most likely failure modes left:

1. **Symbol mismatch** — the shim was built against ARDOUR_TAG=9.2 from CI. If the user's Ardour is a slightly different patch (rare on stable releases, but possible), some `_ZN6ARDOUR…` symbol lookup might fail at load time. Look for `Symbol not found:` in stderr or in a fresh crash report.

2. **The shim's `install_name`** (its `LC_ID_DYLIB`) might still embed the runner path. Check:
   ```bash
   otool -D /Applications/Ardour9.app/Contents/lib/surfaces/libfoyer_shim.dylib
   ```
   If that prints a `/Users/runner/...` line, also rewrite that:
   ```bash
   sudo install_name_tool -id @loader_path/libfoyer_shim.dylib \
       /Applications/Ardour9.app/Contents/lib/surfaces/libfoyer_shim.dylib
   sudo codesign --force --sign - /Applications/Ardour9.app/Contents/lib/surfaces/libfoyer_shim.dylib
   ```
   Then update `.github/workflows/ci.yml` to do the same rewrite (mirror the existing `install_name_tool -change` block).

3. **CMake build flags** — the right long-term fix is to set the install_names properly at build time so post-build rewriting isn't needed. `shims/ardour/CMakeLists.txt` currently doesn't set `BUILD_RPATH` / `INSTALL_RPATH` / `INSTALL_NAME_DIR`. If you want to do this right, set:
   ```cmake
   set_target_properties(foyer_shim PROPERTIES
     INSTALL_NAME_DIR "@loader_path"
     BUILD_WITH_INSTALL_NAME_DIR ON
     BUILD_WITH_INSTALL_RPATH ON
   )
   ```
   And for each `target_link_libraries` call against an Ardour library, ensure the linker uses a relative install_name. May need to wrap with `-Wl,-install_name,@executable_path/../lib/libardour.dylib` or rewrite each Ardour lib's install_name pre-link.

## Hand back when

- Foyer Studio Shim shows up in Edit → Preferences → Control Surfaces, AND
- Ticking Enable doesn't crash Ardour, AND
- After running `foyer serve --backend ardour` the sidecar attaches (look for `connected to advertised shim at /tmp/foyer/ardour-<pid>.sock` in foyer's log).

If you fix the build-time issue properly (CMake install_name flags), drop the `install_name_tool` step from `.github/workflows/ci.yml` and `install.sh` since they'd then be redundant. Otherwise leave both — they're insurance in depth.

Push your fix straight to `main` (the user is running directly off CI builds, so a green CI run on main + an `install.sh --latest-ci` on the user's Mac is the validation path).
