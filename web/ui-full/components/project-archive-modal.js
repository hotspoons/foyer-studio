// Project upload + export modals.
//
// Both surfaces live in one file because they're symmetric flows
// against the same `/sessions/{upload,export}` HTTP endpoints — keeping
// them adjacent makes the file-archive contract obvious to the next
// reader. The destination/source picker reuses `<foyer-session-view>`
// the same way `project-picker-modal.js` does so the user always
// browses through the same jail UI.
//
// Upload flow:
//   1. User picks a destination *folder* with the file browser.
//   2. User picks a `.zip` / `.tar.gz` from a native file input.
//   3. Browser POSTs the bytes to `/sessions/upload?dest=<rel>`.
//   4. Server extracts under the dest, renames on collision, replies
//      with the resulting jail-relative project path. The modal toasts
//      success and exposes a one-click "Open it now" button.
//
// Export flow:
//   1. User confirms the current session as the export target.
//   2. UI asks the sidecar to save (so dirty state is flushed).
//   3. Once dirty=false, the modal hits `/sessions/export?path=<rel>`
//      and triggers a browser download of the resulting tar.gz.

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { toast } from "foyer-ui-core/widgets/toast.js";
import { launchProjectGuarded } from "../session-launch.js";
import "./session-view.js";

function tunnelTokenQuery() {
  // Tunnel guests carry the digest token in the page URL; mirror it
  // onto our HTTP requests so the same RBAC gate that protects /ws
  // protects /sessions/* too. LAN clients never see this.
  if (typeof window === "undefined") return "";
  const t = new URLSearchParams(window.location.search).get("token");
  return t ? `&token=${encodeURIComponent(t)}` : "";
}

function tunnelTokenLeading() {
  if (typeof window === "undefined") return "";
  const t = new URLSearchParams(window.location.search).get("token");
  return t ? `?token=${encodeURIComponent(t)}` : "";
}

export class ProjectUploadModal extends LitElement {
  static properties = {
    _currentPath: { state: true, type: String },
    _file:        { state: true, type: Object },
    _busy:        { state: true, type: Boolean },
    _progress:    { state: true, type: Number },
    _error:       { state: true, type: String },
    _result:      { state: true, type: Object },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0; z-index: 5400;
      display: flex; align-items: center; justify-content: center;
      pointer-events: auto;
      font-family: var(--font-sans); color: var(--color-text);
    }
    .scrim {
      position: absolute; inset: 0;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(3px);
    }
    .modal {
      position: relative;
      width: min(880px, 92vw);
      height: min(760px, 88vh);
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg, 10px);
      box-shadow: var(--shadow-panel);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--color-border);
      background: linear-gradient(180deg, var(--color-surface-muted), var(--color-surface-elevated));
    }
    header .title {
      flex: 1;
      font-size: 11px; letter-spacing: 0.14em;
      text-transform: uppercase; font-weight: 700;
      background: linear-gradient(135deg, var(--color-accent-3), var(--color-accent-2));
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    header button {
      background: transparent; border: 1px solid transparent;
      border-radius: var(--radius-sm); color: var(--color-text-muted);
      padding: 2px 6px; cursor: pointer;
    }
    header button:hover { color: var(--color-text); border-color: var(--color-border); }
    .body { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    foyer-session-view { flex: 1; min-height: 0; }
    .footer {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface);
      flex-wrap: wrap;
    }
    .label {
      font-size: 10px; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--color-text-muted);
    }
    .target {
      font-family: var(--font-mono);
      font-size: 11px; color: var(--color-accent-3);
      max-width: 320px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .file-row {
      display: flex; align-items: center; gap: 10px;
      flex: 1; min-width: 0;
    }
    .file-name {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-text);
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    button.action {
      font: inherit; font-family: var(--font-sans);
      font-size: 11px; letter-spacing: 0.06em;
      padding: 6px 14px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff; border: 1px solid transparent;
      font-weight: 600; transition: filter 0.12s;
    }
    button.action:disabled { opacity: 0.45; cursor: not-allowed; }
    button.action:not(:disabled):hover { filter: brightness(1.1); }
    button.ghost {
      background: transparent; color: var(--color-text);
      border: 1px solid var(--color-border);
    }
    button.ghost:hover { border-color: var(--color-accent); }
    .err {
      padding: 8px 14px;
      color: var(--color-danger);
      font-family: var(--font-mono);
      font-size: 11px;
      background: color-mix(in oklab, var(--color-danger) 8%, transparent);
      border-top: 1px solid var(--color-border);
    }
    .progress-bar {
      flex: 1;
      height: 6px;
      border-radius: 999px;
      background: color-mix(in oklab, var(--color-accent) 14%, var(--color-surface));
      overflow: hidden;
    }
    .progress-bar .fill {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, var(--color-accent), var(--color-accent-2));
      transition: width 0.12s linear;
    }
    .result {
      padding: 10px 14px;
      border-top: 1px solid var(--color-border);
      background: color-mix(in oklab, var(--color-success, #22c55e) 6%, transparent);
      display: flex; align-items: center; gap: 12px;
    }
    .result .ok-name {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-success, #22c55e);
      flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .help {
      flex: 1;
      font-size: 11px; color: var(--color-text-muted);
      line-height: 1.4;
    }
  `;

  constructor() {
    super();
    this._currentPath = "";
    this._file = null;
    this._busy = false;
    this._progress = 0;
    this._error = "";
    this._result = null;
    this._envelopeHandler = (ev) => this._onEnvelope(ev.detail);
  }

  connectedCallback() {
    super.connectedCallback();
    this._onKey = (ev) => {
      if (ev.key === "Escape" && !this._busy) { ev.preventDefault(); this._close(); }
    };
    window.addEventListener("keydown", this._onKey, true);
    window.__foyer?.ws?.addEventListener("envelope", this._envelopeHandler);
  }
  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKey, true);
    window.__foyer?.ws?.removeEventListener("envelope", this._envelopeHandler);
    super.disconnectedCallback();
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body) return;
    if (body.type === "path_listed") {
      // Track which folder the user is browsing — that's the upload
      // destination. session-view doesn't surface a "current folder"
      // hook directly so we listen on the WS side.
      this._currentPath = body.listing?.path || "";
    }
  }

  _onPickFile(ev) {
    const input = ev.target;
    const f = input.files && input.files[0];
    this._file = f || null;
    this._error = "";
    this._result = null;
  }

  async _upload() {
    const file = this._file;
    if (!file) return;
    const dest = this._currentPath || "";
    this._busy = true;
    this._error = "";
    this._progress = 0;
    try {
      const url = `/sessions/upload?dest=${encodeURIComponent(dest)}&filename=${encodeURIComponent(file.name)}${tunnelTokenQuery()}`;
      const reply = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url, true);
        xhr.responseType = "json";
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) this._progress = e.loaded / e.total;
        };
        xhr.onerror = () => reject(new Error("network error"));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.response);
          } else {
            const msg = xhr.response?.error || `HTTP ${xhr.status}`;
            reject(new Error(msg));
          }
        };
        // Send the raw bytes — server detects format via magic bytes,
        // not Content-Type, so we don't need multipart wrapping.
        xhr.send(file);
      });
      this._result = reply;
      this._progress = 1;
      toast(`Uploaded ${reply.name} (${reply.format})`, { tone: "info" });
    } catch (e) {
      this._error = e.message || String(e);
    } finally {
      this._busy = false;
    }
  }

  _openUploaded() {
    const r = this._result;
    if (!r?.path) return;
    launchProjectGuarded({
      backend_id: "ardour",
      project_path: r.path,
    });
    this._close();
  }

  render() {
    const canUpload = !!this._file && !this._busy;
    return html`
      <div class="scrim" @click=${() => this._busy ? null : this._close()}></div>
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        <header>
          <span class="title">Upload Project</span>
          <button title="Close (Esc)" @click=${this._close} ?disabled=${this._busy}>
            ${icon("x-mark", 14)}
          </button>
        </header>
        <div class="body">
          <foyer-session-view></foyer-session-view>
        </div>
        ${this._result ? html`
          <div class="result">
            <span>${icon("check", 16)}</span>
            <span class="ok-name">${this._result.path}</span>
            <button class="action" @click=${this._openUploaded}>Open it now</button>
            <button class="ghost action" @click=${this._close}>Done</button>
          </div>
        ` : html`
          <div class="footer">
            <span class="label">Destination</span>
            <span class="target" title=${this._currentPath || "(jail root)"}>
              ${this._currentPath || "(jail root)"}
            </span>
            <div class="file-row">
              <label class="action ghost" style="cursor:pointer">
                ${icon("arrow-up-tray", 12)}
                <span style="margin-left:6px">Choose archive…</span>
                <input
                  type="file"
                  accept=".zip,.tar.gz,.tgz,.tar.zst,.tzst,application/zip,application/gzip,application/zstd"
                  @change=${this._onPickFile}
                  style="display:none"
                />
              </label>
              <span class="file-name" title=${this._file?.name || ""}>
                ${this._file?.name || "(no file selected)"}
              </span>
            </div>
            ${this._busy ? html`
              <div class="progress-bar">
                <div class="fill" style="width:${Math.round(this._progress * 100)}%"></div>
              </div>
            ` : null}
            <button class="action" @click=${this._upload} ?disabled=${!canUpload}>
              ${this._busy ? "Uploading…" : "Upload"}
            </button>
          </div>
        `}
        ${this._error ? html`<div class="err">${this._error}</div>` : null}
      </div>
    `;
  }

  _close = () => {
    if (this._busy) return;
    this.remove();
  };
}
customElements.define("foyer-project-upload-modal", ProjectUploadModal);

export function showUploadModal() {
  const el = document.createElement("foyer-project-upload-modal");
  document.body.appendChild(el);
  return el;
}

/**
 * Save → wait for dirty=false → download. Returns a promise that
 * resolves after the download starts (or rejects on a save timeout).
 *
 * The save is not strictly required for the export to be safe —
 * `tar.gz` of an unsaved session is a valid snapshot of what's on
 * disk — but skipping save would silently drop in-memory edits, which
 * is the wrong default for a "Export Project" verb.
 */
export async function exportCurrentSession() {
  const ws = window.__foyer?.ws;
  const store = window.__foyer?.store;
  const session = store?.state?.session;
  const path = session?.path
    || store?.state?.sessions?.find((s) => s.id === store.state.currentSessionId)?.path;
  if (!ws || !path) {
    toast("No session is open — nothing to export.", { tone: "warn" });
    return;
  }

  const wasDirty = !!session?.dirty;

  const dismissBusy = toast(wasDirty ? "Saving session…" : "Preparing archive…", { ttl: 12_000 });
  try {
    if (wasDirty) {
      ws.send({ type: "save_session" });
      await waitForDirtyClear(store, 8_000);
    }
    const url = `/sessions/export?path=${encodeURIComponent(path)}${tunnelTokenQuery().replace(/^&/, "&")}`;
    // Trigger a download by navigating an invisible <a download>. fetch
    // would buffer the whole tarball into memory before handing it to
    // the user; <a download> lets the browser stream it to disk.
    const a = document.createElement("a");
    a.href = url;
    // Hint the filename — the server also sets Content-Disposition, but
    // some browsers prefer the explicit `download` attribute.
    a.download = `${(path.split("/").pop() || "project")}.tar.gz`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    dismissBusy();
    toast(`Exported ${a.download}`, { tone: "info" });
  } catch (e) {
    dismissBusy();
    toast(`Export failed: ${e.message || e}`, { tone: "error" });
  }
}

function waitForDirtyClear(store, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!store?.state?.session?.dirty) { resolve(); return; }
    let done = false;
    const onChange = () => {
      if (done) return;
      if (!store.state?.session?.dirty) {
        done = true;
        store.removeEventListener("change", onChange);
        resolve();
      }
    };
    store.addEventListener("change", onChange);
    setTimeout(() => {
      if (done) return;
      done = true;
      store.removeEventListener("change", onChange);
      reject(new Error("save timed out"));
    }, timeoutMs);
  });
}

// Kept exported (and used internally) so callers don't need to know
// about the URL token shape — a future change to query params lives
// behind this helper.
export function exportUrlFor(path) {
  if (!path) return null;
  const lead = tunnelTokenLeading();
  const sep = lead ? "&" : "?";
  return `/sessions/export${lead}${sep}path=${encodeURIComponent(path)}`;
}
