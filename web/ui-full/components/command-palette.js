// Command palette — cmd+K / ctrl+K. Search across all actions the shim
// exposes via list_actions. Arrow keys navigate, enter invokes.
//
// Contextual entries (selection-aware) ride on top of the static
// action list. When the user has a track / region / time-range
// selected the palette surfaces the operations that apply to that
// selection — mute/solo/add-plugin/open-editor for a track, the
// region edit menu for one or more regions, loop-selection +
// zoom-to-selection for a time range.

import { LitElement, html, css, nothing } from "lit";
import { isActionAllowed, isActionHiddenFromCatalog } from "foyer-core/rbac.js";

/** Walk every reachable shadow root looking for a `<tag>` element.
 *  Returns the first hit or null. The palette uses it to pick up
 *  the live `foyer-timeline-view` instance — selection state is
 *  per-component and not mirrored in the global store. */
function deepFindTag(tag) {
  const root = document.querySelector("foyer-app")?.shadowRoot;
  if (!root) return null;
  const stack = [root];
  while (stack.length) {
    const r = stack.pop();
    if (!r) continue;
    const hit = r.querySelector(tag);
    if (hit) return hit;
    for (const el of r.querySelectorAll("*")) {
      if (el.shadowRoot) stack.push(el.shadowRoot);
    }
  }
  return null;
}

export class CommandPalette extends LitElement {
  static properties = {
    _open:   { state: true, type: Boolean },
    _query:  { state: true, type: String },
    _actions:{ state: true, type: Array },
    _hover:  { state: true, type: Number },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0;
      display: none;
      z-index: 2000;
      align-items: flex-start;
      justify-content: center;
      padding-top: 12vh;
      background: rgba(0, 0, 0, 0.5);
    }
    :host([open]) { display: flex; }

    .box {
      width: 560px; max-width: 92vw;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-panel);
      overflow: hidden;
      display: flex; flex-direction: column;
    }
    .input {
      padding: 12px 14px;
      border-bottom: 1px solid var(--color-border);
    }
    .input input {
      width: 100%;
      background: transparent;
      border: 0; outline: 0;
      font: inherit; font-family: var(--font-sans);
      font-size: 15px;
      color: var(--color-text);
    }
    .list { max-height: 50vh; overflow: auto; }
    .row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 14px;
      cursor: pointer;
      font-family: var(--font-sans);
      font-size: 13px;
      color: var(--color-text);
    }
    .row.active {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
    }
    .row .cat {
      font-size: 9px; font-weight: 600; letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      min-width: 72px;
    }
    .row.active .cat { color: rgba(255,255,255,0.75); }
    .row .label { flex: 1; }
    .row .shortcut {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-text-muted);
      padding: 2px 6px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    .row.active .shortcut { color: rgba(255,255,255,0.85); border-color: rgba(255,255,255,0.3); }
    .empty { padding: 24px; text-align: center; color: var(--color-text-muted); }
  `;

  constructor() {
    super();
    this._open = false;
    this._query = "";
    this._actions = [];
    this._hover = 0;
    this._onKey = this._onKey.bind(this);
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this._onKey);
    const ws = window.__foyer?.ws;
    if (ws) {
      ws.addEventListener("envelope", this._envelopeHandler);
      ws.send({ type: "list_actions" });
    }
  }
  disconnectedCallback() {
    document.removeEventListener("keydown", this._onKey);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    super.disconnectedCallback();
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (body?.type === "actions_list") {
      this._actions = body.actions || [];
    }
  }

  _onKey(ev) {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      this._toggle();
    } else if (this._open) {
      if (ev.key === "Escape") { ev.preventDefault(); this._close(); }
      else if (ev.key === "ArrowDown") {
        ev.preventDefault();
        const f = this._filtered();
        if (f.length) this._hover = (this._hover + 1) % f.length;
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        const f = this._filtered();
        if (f.length) this._hover = (this._hover - 1 + f.length) % f.length;
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const f = this._filtered();
        if (f[this._hover]) this._invoke(f[this._hover]);
      }
    }
  }

  _toggle() {
    this._open = !this._open;
    if (this._open) {
      this.setAttribute("open", "");
      this._query = "";
      this._hover = 0;
      queueMicrotask(() => this.renderRoot.querySelector("input")?.focus());
      window.__foyer?.ws?.send({ type: "list_actions" });
    } else {
      this.removeAttribute("open");
    }
  }
  _close() { this._open = false; this.removeAttribute("open"); }

  /** Build the contextual entries that ride on top of the static
   *  action catalog. Snapshots the live selection state from the
   *  store + timeline-view so the entries reflect what's selected
   *  at palette-open time. Each item is shaped like an action card
   *  (`{ category, label, action }`) so `_invoke` can dispatch via
   *  the same path. We deliberately do NOT round-trip `list_actions`
   *  for these — they're client-side surfaces (modal opens, region
   *  edits) without a server-side action id. */
  _contextualItems() {
    const out = [];
    const store = window.__foyer?.store;
    const session = store?.state?.session;
    const selTrackIds = Array.from(store?.state?.selectedTrackIds || []);
    const tv = deepFindTag("foyer-timeline-view");
    const selRegionIds = tv ? Array.from(tv._selectedRegionIds || []) : [];
    const timeSel = tv?._selection;
    const hasTimeRange = timeSel
      && Math.abs((timeSel.startSamples || 0) - (timeSel.endSamples || 0)) > 0;

    // Time selection — Loop / Zoom. These are the fast paths the
    // user wants when they highlight a region of the ruler.
    if (hasTimeRange) {
      out.push({
        category: "Time selection",
        label: "Loop selection",
        action: () => tv._setLoopToSelection?.(),
      });
      if (typeof tv.zoomToSelection === "function") {
        out.push({
          category: "Time selection",
          label: "Zoom to selection",
          action: () => tv.zoomToSelection(),
        });
      }
    }

    // Single-track selection — mute/solo, add plugin, open editor.
    if (selTrackIds.length === 1 && session?.tracks) {
      const tid = selTrackIds[0];
      const track = session.tracks.find((t) => t.id === tid);
      if (track) {
        const ws = () => window.__foyer?.ws;
        out.push({
          category: `Track · ${track.name}`,
          label: track.muted ? "Unmute track" : "Mute track",
          action: () =>
            ws()?.send({
              type: "update_track",
              id: tid,
              patch: { muted: !track.muted },
            }),
        });
        out.push({
          category: `Track · ${track.name}`,
          label: track.soloed ? "Unsolo track" : "Solo track",
          action: () =>
            ws()?.send({
              type: "update_track",
              id: tid,
              patch: { soloed: !track.soloed },
            }),
        });
        out.push({
          category: `Track · ${track.name}`,
          label: track.kind === "Midi" ? "Add instrument or effect…" : "Add plugin…",
          action: () =>
            import("./plugin-picker-modal.js")
              .then((m) => m.openPluginPicker?.({ trackId: tid }))
              .catch(() => {}),
        });
        if (track.kind === "Midi" && tv?._openMidiEditorForTrack) {
          out.push({
            category: `Track · ${track.name}`,
            label: "Open piano roll for this track",
            action: () => tv._openMidiEditorForTrack(track),
          });
        }
      }
    }

    // Region selection — pull the full edit-menu list from the
    // timeline-view's existing builder so this stays one source of
    // truth (and respects the same disabled / title / icon rules).
    if (selRegionIds.length > 0 && typeof tv?._regionEditMenuActions === "function") {
      const acts = tv._regionEditMenuActions();
      const heading = selRegionIds.length === 1
        ? "Region"
        : `${selRegionIds.length} regions`;
      for (const a of acts) {
        if (!a || a.divider) continue;
        // Keep disabled items out — the palette is a fast-fire surface
        // and a no-op invocation just steals focus.
        if (a.disabled) continue;
        out.push({
          category: heading,
          label: a.label,
          title: a.title,
          action: a.action,
        });
      }
      // Open piano roll / sequencer for a single selected MIDI or
      // sequencer region. The region edit menu only surfaces these
      // through the contextual right-click; the palette mirrors them
      // here so keyboard-driven users can jump straight in.
      if (selRegionIds.length === 1 && typeof tv?._regionForId === "function") {
        const rid = selRegionIds[0];
        const r = tv._regionForId(rid);
        const kind = r && tv._trackKind?.(r.track_id);
        if (kind === "midi") {
          const isSeq = !!r?.foyer_sequencer && r.foyer_sequencer.active !== false;
          if (isSeq && typeof tv._openBeatSequencer === "function") {
            out.push({
              category: "Region",
              label: "Open beat sequencer",
              action: () => tv._openBeatSequencer(r),
            });
          }
          if (typeof tv._openMidiEditor === "function") {
            out.push({
              category: "Region",
              label: isSeq ? "Open piano roll (raw MIDI)" : "Open piano roll",
              action: () => tv._openMidiEditor(r),
            });
          }
        }
      }
    }

    return out;
  }

  _filtered() {
    // RBAC: hide actions the current role can't invoke. The palette
    // is a power-user surface — showing denied items just to watch
    // clicks silently fail would be worse than not showing them.
    const permitted = this._actions.filter(
      (a) => isActionAllowed(a.id) && !isActionHiddenFromCatalog(a),
    );
    const ctx = this._contextualItems();
    const q = this._query.trim().toLowerCase();
    if (!q) return [...ctx, ...permitted];
    const matches = (a) =>
      a.label.toLowerCase().includes(q)
      || (a.category || "").toLowerCase().includes(q)
      || (a.id || "").toLowerCase().includes(q);
    return [...ctx.filter(matches), ...permitted.filter(matches)];
  }

  _invoke(a) {
    // Contextual items carry their own callback — fire it and bail
    // before the action-id dispatcher.
    if (typeof a.action === "function") {
      try { a.action(); } catch (e) { console.warn("[palette] action failed", e); }
      this._close();
      return;
    }
    if (a.id === "session.preferences") {
      import("./settings-modal.js").then((m) => m.openSettings());
      this._close();
      return;
    }
    if (a.id === "session.save_as") {
      import("./save-session-as-modal.js").then((m) => m.openSaveSessionAs());
      this._close();
      return;
    }
    window.__foyer?.ws?.send({ type: "invoke_action", id: a.id });
    this._close();
  }

  render() {
    if (!this._open) return nothing;
    const items = this._filtered();
    return html`
      <div class="box" @click=${(e) => e.stopPropagation()}>
        <div class="input">
          <input
            type="text"
            placeholder="Type an action…"
            .value=${this._query}
            @input=${(e) => { this._query = e.currentTarget.value; this._hover = 0; }}>
        </div>
        <div class="list">
          ${items.length === 0
            ? html`<div class="empty">No matches.</div>`
            : items.map((a, i) => html`
              <div class="row ${i === this._hover ? 'active' : ''}"
                   @mouseenter=${() => { this._hover = i; }}
                   @click=${() => this._invoke(a)}>
                <div class="cat">${a.category}</div>
                <div class="label">${a.label}</div>
                ${a.shortcut ? html`<div class="shortcut">${a.shortcut}</div>` : null}
              </div>
            `)}
        </div>
      </div>
    `;
  }

  // Backdrop click closes the palette.
  firstUpdated() {
    this.addEventListener("click", (e) => {
      if (e.target === this) this._close();
    });
  }
}
customElements.define("foyer-command-palette", CommandPalette);
