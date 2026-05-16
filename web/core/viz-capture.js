// SPDX-License-Identifier: Apache-2.0
//
// FE-side renderer for the `visualize` agent tool.
//
// Subscribes to `agent_render_request` envelopes, dispatches to a
// subcommand-specific capture function, and posts back an
// `agent_render_result` command with base64-encoded PNG bytes (or
// an error string).
//
// Two capture paths covered today:
//
//   1. **Canvas-backed viz** (waveform-gl, spectrogram, midi roll)
//      — pull the canvas element via the deep-find walk used in the
//      Playwright probes, call `canvas.toBlob('image/png')`, return
//      the bytes. Cheap, no extra deps.
//
//   2. **SVG-backed viz** (timeline, automation lane, mixer view in
//      its current shape) — serialize the SVG via XMLSerializer,
//      wrap it in a `Blob`, load into an `Image`, draw to a temp
//      canvas, then `toBlob`. One extra round trip but no library.
//
// For viz that mix DOM + canvas (the mixer with track strips) we
// fall back to capturing the bounding-box screenshot via the same
// SVG-rasterize path with `foreignObject` wrapping the DOM. That
// final fallback isn't pixel-perfect — it loses CSS-in-shadow-DOM
// nuance and computed gradients — but ships a recognizable image
// for the agent's "show me the mix" requests.

const DEEP_FIND_LOOP = (root, tag) => {
  const stack = [root];
  while (stack.length) {
    const r = stack.pop();
    const hit = r.querySelector?.(tag);
    if (hit) return hit;
    const all = r.querySelectorAll?.("*") || [];
    for (const el of all) if (el.shadowRoot) stack.push(el.shadowRoot);
  }
  return null;
};

function deepFind(tag) {
  const app = document.querySelector("foyer-app");
  if (!app) return null;
  return DEEP_FIND_LOOP(app.shadowRoot || app, tag);
}

function findInsideShadow(host, tag) {
  return DEEP_FIND_LOOP(host.shadowRoot || host, tag);
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  let bin = "";
  const view = new Uint8Array(buf);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin);
}

async function canvasToB64(canvas) {
  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? blobToBase64(blob).then(resolve, reject) : reject(new Error("canvas.toBlob returned null"))),
      "image/png",
    );
  });
}

async function svgToB64(svgEl, { width, height } = {}) {
  const serializer = new XMLSerializer();
  // Inline computed styles is too expensive for large timelines.
  // We rely on the SVG carrying its own attributes — Foyer's viz
  // already does that for stroke / fill — and accept that text in
  // foreignObject may pick up the default browser font.
  const svgText = serializer.serializeToString(svgEl);
  const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.crossOrigin = "anonymous";
    await new Promise((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("svg image load failed"));
      img.src = url;
    });
    const w = width || svgEl.viewBox?.baseVal?.width || svgEl.clientWidth || 1280;
    const h = height || svgEl.viewBox?.baseVal?.height || svgEl.clientHeight || 800;
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(w);
    canvas.height = Math.ceil(h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await canvasToB64(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Per-subcommand capture functions. Each returns a base64-encoded
// PNG string. Throws on failure with a message that's safe to ship
// back to the agent.
const CAPTURES = {
  async timeline() {
    const view = deepFind("foyer-timeline-view");
    if (!view) throw new Error("timeline view not currently mounted");
    const svg = findInsideShadow(view, "svg");
    if (svg) return await svgToB64(svg);
    const canvas = findInsideShadow(view, "canvas");
    if (canvas) return await canvasToB64(canvas);
    throw new Error("timeline view has no svg/canvas root");
  },
  async waveform({ track_id, region_id }) {
    const view = deepFind("foyer-waveform-gl") || deepFind("foyer-timeline-view");
    if (!view) throw new Error("waveform view not currently mounted");
    const canvas = findInsideShadow(view, "canvas");
    if (!canvas) throw new Error("waveform view has no canvas (WebGL or 2D)");
    void track_id;
    void region_id;
    return await canvasToB64(canvas);
  },
  async spectrogram({ track_id, duration_ms }) {
    const view = deepFind("foyer-spectrogram") || deepFind("foyer-meter-spectrum");
    if (!view) {
      throw new Error("no spectrogram component mounted; needs backend wiring");
    }
    const canvas = findInsideShadow(view, "canvas");
    if (!canvas) throw new Error("spectrogram has no canvas");
    void track_id;
    void duration_ms;
    return await canvasToB64(canvas);
  },
  async mixer() {
    // Foyer mixer is DOM-heavy. Capture the closest viewable
    // surface — `foyer-mixer-view` or its parent leaf.
    const view = deepFind("foyer-mixer-view") || deepFind("foyer-channel-strip");
    if (!view) throw new Error("mixer view not currently mounted");
    // DOM capture via SVG foreignObject. Pixel-imperfect but ships.
    const rect = view.getBoundingClientRect();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", String(rect.width));
    svg.setAttribute("height", String(rect.height));
    const fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
    fo.setAttribute("width", "100%");
    fo.setAttribute("height", "100%");
    const clone = view.cloneNode(true);
    fo.appendChild(clone);
    svg.appendChild(fo);
    return await svgToB64(svg, { width: rect.width, height: rect.height });
  },
  async automation_lane({ track_id, control_id }) {
    const lane = deepFind("foyer-automation-lane");
    if (!lane) throw new Error("automation lane not currently mounted");
    const svg = findInsideShadow(lane, "svg");
    if (!svg) throw new Error("automation lane has no svg root");
    void track_id;
    void control_id;
    return await svgToB64(svg);
  },
  async event_heatmap({ track_id }) {
    const view = deepFind("foyer-event-heatmap");
    if (!view) throw new Error("event heatmap not currently mounted");
    const canvas = findInsideShadow(view, "canvas");
    if (canvas) return await canvasToB64(canvas);
    const svg = findInsideShadow(view, "svg");
    if (svg) return await svgToB64(svg);
    throw new Error("event heatmap has no canvas/svg");
    void track_id;
  },
  async screen() {
    // "What the user currently sees." Captures the whole foyer-app
    // host — tile tree, transport, FABs, modals, etc. — at its
    // current pixel layout. The foreignObject path is lossy on
    // CSS-in-shadow-DOM and computed gradients (same caveat as the
    // mixer capture below) but produces a recognizable surface for
    // the agent's "look at the UI and tell me what to click" prompts.
    const app = document.querySelector("foyer-app");
    if (!app) throw new Error("foyer-app not currently mounted");
    const rect = app.getBoundingClientRect();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", String(rect.width));
    svg.setAttribute("height", String(rect.height));
    const fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
    fo.setAttribute("width", "100%");
    fo.setAttribute("height", "100%");
    const clone = app.cloneNode(true);
    fo.appendChild(clone);
    svg.appendChild(fo);
    return await svgToB64(svg, { width: rect.width, height: rect.height });
  },
  async midi_roll({ track_id, region_id }) {
    const view = deepFind("foyer-piano-roll") || deepFind("foyer-midi-roll");
    if (!view) throw new Error("piano roll not currently mounted");
    const canvas = findInsideShadow(view, "canvas");
    if (canvas) return await canvasToB64(canvas);
    const svg = findInsideShadow(view, "svg");
    if (svg) return await svgToB64(svg);
    throw new Error("piano roll has no canvas/svg");
    void track_id;
    void region_id;
  },
};

/// Install the FE-side renderer. Idempotent — calling twice is fine.
export function installVizCapture() {
  const ws = window.__foyer?.ws;
  if (!ws || ws.__vizCaptureInstalled) return;
  ws.__vizCaptureInstalled = true;
  ws.addEventListener("envelope", async (ev) => {
    const body = ev.detail?.body;
    if (!body || body.type !== "agent_render_request") return;
    const { request_id, request_json } = body;
    let request;
    try {
      request = JSON.parse(request_json);
    } catch (e) {
      ws.send({
        type: "agent_render_result",
        request_id,
        error: `bad request_json: ${e}`,
      });
      return;
    }
    const sub = request?.subcommand;
    const fn = CAPTURES[sub];
    if (!fn) {
      ws.send({
        type: "agent_render_result",
        request_id,
        error: `unknown viz subcommand: ${sub}`,
      });
      return;
    }
    try {
      const png_b64 = await fn(request);
      ws.send({ type: "agent_render_result", request_id, png_b64 });
    } catch (e) {
      ws.send({
        type: "agent_render_result",
        request_id,
        error: String(e?.message || e),
      });
    }
  });
}
