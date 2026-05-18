// Register the dialog-class widgets (track editor, MIDI editor, beat
// sequencer, plugin panel, console, diagnostics) as tile-class views
// so the user can mount them inside the tile tree alongside the
// mixer / timeline.
//
// The `<foyer-tile-leaf>` body renders any registered view via its
// `elementTag`, with `.session` + `.path` + per-id props
// (`trackId`, `regionId`, `pluginId`, `initialTab`) wired through.
// All five widget elements already accept those properties at module
// scope, so registering them here is the only glue required — the
// elements behave identically in a tile and in a foyer-window.
//
// `checkAvailable(props, session)` is the missing-entity guard: if a
// tile references a deleted track / region / plugin, tile-leaf shows
// a placeholder ("Track is no longer in this session — Float / Close")
// instead of mounting the widget against a stale id (where it would
// otherwise either crash on null lookup or silently stay empty,
// indistinguishable from a still-loading state).

import { registerView } from "foyer-core/registry/views.js";
import { spawnWindowKind } from "foyer-ui-core/widgets/window.js";

import "./track-editor-modal.js";
import "./midi-editor.js";
import "./beat-sequencer.js";
import "./plugin-panel.js";
import "./console-view.js";
import "./diagnostics.js";
import "./midi-devices-panel.js";
import "./soft-keyboard.js";
import "./automation-modal.js";
import "./spectrum-tile.js";

/// Float-out helper: pop a widget tile back into a foyer-window
/// using the existing window-kind factory registered in right-dock /
/// plugin-layer / track-editor-modal etc. The widget kinds are the
/// same names registerWindowKind uses; this thin wrapper exists so
/// the registry doesn't have to know about the import graph.
function floatSpawnFor(kind) {
  return (props = {}) => {
    if (!spawnWindowKind(kind, props)) {
      console.warn(`tile-leaf float: no factory registered for kind=${kind}`);
    }
  };
}

function findTrack(session, trackId) {
  return session?.tracks?.find?.((t) => t.id === trackId) || null;
}

function findPlugin(session, pluginId) {
  if (!session || !pluginId) return null;
  for (const t of session.tracks || []) {
    for (const p of t.plugins || []) {
      if (p.id === pluginId) return { plugin: p, track: t };
    }
  }
  return null;
}

registerView({
  id: "track-editor",
  label: "Track editor",
  icon: "adjustments-horizontal",
  elementTag: "foyer-track-editor-modal",
  order: 30,
  floatSpawn: (props) => {
    if (!props?.trackId) return;
    import("./track-editor-modal.js").then((m) => {
      m.openTrackEditor(props.trackId, { tab: props.initialTab || "" });
    });
  },
  checkAvailable: (props, session) => {
    const id = props?.trackId;
    if (!id) return { ok: false, title: "No track id", body: "This tile was opened without a track reference." };
    if (!findTrack(session, id)) {
      return {
        ok: false,
        title: "Track is gone",
        body: `Track ${id} is no longer in this session.`,
      };
    }
    return { ok: true };
  },
});

registerView({
  id: "midi-editor",
  label: "Piano roll",
  icon: "musical-note",
  elementTag: "foyer-midi-editor",
  order: 40,
  floatSpawn: floatSpawnFor("midi-editor"),
  checkAvailable: (props, session) => {
    const rid = props?.regionId;
    const tid = props?.trackId;
    if (!rid || !tid) return { ok: false, title: "No region", body: "This piano-roll tile is missing its region reference." };
    const track = findTrack(session, tid);
    if (!track) return { ok: false, title: "Track is gone", body: `Track ${tid} is no longer in this session.` };
    return { ok: true };
  },
});

// The full automation editor (track selector + control list + lane
// editors). Same element as the floating "Automation editor" window —
// `:host` is set to `width:100%; height:100%`, so dropping it into a
// tile renders the full surface without the window chrome. Headless
// `visualize.automation_lane` mounts this view with `trackId` +
// `focusControlId` for a focused screenshot.
registerView({
  id: "automation-editor",
  label: "Automation",
  icon: "sparkles",
  elementTag: "foyer-automation-modal",
  order: 45,
  floatSpawn: floatSpawnFor("automation-editor"),
  checkAvailable: (props, session) => {
    const tid = props?.trackId;
    if (!tid)
      return {
        ok: false,
        title: "No track",
        body: "This automation tile is missing its track reference.",
      };
    const track = findTrack(session, tid);
    if (!track)
      return {
        ok: false,
        title: "Track is gone",
        body: `Track ${tid} is no longer in this session.`,
      };
    return { ok: true };
  },
});

registerView({
  id: "beat-sequencer",
  label: "Beat sequencer",
  icon: "squares-2x2",
  elementTag: "foyer-beat-sequencer",
  order: 50,
  floatSpawn: floatSpawnFor("beat-sequencer"),
  checkAvailable: (props, session) => {
    const tid = props?.trackId;
    if (!tid) return { ok: false, title: "No track", body: "This sequencer tile is missing its track reference." };
    if (!findTrack(session, tid)) {
      return { ok: false, title: "Track is gone", body: `Track ${tid} is no longer in this session.` };
    }
    return { ok: true };
  },
});

registerView({
  id: "plugin-panel",
  label: "Plugin",
  icon: "puzzle-piece",
  elementTag: "foyer-plugin-panel",
  order: 60,
  // The plugin window kind is registered as `"plugin"` (singular)
  // in right-dock.js — the registered factory takes `{ pluginId }`
  // and resolves the live PluginInstance from the session before
  // opening the float, which is exactly the contract our props
  // already match.
  floatSpawn: floatSpawnFor("plugin"),
  checkAvailable: (props, session) => {
    const pid = props?.pluginId;
    if (!pid) return { ok: false, title: "No plugin", body: "This plugin tile is missing its plugin reference." };
    if (!findPlugin(session, pid)) {
      return { ok: false, title: "Plugin removed", body: `Plugin ${pid} is no longer on any track in this session.` };
    }
    return { ok: true };
  },
});

registerView({
  id: "console",
  label: "Console",
  icon: "command-line",
  elementTag: "foyer-console-view",
  order: 80,
  floatSpawn: floatSpawnFor("console"),
});

registerView({
  id: "diagnostics",
  label: "Diagnostics",
  icon: "check-circle",
  elementTag: "foyer-diagnostics",
  order: 90,
  floatSpawn: floatSpawnFor("diagnostics"),
});

registerView({
  id: "midi-devices",
  label: "MIDI Devices",
  icon: "musical-note",
  elementTag: "foyer-midi-devices-panel",
  order: 95,
  floatSpawn: floatSpawnFor("midi-devices"),
});

registerView({
  id: "soft-keyboard",
  label: "On-screen Keyboard",
  icon: "musical-note",
  elementTag: "foyer-soft-keyboard",
  order: 96,
  floatSpawn: floatSpawnFor("soft-keyboard"),
});

// Real-time spectrum analyser. Props:
//   · target  — { kind: "master" | "monitor" | "track", id?: string }
//   · channel — 0 (default), 1, or null (overlay all channels)
//   · fftSize — passthrough into the backend subscribe; defaults to 2048
// Default to the master bus so dropping the tile into the layout shows
// something meaningful immediately. The widget owns its own WS
// subscription lifecycle, so mounting/unmounting the tile is enough.
registerView({
  id: "spectrum",
  label: "Spectrum",
  // chart-bar exists in ui-core/icons.js; chart-bar-square doesn't,
  // which is why the picker was showing an empty square before.
  icon: "chart-bar",
  elementTag: "foyer-spectrum-tile",
  order: 97,
  floatSpawn: floatSpawnFor("spectrum"),
  // No checkAvailable gate — the server runs an FFT-fallback analyser
  // whenever the backend's native pipeline says `available=false`,
  // so the tile works on every backend. (Previously we read
  // `session.spectrum.available` and hid the tile under Ardour; the
  // server-side fallback makes that gate obsolete.)
});
