// SPDX-License-Identifier: Apache-2.0
//
// <foyer-spectrum-tile> — tile-layer wrapper around the
// `<foyer-spectrum>` analyser widget. Adds a small target picker
// (Master / Monitor / individual track) so the tile is useful
// stand-alone without the user editing layout props.

import { LitElement, html, css } from "lit";
import "foyer-ui-core/viz/spectrum.js";

export class FoyerSpectrumTile extends LitElement {
  static properties = {
    /// Session snapshot passed in by the tile-leaf so we can populate
    /// the per-track entries.
    session: { attribute: false },
    /// Optional initial target override from layout props.
    target: { attribute: false },
    /// Optional channel override (0 / 1 / null = overlay).
    channel: { type: Number },
    /// Currently-selected target. Kept on the element so the picker
    /// can rebind the inner spectrum widget without involving layout.
    _target: { state: true },
    /// `true` while the picker dropdown is open.
    _pickerOpen: { state: true, type: Boolean },
  };

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background: var(--color-surface, #0e0e12);
      color: var(--color-text, #e2e2e8);
      box-sizing: border-box;
    }
    .root {
      display: flex; flex-direction: column;
      width: 100%; height: 100%;
    }
    .toolbar {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 8px;
      padding: 4px 8px;
      border-bottom: 1px solid var(--color-border, #2e2e36);
      font-size: 11px;
      color: var(--color-text-muted, #a1a1aa);
    }
    .toolbar select {
      background: var(--color-surface-elevated, #18181d);
      color: var(--color-text, #e2e2e8);
      border: 1px solid var(--color-border, #2e2e36);
      border-radius: var(--radius-sm, 4px);
      padding: 2px 6px;
      font: inherit;
      font-size: 11px;
    }
    .body {
      flex: 1 1 auto;
      min-height: 0;
    }
    foyer-spectrum {
      width: 100%; height: 100%;
    }
  `;

  constructor() {
    super();
    this.session = null;
    this.target = null;
    this.channel = 0;
    this._target = { kind: "master" };
    this._pickerOpen = false;
  }

  updated(changed) {
    super.updated?.(changed);
    if (changed.has("target") && this.target) {
      this._target = this.target;
    }
  }

  _onTargetSelect(ev) {
    const value = ev.currentTarget.value;
    if (value === "master") this._target = { kind: "master" };
    else if (value === "monitor") this._target = { kind: "monitor" };
    else if (value.startsWith("track:")) {
      this._target = { kind: "track", id: value.slice("track:".length) };
    }
  }

  _trackOptions() {
    const tracks = this.session?.tracks || [];
    return tracks
      .filter((t) => t.kind !== "midi")
      .map((t) => ({ id: t.id, name: t.name || t.id }));
  }

  _currentValue() {
    const t = this._target;
    if (!t) return "master";
    if (t.kind === "master") return "master";
    if (t.kind === "monitor") return "monitor";
    if (t.kind === "track") return `track:${t.id}`;
    return "master";
  }

  render() {
    const tracks = this._trackOptions();
    return html`
      <div class="root">
        <div class="toolbar">
          <span>Source</span>
          <select @change=${this._onTargetSelect} .value=${this._currentValue()}>
            <option value="master" ?selected=${this._currentValue() === "master"}>Master</option>
            <option value="monitor" ?selected=${this._currentValue() === "monitor"}>Monitor</option>
            ${tracks.map((t) => html`
              <option value=${`track:${t.id}`} ?selected=${this._currentValue() === `track:${t.id}`}>
                ${t.name}
              </option>
            `)}
          </select>
        </div>
        <div class="body">
          <foyer-spectrum
            .target=${this._target}
            .channel=${this.channel}
          ></foyer-spectrum>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("foyer-spectrum-tile")) {
  customElements.define("foyer-spectrum-tile", FoyerSpectrumTile);
}
