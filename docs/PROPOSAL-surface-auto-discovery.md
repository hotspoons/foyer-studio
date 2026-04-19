# Proposal: Auto-discoverable Control Surface Plugins for Ardour

**Status:** draft for upstream discussion
**Author:** Foyer Studio contributors
**Target:** Ardour core maintainers
**Related files:** `libs/surfaces/wscript`, `libs/surfaces/control_protocol/`

## 1. Current state (and how Foyer ships today)

Foyer Studio registers its control surface shim (`libfoyer_shim.so`) by
**patching Ardour's build tree** — specifically `libs/surfaces/wscript`:

```python
# diff against upstream libs/surfaces/wscript
 def configure(conf):
     children += [ 'websockets' ]
     children += [ 'mcp_http' ]

+    import os
+    if os.path.isdir(os.path.join(conf.path.abspath(), 'foyer_shim')):
+        children += [ 'foyer_shim' ]
+
     for i in children:
         conf.recurse(i)
```

To bring up a new surface, a third-party author must:

1. Fork or patch Ardour's source tree.
2. Symlink their surface directory into `libs/surfaces/`.
3. Patch `libs/surfaces/wscript` to register it (the snippet above is our
   guess-of-least-intrusion; upstream still has to accept it, or the author
   maintains a private branch).
4. Rebuild Ardour from source.
5. Distribute either a patched Ardour or rely on the user to repeat the
   above.

There is no stable, out-of-tree extension path. Every control surface that
ships with Ardour (Mackie, OSC, Faderport, Generic MIDI, Web Surfaces,
websockets, mcp_http) lives inside `libs/surfaces/` and is registered by
hand in the same `wscript`.

## 2. Why this hurts the ecosystem

- **Fork tax.** Anyone building a non-upstream surface (Foyer; hypothetical
  vendor-specific controllers; experimental remote-control workflows) has
  to maintain a downstream Ardour fork or an invasive patch set. That's
  also a GPL licensing cliff — the patched Ardour is a derivative work,
  the surface directory living inside it is strongly implicated.
- **Release fragility.** Every Ardour minor version bumps header layouts
  and lib ordering; a third-party surface must re-validate its build
  against every release. Users can't just `apt install` Ardour and
  separately install a surface.
- **Gatekeeping.** New surfaces must clear upstream review to ever reach
  a mainline Ardour user. Experimentation is expensive.
- **Commercial friction.** A vendor who wants to ship a paid control
  surface (studio manufacturer, collaborative-session service, etc.)
  cannot today do so without distributing a modified Ardour build, which
  a GPL application explicitly allows but which is operationally painful
  — updates, signatures, CI, user expectations.

Compare: LV2 plugins, JACK applications, gstreamer elements, vim/nvim
plugins, VSCode extensions — all have first-class out-of-tree loading.
Ardour's control surface system has all the right primitives
(`ControlProtocol` base class, descriptor pattern, `dlopen` loader) but no
install-time discovery story.

## 3. Proposal

Add an **auto-discovery** path for surfaces that lives outside Ardour's
build tree and doesn't require editing any committed file.

### 3.1 Load path expansion (minimal change)

Ardour already uses `ARDOUR_SURFACES_PATH` at runtime (see
`libs/surfaces/control_protocol/control_protocol_manager.cc` — it `dlopen`s
every `.so` on that colon-separated list). Today the build tree populates
it from `build/libs/surfaces/*/`. The minimal proposal is just:

> **Document `ARDOUR_SURFACES_PATH` as a stable extension point,** and
> ensure the `ControlProtocolDescriptor`-based discovery finds every
> shared object on that path, regardless of where it was built.

That's already true in practice. The gap is that there is no
documented, stable *compile-time contract* for what a third party can
build against.

### 3.2 Installed headers for the surface ABI

Today, to compile a control surface you need Ardour's in-tree headers.
There is no `pkg-config --cflags ardour-surface` because there's no
published "Ardour control-surface development" package.

**Proposal:** define a stable subset of headers required to implement a
`ControlProtocol` and install them as `ardour-surface-dev`:

- `ardour/control_protocol.h`
- `ardour/session.h` (interface-only subset)
- `ardour/route.h`, `track.h`, `stripable.h`
- `ardour/plugin_insert.h`, `plugin.h`, `parameter_descriptor.h`
- `pbd/controllable.h`, `pbd/signals.h`, `pbd/id.h`
- `temporal/tempo.h`, `temporal/timeline.h`
- `evoral/Parameter.h`

Ship a `.pc` file (`ardour-surface.pc`) so out-of-tree builds can use
pkg-config. Version it alongside Ardour's release.

### 3.3 Descriptor-based registration (no wscript edits)

Ardour's `ControlProtocolDescriptor` is already the manifest. The only
reason `libs/surfaces/wscript` lists children explicitly is because waf
needs to recurse into each subdir to build it. If the surface is built
*externally*, there's nothing to recurse into — the shared library just
needs to land on `ARDOUR_SURFACES_PATH`.

So the full picture is:

1. Third-party author writes their surface as a normal library project
   (CMake, meson, waf, Cargo-via-cdylib — whatever).
2. They compile against `ardour-surface.pc`.
3. They install the resulting `.so` anywhere Ardour's
   `ARDOUR_SURFACES_PATH` will see it (e.g.
   `/usr/lib/ardour/surfaces-extra/` or
   `~/.config/ardour9/surfaces/`).
4. Ardour `dlopen`s it at startup, calls
   `protocol_descriptor()`, registers normally.

No wscript patches. No fork. The `libs/surfaces/wscript` file doesn't
grow a line per external project.

### 3.4 Conditional in-tree drop-in (transitional)

For authors still prototyping with an in-tree build (Foyer today), make
the current pattern official: replace the hand-maintained `children += […]`
list in `libs/surfaces/wscript` with a scan-and-recurse:

```python
def configure(conf):
    import os
    base = conf.path.abspath()
    children = []
    for entry in sorted(os.listdir(base)):
        full = os.path.join(base, entry)
        if os.path.isfile(os.path.join(full, 'wscript')):
            children.append(entry)
    # Allow distros/packagers to cull specific surfaces:
    skip = conf.env.get('ARDOUR_SKIP_SURFACES', '').split()
    children = [c for c in children if c not in skip]
    for c in children:
        conf.recurse(c)
```

The diff Foyer currently ships becomes a no-op — the directory is picked
up automatically. Distro packagers keep control via env var. Upstream
loses the per-surface bookkeeping burden.

## 4. Semantics Foyer needs that don't exist yet

Separate from discovery, there are a handful of capabilities Foyer needs
that currently require either in-tree knowledge or direct header access:

1. **Plugin parameter signal aggregation.** A stable way to subscribe to
   *every* `ParameterChangedExternally` across every `PluginInsert` on
   every route, without reaching into each insert one at a time. Today's
   surfaces either watch specific parameters or poll. A `Session::
   AnyPluginParameterChanged(PluginInsert*, uint32_t, float)` signal would
   let a surface fan out plugin changes without per-insert wiring.
2. **Session-life-cycle hooks for surfaces.** `Session::StateSaved` and
   `Session::StateLoaded` already exist, but there's no `Session::
   StructuralChange` fire-and-forget signal for "tracks/plugins/sends
   added or removed" — surfaces currently have to subscribe to
   `RouteAdded`, `RouteRemoved`, `PluginInsert::PluginIoReConfigured`, etc.
   individually.
3. **Stable IDs across saves.** `PBD::ID` already survives saves; useful
   to have this documented as stable public API (not "subject to change").
4. **Read access to the plugin catalog.** `PluginManager::instance()` is
   in public headers but the rate at which it mutates vs. the semantics of
   `PluginInfoList` aren't clearly called out for surface authors.

These are complementary to the discovery proposal and worth one PR
each.

## 5. Precedent

- **LV2 / lilv / lv2-dev:** the gold standard. Plugins are installed to
  `LV2_PATH`, discovered by path scan, metadata in TTL. Third-party
  plugins ship as regular OS packages; Ardour itself consumes them.
- **VST3 / vst3sdk:** proprietary license-compatible. Hosts scan
  standard paths (`~/.vst3`, `/usr/lib/vst3`, …). Plugin is a folder
  bundle with a `moduleinfo.json`. No host recompilation required.
- **gstreamer plugins:** scan `$GST_PLUGIN_PATH`, each `.so` exposes a
  well-known `gst_plugin_desc` symbol. Exactly analogous to Ardour's
  `protocol_descriptor()` but out-of-tree by default.
- **vim/nvim:** runtimepath scan + autoload. No core edits ever.
- **VSCode extensions, JetBrains plugins, …:** manifest + discovery via
  a well-known directory.

Ardour already has every ingredient (`dlopen` loader, descriptor symbol,
path-based scan). The remaining work is packaging + docs.

## 6. Licensing note

Ardour is GPLv2. Any code that links against Ardour's public headers —
in-tree or out-of-tree — is GPLv2+ under the FSF's reading of "derivative
work." Auto-discovery does not change that; the `.so` is still linked
against `libardour`, wherever it's built.

Foyer's architecture is deliberately structured to **contain the GPL
blast radius to a single, minimal C++ shim**. The shim is GPLv2+ (it
links Ardour; no way around that). The shim's only job is to translate
Ardour's C++ events into a neutral wire format (Foyer's MessagePack-over-
UDS protocol). Everything above the Unix-domain-socket boundary — the
Rust sidecar, the web UI, the protocol schema, the desktop wrapper — is
a separate process that speaks a documented network protocol. It is
Foyer's position that this is not a derivative work of Ardour (the same
argument any network client of a GPL server relies on), and Foyer itself
will ship under a non-viral license.

Authors who want a commercial or otherwise non-GPL surface should use
the same pattern: a thin GPL shim that exposes a stable IPC to a
separately-licensed process. Auto-discovery helps by making the shim
side of this split cheap to build and distribute without forking
Ardour. It is neither a licensing loophole nor an invitation to one —
the shim remains GPL.

### 6.1 How this shapes Foyer's own repo layout

To keep the license boundary clean, Foyer's tree is split along
exactly the same line:

- [`shims/ardour/`](../shims/ardour/) — C++, links Ardour, GPLv2+. This is
  the only directory where Ardour headers are included. Anything we
  contribute upstream comes from here.
- [`crates/foyer-ipc/`](../crates/foyer-ipc/) — the wire format. No
  Ardour dependency. Non-GPL.
- [`crates/foyer-server`, `foyer-backend*`, `foyer-cli`,
  `foyer-desktop`](../crates/) — the Rust sidecar. Non-GPL.
- [`web/`](../web/) — the browser UI. Non-GPL.

Reviewers evaluating license posture should only need to look at the
shim directory. If a future change would require including an Ardour
header anywhere outside `shims/ardour/`, that's a red flag worth
stopping to discuss.

## 7. Summary of asks for upstream

1. **Turn `libs/surfaces/wscript` into a directory scan** (one-file
   patch, no functional change for in-tree builds, allows drop-in
   development).
2. **Install public headers** needed to implement a `ControlProtocol`;
   ship `ardour-surface.pc`.
3. **Document `ARDOUR_SURFACES_PATH`** as stable extension ABI,
   including a recommended install layout
   (`/usr/lib/ardour/surfaces-extra/`, `~/.config/ardour9/surfaces/`).
4. **Expose session-wide plugin-parameter change signals** as
   documented public API (Foyer has to reinvent this today).

With (1)–(4) in place, Foyer (and anyone else building a pro-grade
control surface) can ship as a normal OS package without ever touching
Ardour's source tree.

---

# Appendix: Commercial DAW SDK landscape

When we think about whether the same architecture could target other
pro DAWs, the licensing and SDK stories matter as much as the APIs. This
is a survey of what exists and where the walls are, from most- to
least-open.

## LV2

- **License:** ISC (permissive) + individual plugin licenses.
- **Hosts:** Ardour, Qtractor, MusE, Carla, Bitwig, Reaper (via bridge).
- **Introspection:** Excellent. Every port has metadata — units, ranges,
  scale points, groupings, `rdf:type`, display priorities. Our schema
  maps directly.
- **Control surfaces:** LV2 doesn't define a control-surface concept per
  se; hosts implement their own. Ardour uses its `ControlProtocol`.
- **Limitations:** None that affect Foyer.

## CLAP (Bitwig + u-he, 2022)

- **License:** MIT. SDK is `github.com/free-audio/clap`.
- **Hosts:** Bitwig, Reaper, FL Studio, nascent support in others.
- **Introspection:** Very good. Parameters have flags for stepped/
  enumerated/periodic, automation hints, bypass. Modulation + per-voice
  mod are first class.
- **Control surfaces:** Not a control-surface SDK; plugin format. But
  because the format is MIT-licensed, host-side use is unencumbered.
- **Limitations for Foyer's approach:** CLAP is a *plugin* SDK. A
  "control surface for Bitwig" would need Bitwig's own extension API
  (Java-based, closed platform terms). Bitwig does not expose a public
  native control-surface ABI; Controller Scripts are Java and run in
  their sandbox.

## VST3 (Steinberg, 2017)

- **License:** dual — GPLv3 *or* a proprietary Steinberg license. VST3
  SDK is `github.com/steinbergmedia/vst3sdk`.
- **Hosts:** Cubase, Nuendo, most pro DAWs.
- **Introspection:** Decent. Parameter info includes title, min/max
  (normalized), stepped flag, default. No groupings or scale points the
  way LV2 has them.
- **Control surfaces:** VST3 is a plugin standard, not a control surface
  protocol. Steinberg's own host-side extension for external surfaces is
  proprietary (the Remote Control SDK / Generic Remote) — available only
  to licensed Cubase/Nuendo developers.
- **Limitations for Foyer's approach:** No documented public API to
  drive Cubase or Nuendo from a custom control surface the way Foyer
  drives Ardour. The nearest analog is OSC (which Cubase exposes in a
  limited form) or Mackie Control emulation.

## Pro Tools / AAX (Avid)

- **License:** SDK is under NDA. The AAX Developer Program requires
  Avid approval and an annual fee.
- **Hosts:** Pro Tools (only).
- **Introspection:** Comparable to VST3 for plugins.
- **Control surfaces:** Pro Tools supports **EUCON** (Avid) and HUI
  (legacy Mackie). EUCON is proprietary and requires licensing Avid's
  SDK. There is no open control-surface path.
- **Limitations for Foyer's approach:** Significant. To target Pro
  Tools, we would need either EUCON licensing or to operate purely via
  MIDI/HUI emulation — which throws away almost all the semantic
  richness. Pro Tools is a **hard no** for open-source deep integration.

## Logic Pro (Apple)

- **License:** No public SDK for control surfaces. The closed
  "ControlSurface" framework lives inside Logic and is not exposed to
  third parties.
- **Integration surface:** MIDI (Mackie Control, HUI), Control Surface
  plug-in for Logic (internal only), OSC (limited). Logic's Scripter
  (JavaScript) runs per-track for MIDI processing, not global control.
- **Limitations:** Comparable to Pro Tools — no deep-integration path.

## Reaper (Cockos)

- **License:** `reaper_plugin.h` extension SDK is available publicly;
  Reaper binaries are proprietary.
- **Integration surface:** ReaScript (Python/Lua/EEL), `reaper_plugin`
  C extensions with full host API, OSC, and OSC Web Remote (similar in
  spirit to Ardour's Web Surfaces).
- **Introspection:** Via `reaper_plugin.h`'s API you can walk tracks,
  FX, and FX parameters. Foyer-equivalent would be a
  `reaper_foyer.dll` extension.
- **Limitations for Foyer's approach:** Reaper is the second-most-open
  option after Ardour. A Reaper backend for Foyer is entirely
  achievable. Main nuance: Reaper's FX parameter metadata is sparser
  than LV2's — often just normalized 0..1 with a display-formatted
  string.

## AU (Audio Unit, Apple)

- **License:** Part of the Core Audio SDK; permissive for plugin
  developers on macOS.
- **Hosts:** Logic, GarageBand, MainStage, Cubase, Reaper on macOS.
- **Control surfaces:** AU doesn't define a control-surface concept.
- **Limitations:** Same situation as CLAP — plugin format, not a
  remote-control path.

## Mackie Control / HUI (MIDI)

- **License:** None formally; documented de-facto via community reverse
  engineering.
- **Hosts:** Basically every DAW.
- **Introspection:** None — a fader position is just a MIDI controller
  number. No parameter names, no units, no grouping.
- **Applicability to Foyer:** Unusable as a source of truth. Would
  work as a **last-resort fallback** — Foyer could pretend to be a
  Mackie surface on any DAW that doesn't support a better path, and
  expose only transport + faders + pan + mute/solo. That's a massive
  regression from the Ardour experience and not worth pursuing unless
  a specific user wants it.

## Takeaways for Foyer's architecture

1. **Ardour is the best first target by a wide margin.** Open source,
   rich metadata, stable ABI within a release, and — with the proposal
   above — imminently suitable for out-of-tree surface development.
2. **Reaper is a tractable second target.** The Reaper extension SDK
   is public; the work is comparable to the Ardour shim, but with less
   parameter metadata (Reaper's FX envelope is thinner).
3. **VST3 hosts and Pro Tools are out of reach without commercial
   licensing.** EUCON/AAX NDAs are the blocker. A "demo mode against
   Cubase" is technically possible via OSC or Mackie emulation but
   throws away everything that makes Foyer interesting.
4. **Logic is out of reach.** No public control-surface API.
5. **Bitwig is out of reach.** Controller Scripts are Java-in-sandbox.
6. **The right strategic move** is to land the Ardour integration
   properly, propose upstream auto-discovery to un-fork ourselves, then
   add a Reaper backend when there's demand. Everything else is
   licensing work, not engineering work.

## Gotcha: schema parity across backends

The more backends we add, the more the neutral schema's coverage
matters. LV2 is the high-water mark for metadata (scale points, units,
groups). VST3 / Reaper / Mackie all expose less. The schema already
handles this gracefully — missing `enum_labels` degrades to a slider,
missing `group` degrades to a single "Parameters" section, missing
`unit` just omits the suffix. The web parameter UI needs to stay robust
under this degradation. Foyer's current param-control already does.

## Concrete next steps if we pursue upstream

1. File an issue on `ardour.org` (or ardour's GitLab) summarizing §3.1
   and §3.4 — the trivial wscript scan. This is the cheapest win and
   the smallest patch; no ABI commitment required.
2. Prototype `ardour-surface.pc` as a separate PR. Install just the
   header subset §3.2 enumerates. Hold it behind a configure flag
   initially so it doesn't force distros to ship a new package before
   the surface is deemed stable.
3. Once (1)+(2) land, stop shipping our `libs/surfaces/wscript` patch
   and switch Foyer to an out-of-tree build against `ardour-surface.pc`.
4. The session-level plugin-parameter signal (§4.1) is a separate
   conversation — land it as a small, self-contained PR against
   `libs/ardour/session.cc` once the author is known to maintainers.
