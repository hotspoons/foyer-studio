// Asset-pack consent + progress modal.
//
// Two states in one component:
//   1. Consent prompt — shows the pack's label, source URL, credits,
//      and license note from the server's `AssetPackInfo`. The user
//      explicitly clicks Download (or Skip) before any bytes are
//      fetched. The Skip choice gets recorded in `sprunkiStore` so
//      we don't re-prompt on every reload; the user can revisit it
//      later from the preferences modal.
//   2. Progress — once the download begins (state = Downloading or
//      Extracting), the same modal renders a progress bar and a
//      live byte count. When the pack flips to Ready we emit a
//      `ready` event so the parent can dismiss us.
//
// The component does NOT speak directly to the WS — it reads the
// latest `AssetPackInfo` from a `.pack` prop the parent feeds in
// based on `AssetPackList` / `AssetPackUpdated` events.

import { LitElement, html, css } from "lit";

export class SprunkiAssetPackModal extends LitElement {
  static properties = {
    /** Live `AssetPackInfo` from the server. */
    pack: { type: Object },
  };

  static styles = css`
    :host {
      position: fixed; inset: 0;
      display: grid; place-items: center;
      background: rgba(8, 10, 16, 0.85);
      z-index: 9999;
      font-family: system-ui, sans-serif;
      color: #f0f0f0;
    }
    .panel {
      width: min(520px, 92vw);
      background: #161b22;
      border: 1px solid #2a3140;
      border-radius: 10px;
      padding: 22px 26px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5);
    }
    h2 { margin: 0 0 6px 0; font-size: 18px; }
    .sub { color: #8a93a3; font-size: 12px; line-height: 1.5; margin-bottom: 14px; }
    .field {
      background: #0e1116;
      border: 1px solid #1f2630;
      border-radius: 5px;
      padding: 8px 10px;
      font-size: 12px;
      color: #cdd;
      margin: 8px 0;
      word-break: break-all;
    }
    .field .lbl { display: block; color: #8a93a3; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 3px; }
    .legal {
      font-size: 11px;
      color: #fbbf24;
      background: rgba(251, 191, 36, 0.08);
      border-left: 3px solid #fbbf24;
      padding: 8px 10px;
      border-radius: 4px;
      margin: 12px 0;
      line-height: 1.5;
    }
    .progress-row { margin: 14px 0; }
    .progress-label { display: flex; justify-content: space-between; font-size: 12px; color: #cdd; margin-bottom: 4px; }
    .progress-bar { background: #0e1116; border-radius: 4px; height: 10px; overflow: hidden; border: 1px solid #1f2630; }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #6c8cff, #a78bfa);
      transition: width 200ms ease-out;
    }
    .actions { display: flex; justify-content: space-between; gap: 10px; margin-top: 14px; }
    button {
      background: #1f262f; color: #e5e8ee;
      border: 1px solid #2a3140; border-radius: 6px;
      padding: 8px 16px; font: inherit; font-size: 13px;
      cursor: pointer;
    }
    button.primary { background: #6c8cff; border-color: #6c8cff; color: #0e1116; font-weight: 600; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #f87171; margin-top: 8px; font-size: 12px; }
  `;

  _emit(name, detail = null) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  _onDownload() {
    this._emit("consent");
  }
  _onSkip() {
    this._emit("skip");
  }
  _onRetry() {
    this._emit("consent"); // same wire path as the initial accept
  }
  _onClose() {
    this._emit("close");
  }

  _formatBytes(n) {
    if (!n && n !== 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  render() {
    const p = this.pack || {};
    const state = p.state || "available";
    const pct = Math.max(0, Math.min(100, Number(p.progress) || 0));
    const total = this._formatBytes(p.total_bytes);

    // Progress / extracting / ready / failed: render the running form.
    if (state === "downloading" || state === "extracting") {
      const label = state === "downloading" ? `Downloading ${total || ""}` : "Extracting…";
      return html`
        <div class="panel">
          <h2>Fetching ${p.label || "asset pack"}</h2>
          <div class="sub">Hold tight — this is a one-time download.</div>
          <div class="progress-row">
            <div class="progress-label">
              <span>${label}</span>
              <span>${pct}%</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width:${pct}%"></div>
            </div>
          </div>
        </div>
      `;
    }
    if (state === "failed") {
      return html`
        <div class="panel">
          <h2>Download failed</h2>
          <div class="error">${p.error || "Unknown error."}</div>
          <div class="actions">
            <button @click=${this._onClose}>Close</button>
            <button class="primary" @click=${this._onRetry}>Retry</button>
          </div>
        </div>
      `;
    }
    // Default: the consent prompt (state = available, or anything
    // we don't recognize — fall back to the safe ask-first flow).
    return html`
      <div class="panel">
        <h2>Need to download ${p.label || "asset pack"}</h2>
        <div class="sub">
          This game uses extra art and sounds that Foyer doesn't bundle.
          Clicking <strong>Download</strong> fetches them directly from
          the source URL below.
        </div>
        <div class="field">
          <span class="lbl">Source URL</span>
          ${p.source_url || ""}
        </div>
        ${p.credits ? html`
          <div class="field">
            <span class="lbl">Credits</span>
            ${p.credits}
          </div>
        ` : ""}
        ${p.license_note ? html`<div class="legal">${p.license_note}</div>` : ""}
        <div class="actions">
          <button @click=${this._onSkip}>Skip for now</button>
          <button class="primary" @click=${this._onDownload}>Download</button>
        </div>
      </div>
    `;
  }
}

customElements.define("sprunki-asset-pack-modal", SprunkiAssetPackModal);
