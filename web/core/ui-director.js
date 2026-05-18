// SPDX-License-Identifier: Apache-2.0
//
// FE-side listener for the `ui` agent tool.
//
// Subscribes to `ui_action` envelopes from the control WS, dispatches
// the requested action against window.__foyer.layout / spawnWindowKind,
// and posts back a `ui_action_result` command with the FE's UI state
// snapshot (on `query`) or a success/failure flag (on mutations).
//
// The agent's typed `Op` shape (foyer-agent::tools::ui::Op) is mirrored
// here on the wire — keep the dispatch table in lock-step with the
// Rust enum if a new subcommand lands. Unknown subcommands return a
// clear error so the agent sees the gap rather than a hang.

import {
  spawnWindowKind,
  listWindowKinds,
  listWindowKindsWithMeta,
  canonicalWindowKinds,
} from "/ui-core/widgets/window.js";

function snapshotState() {
  // List every currently-mounted foyer-window with the metadata the
  // agent needs to act on it (storage_key for close/focus, kind for
  // categorisation, geometry for sanity checking).
  const windows = [];
  for (const el of document.querySelectorAll("foyer-window")) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    windows.push({
      kind: el.viewKind || el.dataset?.kind || "",
      storage_key: el.storageKey || "",
      title: el.title || "",
      minimized: el.hasAttribute("minimized"),
      hidden_by_layer: el.hasAttribute("hidden-by-layer"),
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  // Tile tree — pass through whatever the layout store has.
  let tile_tree = null;
  try { tile_tree = window.__foyer?.layout?.state?.tree ?? null; } catch {}
  // Compute the gap-aware kind manifest. `available_kinds` is the
  // bare id list for back-compat with older agents; `kinds` is the
  // enriched form with label/description/viz_fallback; `missing_kinds`
  // tells the agent which canonical Foyer features are absent in this
  // variant so it knows to reach for the viz fallback (e.g. on a
  // phone the piano roll isn't registered but `visualize.midi_roll`
  // still works).
  const available = listWindowKinds();
  const kinds = listWindowKindsWithMeta();
  const canonical = canonicalWindowKinds();
  const availableSet = new Set(available);
  const missing_kinds = canonical
    .filter((k) => !availableSet.has(k.id))
    .map((k) => ({ ...k }));
  return {
    windows,
    tile_tree,
    available_kinds: available,
    kinds,
    canonical_kinds: canonical,
    missing_kinds,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}

function findWindow(storageKey) {
  if (!storageKey) return null;
  for (const el of document.querySelectorAll("foyer-window")) {
    if (el.storageKey === storageKey) return el;
  }
  return null;
}

function handleAction(action) {
  // action is whatever the agent serialized — the typed Rust `Op`
  // enum's `tag = "subcommand"` discriminator.
  const sub = action?.subcommand;
  switch (sub) {
    case "query":
      return { ok: true, state: snapshotState() };
    case "open": {
      const { kind, props } = action;
      if (!kind) return { ok: false, error: "open: missing `kind`" };
      const ok = spawnWindowKind(kind, props || {});
      if (!ok) return { ok: false, error: `unknown window kind: ${kind}` };
      return { ok: true };
    }
    case "close": {
      const key = action.storage_key;
      const el = findWindow(key);
      if (!el) return { ok: false, error: `no open window for ${key}` };
      try { el._emitClose?.(); } catch (e) { return { ok: false, error: String(e) }; }
      return { ok: true };
    }
    case "focus": {
      const key = action.storage_key;
      const el = findWindow(key);
      if (!el) return { ok: false, error: `no open window for ${key}` };
      try { el._bumpGlobalZIndex?.(); } catch (e) { return { ok: false, error: String(e) }; }
      return { ok: true };
    }
    case "set_tile_tree": {
      const tree = action.tree;
      const layout = window.__foyer?.layout;
      if (!tree) return { ok: false, error: "set_tile_tree: missing `tree`" };
      if (typeof layout?.setTree !== "function") {
        return { ok: false, error: "layout store not attached" };
      }
      try { layout.setTree(tree); } catch (e) { return { ok: false, error: String(e) }; }
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown ui subcommand: ${sub}` };
  }
}

/// Install the listener. Idempotent — calling twice is a no-op.
export function installUiDirector() {
  const ws = window.__foyer?.ws;
  if (!ws || ws.__uiDirectorInstalled) return;
  ws.__uiDirectorInstalled = true;
  ws.addEventListener("envelope", (ev) => {
    const body = ev.detail?.body;
    if (!body || body.type !== "ui_action") return;
    const { request_id, action_json } = body;
    let action = null;
    try {
      action = JSON.parse(action_json);
    } catch (e) {
      ws.send({
        type: "ui_action_result",
        request_id,
        ok: false,
        state_json: "",
        error: `bad action_json: ${e}`,
      });
      return;
    }
    let result;
    try {
      result = handleAction(action);
    } catch (e) {
      result = { ok: false, error: String(e?.message || e) };
    }
    const payload = {
      type: "ui_action_result",
      request_id,
      ok: !!result.ok,
      state_json: result.state ? JSON.stringify(result.state) : "",
    };
    if (result.error) payload.error = result.error;
    ws.send(payload);
  });
}
