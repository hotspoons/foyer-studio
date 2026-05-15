// Audio pool viewer + import (Session menu). Lists Ardour session sources
// (`list_audio_pool`); import uploads via POST `/sessions/import_audio` then
// `import_audio` so paths stay jail-safe. Supported uploads: WAV, FLAC, AIFF, Ogg.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { toast } from "foyer-ui-core/widgets/toast.js";
import { isAllowed } from "foyer-core/rbac.js";

function tunnelTokenQuery() {
  if (typeof window === "undefined") return "";
  const t = new URLSearchParams(window.location.search).get("token");
  return t ? `&token=${encodeURIComponent(t)}` : "";
}

function store() {
  return window.__foyer?.store || null;
}

export class AudioPoolModal extends LitElement {
  static properties = {
    _sources: { state: true, type: Array },
    _busy: { state: true, type: Boolean },
    _importBusy: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: block;
      font-family: var(--font-sans);
      color: var(--color-text);
      height: 100%;
    }
    .wrap {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px 14px;
      height: 100%;
      box-sizing: border-box;
    }
    header {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    header span {
      flex: 1;
      font-weight: 600;
      font-size: 13px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      font-size: 11px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      cursor: pointer;
    }
    .btn:hover:not(:disabled) {
      background: var(--color-surface-elevated);
    }
    .btn:disabled { opacity: 0.45; cursor: default; }
    .btn.primary {
      border-color: var(--color-accent);
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
    }
    .hint {
      margin: 0;
      font-size: 11px;
      color: var(--color-text-muted);
      line-height: 1.4;
    }
    .list {
      flex: 1;
      overflow: auto;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
    }
    .row {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--color-border);
      font-size: 12px;
      cursor: grab;
      user-select: none;
    }
    .row:active { cursor: grabbing; }
    .row:hover {
      background: color-mix(in oklab, var(--color-accent) 8%, transparent);
    }
    .row:last-child { border-bottom: 0; }
    .name {
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta {
      font-size: 10px;
      color: var(--color-text-muted);
      font-family: var(--font-mono);
    }
    .empty {
      padding: 24px 12px;
      text-align: center;
      color: var(--color-text-muted);
      font-size: 12px;
    }
  `;

  constructor() {
    super();
    this._sources = [];
    this._busy = false;
    this._importBusy = false;
    this._onStoreChange = this._onStoreChange.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    const s = store();
    this._sources = [...(s?.state?.audioPoolSources || [])];
    s?.addEventListener("change", this._onStoreChange);
    this._refresh(false);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    store()?.removeEventListener("change", this._onStoreChange);
  }

  _onStoreChange() {
    this._sources = [...(store()?.state?.audioPoolSources || [])];
    if (this._busy) {
      this._busy = false;
    }
    this.requestUpdate();
  }

  _refresh(showBusy) {
    const ws = window.__foyer?.ws;
    if (!ws) return;
    if (showBusy) this._busy = true;
    ws.send({ type: "list_audio_pool" });
    this.requestUpdate();
  }

  _pickImport() {
    if (!isAllowed("import_audio")) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".wav,.wave,.flac,.aif,.aiff,.ogg,.oga,audio/wav,audio/x-wav,audio/flac,audio/ogg";
    input.multiple = true;
    input.onchange = async () => {
      const files = [...(input.files || [])];
      for (const f of files) {
        /* eslint-disable no-await-in-loop */
        await this._uploadOne(f);
      }
    };
    input.click();
  }

  async _uploadOne(file) {
    const sid = store()?.state?.currentSessionId;
    if (!sid) {
      toast("Open a session first.", { tone: "warn" });
      return;
    }
    this._importBusy = true;
    this.requestUpdate();
    try {
      const url =
        `/sessions/import_audio?session_id=${encodeURIComponent(String(sid))}`
        + `&filename=${encodeURIComponent(file.name)}`
        + tunnelTokenQuery();
      const res = await fetch(url, { method: "POST", body: file });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(j.error || `Upload failed (${res.status})`, { tone: "error" });
        return;
      }
      if (!j.path) {
        toast("Import failed: no path in response", { tone: "error" });
        return;
      }
      window.__foyer?.ws?.send({ type: "import_audio", path: j.path });
      toast(`Imported ${file.name}`, { tone: "info" });
      // No explicit list_audio_pool here — the server emits a fresh
      // `AudioPoolListed` after the backend finishes importing (the
      // Ardour shim's SourceFactory runs in an async slot, so a
      // refresh dispatched from the FE races the actual import). The
      // `change` listener wired in connectedCallback picks up the
      // store update and re-renders.
    } finally {
      this._importBusy = false;
      this.requestUpdate();
    }
  }

  /** Build the dataTransfer payload for a pool-row drag. The
   *  timeline-view registers a matching MIME type so the cursor
   *  shows "copy" only when dropping on an audio lane that can
   *  accept the source. We embed the full row as JSON so the drop
   *  target doesn't need a second WS round-trip to find length /
   *  sample_rate.
   *
   *  We ALSO stash the same payload on `window.__foyer._poolDrag`
   *  for the duration of the drag. The timeline's dragover handler
   *  needs the source length to draw the ghost preview, but
   *  `dataTransfer.getData()` returns "" during a drag in every
   *  modern browser (only `types` is readable until drop). The
   *  shared-window ref is the standard workaround. Cleared in
   *  `dragend` so a cancelled drag doesn't leak state. */
  _onDragStart(ev, source) {
    if (!ev.dataTransfer) return;
    const payload = {
      id: source.id,
      name: source.name || "",
      path: source.path || "",
      channel: Number(source.channel) || 0,
      length_samples: Number(source.length_samples) || 0,
      sample_rate: Number(source.sample_rate) || 48_000,
    };
    ev.dataTransfer.setData("application/x-foyer-audio-pool-source", JSON.stringify(payload));
    if (payload.path) {
      ev.dataTransfer.setData("text/plain", payload.path.split("/").pop() || payload.name);
    }
    ev.dataTransfer.effectAllowed = "copy";
    if (window.__foyer) window.__foyer._poolDrag = payload;
  }

  _onDragEnd() {
    if (window.__foyer) window.__foyer._poolDrag = null;
  }

  render() {
    const canImport = isAllowed("import_audio");
    return html`
      <div class="wrap">
        <header>
          <span>Sources in this session</span>
          <button class="btn" ?disabled=${this._busy} @click=${() => this._refresh(true)}>
            ${icon("arrow-path", 14)} Refresh
          </button>
          ${canImport
            ? html`
                <button class="btn primary" ?disabled=${this._importBusy} @click=${() => this._pickImport()}>
                  ${icon("arrow-up-tray", 14)} Import…
                </button>`
            : null}
        </header>
        <p class="hint">
          Upload WAV, FLAC, AIFF, or Ogg. Other extensions are blocked by this importer.
        </p>
        <div class="list">
          ${this._sources.length === 0
            ? html`<div class="empty">No pool entries yet — import audio or record in Ardour.</div>`
            : this._sources.map(
                (s) => html`
                  <div class="row" title="${s.path || ""}\nDrag onto an audio track in the timeline to insert."
                       draggable="true"
                       @dragstart=${(e) => this._onDragStart(e, s)}
                       @dragend=${() => this._onDragEnd()}>
                    <span class="name">${s.name || "—"}</span>
                    <span class="meta">
                      ${s.path ? s.path.split("/").pop() : ""}
                      · ch ${s.channel ?? 0}
                      · ${((Number(s.length_samples) || 0) / (Number(s.sample_rate) || 48000)).toFixed(2)}s
                      · ${s.sample_rate ?? "?"} Hz
                    </span>
                  </div>
                `,
              )}
        </div>
      </div>
    `;
  }
}

customElements.define("foyer-audio-pool-modal", AudioPoolModal);

export function openAudioPoolModal() {
  return import("foyer-ui-core/widgets/window.js").then((wm) => {
    const el = document.createElement("foyer-audio-pool-modal");
    return wm.openWindow({
      title: "Audio pool",
      icon: "musical-note",
      storageKey: "audio-pool",
      content: el,
      width: 640,
      height: 480,
    });
  });
}
