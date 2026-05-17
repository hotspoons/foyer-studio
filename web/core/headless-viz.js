// SPDX-License-Identifier: Apache-2.0
//
// Headless-render mode for the standalone `/viz` route.
//
// When chromiumoxide-driven Chromium loads `/?headless-viz=...&...`
// (or `/viz?...`) we:
//
//   1. Wait for the WS to come up and snapshot to land so the tile-
//      leaf has data.
//   2. Use the existing layout store to swap in a single full-window
//      leaf showing the requested view (timeline / mixer / waveform /
//      etc.). Reuses the same tile / leaf code the real UI uses, no
//      separate render path.
//   3. Hide the surrounding chrome (transport bar, FABs, status
//      strip) so the screenshot is just the viz.
//   4. After the requested component appears AND a couple of
//      animation frames have ticked (so Lit's microtask batches +
//      WebGL first-frame draws complete), set
//      `document.body.dataset.foyerVizReady = "true"`. The headless
//      renderer polls for that attribute before taking the
//      screenshot.

const QUERY_KEYS = [
  "headless-viz",
  "subcommand", // both spellings work; chromiumoxide uses subcommand=...
];

// Map agent visualize subcommand → the foyer view-id the tile-leaf
// understands. Keep this table tight; viz the agent can request but
// can't be hosted as a top-level tile (foreign object captures,
// transient overlays) are rejected explicitly.
//
// Several of the subcommands (waveform, automation_lane,
// event_heatmap) currently piggyback on the full timeline view —
// the timeline component honours `track_ids` / `region_id` /
// `control_id` props as filters, so passing them through narrows
// the visible content even though we don't have dedicated views
// for each. spectrogram has no underlying view yet; we leave the
// mapping pointing at a placeholder id so the renderer surfaces a
// clear "view not registered" error rather than silently producing
// a wrong-looking PNG.
const SUBCOMMAND_TO_VIEW = {
  timeline: "timeline",
  mixer: "mixer",
  waveform: "timeline",
  // spectrogram (subcommand) → spectrum view. The headless renderer
  // mounts the real `<foyer-spectrum-tile>` which subscribes to the
  // backend's live FFT pipeline, waits a few frames for the
  // waterfall to populate, then captures the canvas. Track-scoped
  // captures pass `target_track_id` through as a prop.
  spectrogram: "spectrum",
  // automation_lane mounts the dedicated automation editor (track
  // selector + lane viewport with its own zoom + time ruler). It
  // honours `focusControlId` to pre-check + scroll the requested
  // control's lane into view.
  automation_lane: "automation-editor",
  event_heatmap: "timeline",
  midi_roll: "midi-editor",
  // Hydrogen / Fruity-Loops cell grid for sequencer regions. Routes
  // to the same view ID widget-tile-views registers for the
  // beat-sequencer; checkAvailable on that view will surface a
  // clear "missing region/track" placeholder if the agent calls
  // beat_sequencer on a region that doesn't carry a sequencer
  // layout.
  beat_sequencer: "beat-sequencer",
  // `screen` is intentionally absent from this map — the subcommand
  // means "screenshot whatever is currently mounted", so the headless
  // hook deliberately skips its layout-swap step (see
  // `installHeadlessVizIfRequested` below). The FE-attached path
  // ignores this map entirely and captures the live foyer-app.
};

function readSubcommand() {
  const sp = new URLSearchParams(window.location.search);
  for (const k of QUERY_KEYS) {
    const v = sp.get(k);
    if (v) return { sub: v, params: Object.fromEntries(sp.entries()) };
  }
  return null;
}

async function waitForLayout(deadlineMs = 5000) {
  const start = performance.now();
  while (performance.now() - start < deadlineMs) {
    const layout = window.__foyer?.layout;
    if (layout && typeof layout.setTree === "function") return layout;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("layout store never came up");
}

// Poll the view registry for the requested id. The ui-full variant
// registers views (mixer, timeline, midi-editor, automation-editor,
// …) via ES-module side effects at app.js load. In a freshly
// launched chromium, those side effects can race ahead of
// installHeadlessVizIfRequested — without this wait we set the tree
// before automation-modal.js has registered, the tile-leaf falls
// through to its "Unknown view" placeholder, and the screenshot is
// a render error instead of the actual editor.
async function waitForViewRegistered(viewId, deadlineMs = 5000) {
  const start = performance.now();
  while (performance.now() - start < deadlineMs) {
    try {
      // Absolute path — we live IN /core already, so a relative
      // path keeps the dynamic-import resolution out of the
      // importmap layer that has been inconsistent across browsers.
      const mod = await import("./registry/views.js");
      const ok = (mod.listViews?.() || []).some((v) => v.id === viewId);
      if (ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function waitForSnapshot(deadlineMs = 6000) {
  const start = performance.now();
  while (performance.now() - start < deadlineMs) {
    const snap = window.__foyer?.store?.state?.session;
    if (snap) return snap;
    await new Promise((r) => setTimeout(r, 50));
  }
  // It's OK if no session snapshot lands — some viz (welcome screens)
  // don't need one. Return null and proceed.
  return null;
}

function hideChrome() {
  const style = document.createElement("style");
  style.textContent = `
    foyer-app::part(chrome),
    foyer-transport-bar,
    foyer-status-bar,
    foyer-agent-panel,
    foyer-chat-panel,
    foyer-fab,
    .right-dock,
    .left-dock,
    .top-dock,
    .bottom-dock { display: none !important; }
    foyer-app, html, body { background: #111 !important; }
    body { margin: 0; }
  `;
  document.head.appendChild(style);
}

function signalReady() {
  // Two animation frames + a microtask flush is the most reliable
  // way to ensure Lit + WebGL first-frame have completed.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      queueMicrotask(() => {
        document.body.dataset.foyerVizReady = "true";
      });
    });
  });
}

/// Install the headless-viz hook on bootstrap. No-op when no
/// `headless-viz` / `subcommand` query param is present, so this is
/// safe to call unconditionally from boot.js.
export async function installHeadlessVizIfRequested() {
  const requested = readSubcommand();
  if (!requested) return;
  // Tag the body synchronously, before any awaits, so any concurrent
  // foyer-app render that races us still sees the "headless-viz mode"
  // signal and short-circuits to the bare tile-container instead of
  // the welcome screen + full chrome.
  try {
    if (document.body) document.body.dataset.foyerHeadlessViz = "true";
    else document.addEventListener("DOMContentLoaded", () => {
      document.body.dataset.foyerHeadlessViz = "true";
    }, { once: true });
  } catch {}
  try {
    const { sub, params } = requested;
    // `screen` is a literal "what's on the page right now" shot —
    // skip the chrome-hide + layout-swap so the screenshot reflects
    // the current state without us mutating it.
    if (sub === "screen") {
      // Give whatever variant booted a beat to paint, then signal.
      await new Promise((r) => setTimeout(r, 600));
      signalReady();
      return;
    }
    const view = SUBCOMMAND_TO_VIEW[sub];
    if (!view) {
      console.error("[headless-viz] unknown subcommand:", sub);
      document.body.dataset.foyerVizError = `unknown subcommand: ${sub}`;
      signalReady();
      return;
    }
    hideChrome();
    const layout = await waitForLayout();
    await waitForSnapshot();
    // Ensure the target view's registration (typically a side-effect
    // ES-module import) actually landed before we set the tile tree.
    // A fast browser can reach setTree before automation-modal.js
    // finishes loading, in which case tile-leaf shows the "Unknown
    // view" placeholder and our screenshot is a fake error.
    const registered = await waitForViewRegistered(view, 5000);
    if (!registered) {
      console.warn(
        `[headless-viz] view '${view}' not registered after 5s — proceeding anyway`,
      );
    }
    // Convert snake_case URL params (the canonical agent shape) to
    // the camelCase prop names registered views expect — midi-editor
    // gates on `regionId` / `trackId`, plugin-panel on `pluginId`,
    // etc. Without this the agent passes `region_id=...` and the
    // tile-leaf renders a "missing region reference" placeholder.
    const snakeToCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const props = {};
    for (const [k, v] of Object.entries(params)) {
      if (k === "headless-viz" || k === "subcommand") continue;
      const camel = snakeToCamel(k);
      props[camel] = v;
      // Keep the snake_case spelling too — some views read either
      // form, and downstream code that does `props.region_id`
      // should not break silently.
      if (camel !== k) props[k] = v;
    }
    layout.setTree({ kind: "leaf", id: "headless-viz", view, props });
    // Give the tile-leaf a few hundred ms to mount + render + paint
    // before claiming readiness. WebGL waveform meshes in particular
    // do their first draw on the rAF after WS data arrives.
    await new Promise((r) => setTimeout(r, 600));
    // Subcommand-specific focus, applied AFTER mount so the agent
    // gets a posed shot instead of the default "show everything"
    // timeline. Method lookup walks shadow boundaries (the timeline
    // view lives ≥2 roots deep inside foyer-app).
    if (view === "timeline") {
      try {
        const tv = _deepFind("foyer-timeline-view");
        if (tv) {
          if (sub === "waveform" && props.regionId) {
            tv.focusOnRegion(props.regionId);
          } else if (sub === "event_heatmap" && props.trackId) {
            tv.setEventHeatmap(props.trackId);
            tv.focusOnTrack(props.trackId);
          }
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch (e) {
        console.warn("[headless-viz] timeline focus failed:", e);
      }
    }
    // midi-editor + beat-sequencer expect their region content
    // (`notes`, `foyer_sequencer`, `regionName`) to be set on the
    // live element — they don't fetch it from the store on their
    // own (the floating-window opener at `openMidiEditor()` does it
    // imperatively). In headless mode the tile-leaf just instantiates
    // the bare element with `regionId` / `trackId`, so the editor
    // mounts empty even when the live region has notes. Fix:
    // explicitly fetch the region via `list_regions` and hydrate the
    // element before screenshotting.
    if (view === "midi-editor" || view === "beat-sequencer") {
      try {
        const trackId = props.trackId || props.track_id;
        const regionId = props.regionId || props.region_id;
        if (trackId && regionId) {
          const region = await _fetchRegion(trackId, regionId, 2000);
          if (region) {
            const tag =
              view === "midi-editor" ? "foyer-midi-editor" : "foyer-beat-sequencer";
            const el = _deepFind(tag);
            if (el) {
              if (view === "midi-editor") {
                el.notes = region.notes || [];
                el.regionName = region.name || "";
                el.sequencerLayout = region.foyer_sequencer || null;
                el.readOnly = !!(
                  region.foyer_sequencer &&
                  region.foyer_sequencer.active !== false
                );
              } else {
                el.notes = region.notes || [];
                el.regionName = region.name || "";
                if (region.foyer_sequencer) {
                  el.layout = region.foyer_sequencer;
                }
              }
              // Lit needs a microtask + rAF to commit the new props
              // into the rendered tree before the screenshotter
              // captures.
              await new Promise((r) => setTimeout(r, 250));
            }
          }
        }
      } catch (e) {
        console.warn("[headless-viz] region hydration failed:", e);
      }
    }
    if (view === "spectrum") {
      // Map `target_track_id` → the inner tile's `target` prop, and
      // wait for a real waterfall to fill in before the capturer runs.
      // Without the wait the screenshot is a blank canvas — the FFT
      // pipeline needs ~10 frames to build a visible spectrogram.
      try {
        const tile = _deepFind("foyer-spectrum-tile");
        if (tile) {
          if (props.target_track_id || props.trackId) {
            const id = props.target_track_id || props.trackId;
            tile.target = { kind: "track", id };
          } else {
            tile.target = { kind: "master" };
          }
          // Wait up to 2 s for the spectrum widget to receive enough
          // frames that the waterfall has visible content.
          const deadline = performance.now() + 2000;
          while (performance.now() < deadline) {
            const inner = _deepFind("foyer-spectrum");
            const history = inner?._history?.length || 0;
            if (history >= 8) break;
            await new Promise((r) => setTimeout(r, 60));
          }
        }
      } catch (e) {
        console.warn("[headless-viz] spectrum focus failed:", e);
      }
    }
    // Tile-leaf renders an "Unknown view: <id>." placeholder when
    // the view isn't registered. Detect that and surface it as a
    // render error — without this the headless renderer happily
    // screenshots the placeholder and returns success, fooling the
    // agent into thinking the viz worked. The tile-leaf is nested
    // inside foyer-tile-container's shadow root, so we need to walk
    // through every shadow boundary rather than relying on a single
    // direct-child querySelector.
    try {
      const stack = [document.querySelector("foyer-app")?.shadowRoot];
      let leafText = "";
      while (stack.length) {
        const r = stack.pop();
        if (!r) continue;
        const leaf = r.querySelector?.("foyer-tile-leaf");
        if (leaf?.shadowRoot) {
          leafText = (leaf.shadowRoot.textContent || "").trim();
          break;
        }
        for (const el of r.querySelectorAll?.("*") || []) {
          if (el.shadowRoot) stack.push(el.shadowRoot);
        }
      }
      // `includes`, not `startsWith` — the tile-leaf body also
      // contains the view-id header at the top, so the "Unknown
      // view: …" message lives mid-string.
      if (leafText.includes("Unknown view:")) {
        // Snapshot which views ARE registered right now so the
        // agent (and us, debugging) can see whether the missing
        // entry is a real gap or a load-order race.
        let registered = "(unknown)";
        try {
          const mod = await import("./registry/views.js");
          registered = (mod.listViews?.() || []).map((v) => v.id).join(", ");
        } catch {}
        document.body.dataset.foyerVizError =
          `view '${view}' is not registered in this UI variant — no renderer for visualize.${sub}. registered: [${registered}]`;
      }
    } catch {}
    signalReady();
  } catch (e) {
    console.error("[headless-viz] failed:", e);
    document.body.dataset.foyerVizError = String(e?.message || e);
    signalReady();
  }
}

// Send `list_regions { track_id }` and await the matching
// `regions_list` envelope, then pick the region with `regionId`.
// Used by the headless midi-editor / beat-sequencer hydration so
// the screenshot reflects the live region's notes + sequencer
// layout instead of the editor's empty default.
function _fetchRegion(trackId, regionId, deadlineMs = 2000) {
  return new Promise((resolve) => {
    const ws = window.__foyer?.ws;
    if (!ws) return resolve(null);
    let done = false;
    const onEnvelope = (e) => {
      const body = e?.detail?.body || e?.body;
      if (!body || body.type !== "regions_list") return;
      if (body.track_id !== trackId) return;
      const region = (body.regions || []).find((r) => r.id === regionId);
      if (!region) return;
      done = true;
      ws.removeEventListener?.("envelope", onEnvelope);
      resolve(region);
    };
    ws.addEventListener?.("envelope", onEnvelope);
    try {
      ws.send({ type: "list_regions", track_id: trackId });
    } catch {
      ws.removeEventListener?.("envelope", onEnvelope);
      return resolve(null);
    }
    setTimeout(() => {
      if (done) return;
      ws.removeEventListener?.("envelope", onEnvelope);
      resolve(null);
    }, deadlineMs);
  });
}

// Walk every shadow boundary under foyer-app and return the first
// element matching `tag`. Live views live ≥2 shadow roots deep
// (foyer-app → foyer-tile-container → foyer-tile-leaf → the view),
// so a plain document.querySelector misses them.
function _deepFind(tag) {
  const app = document.querySelector("foyer-app");
  if (!app?.shadowRoot) return null;
  const stack = [app.shadowRoot];
  while (stack.length) {
    const root = stack.pop();
    if (!root) continue;
    const hit = root.querySelector?.(tag);
    if (hit) return hit;
    for (const el of root.querySelectorAll?.("*") || []) {
      if (el.shadowRoot) stack.push(el.shadowRoot);
    }
  }
  return null;
}
