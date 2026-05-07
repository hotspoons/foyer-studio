// Thin mixer strip dedicated to the metronome click.
//
// Visibility is a per-client UI preference — the mixer's config
// popup carries the toggle (the strip belongs to the mixer surface,
// not to the global transport bar). The strip itself drives engine
// state via the M button (toggles `transport.metronome` = clicking
// on/off). When muted, the fader greys out — the user's gain value
// is preserved on the backend; the engine just isn't emitting click.
//
// Layout target: ~35 px wide; the column structure mirrors the
// regular track-strip's flex order (swatch · header · M · spacer ·
// body) so the M button and the fader bottom land at the same Y as
// the track strips it docks beside. Decorative-only structural
// pieces are explicit (with the same heights as their track-strip
// counterparts) — that's what was missing in the first pass and is
// what makes the strip read as "part of the mixer" instead of
// floating up at the top.

import { LitElement, html, css } from "lit";

import "foyer-ui-core/widgets/toggle.js";
import "foyer-ui-core/widgets/fader.js";
import "foyer-ui-core/widgets/meter.js";
import { ControlController } from "foyer-core/store.js";
import { icon } from "foyer-ui-core/icons.js";

function normToDb(n) {
  n = Math.max(0, Math.min(1, n));
  if (n <= 0.0001) return -60;
  if (n <= 0.75) return -60 + (n / 0.75) * 60;
  return ((n - 0.75) / 0.25) * 6;
}
function dbToNorm(db) {
  if (db <= -60) return 0;
  if (db <= 0) return ((db + 60) / 60) * 0.75;
  return 0.75 + (Math.min(6, db) / 6) * 0.25;
}

export class MetronomeStrip extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      width: 35px;
      flex: 0 0 35px;
      padding: 8px 2px;
      gap: 6px;
      box-sizing: border-box;
      border-right: 1px solid var(--color-border);
      background: linear-gradient(180deg,
        color-mix(in oklab, #d8b673 12%, var(--color-surface-elevated)),
        color-mix(in oklab, #d8b673 6%, var(--color-surface)));
    }
    /* 1) Swatch — same 3 px height as the track-strip color bar; the
     *    metronome's identity color is the gold tint, picked so a
     *    quick scan reads "different category, not a track". */
    .swatch {
      height: 3px;
      flex: 0 0 3px;
      border-radius: 2px;
      margin: 0 1px;
      background: linear-gradient(90deg, #d8b673, #b8964c);
    }
    /* 2) Header block — invisible spacer that mimics the
     *    name + kind row on a track strip (~35 px on the default
     *    density). The metronome icon centers inside it so the
     *    glyph reads as the "name" of this column without forcing
     *    text into the 35 px width budget. */
    .header {
      flex: 0 0 35px;
      height: 35px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: color-mix(in oklab, #d8b673 80%, var(--color-text-muted));
    }
    /* 3) M row — same single foyer-toggle the regular strips use, so
     *    the button glyph + height match exactly. */
    .m-row {
      flex: 0 0 auto;
      display: flex;
      justify-content: center;
    }
    /* 4) Mid-spacer — fills the gap that AUTO/IN/DISK + plugin list
     *    + Pan ▼ occupy on a track strip. flex:1 means the body
     *    docks to the bottom regardless of mixer height, matching
     *    track-strip behavior. */
    .spacer {
      flex: 1 1 auto;
      min-height: 0;
    }
    /* 5) Body — fader + meter, height pinned to the same intrinsic
     *    height as the track-strip's body (foyer-fader's 150 px
     *    track + label). Bottom-aligned via align-items: flex-end
     *    so any leftover space goes above. */
    .body {
      flex: 0 0 auto;
      display: flex;
      flex-direction: row;
      align-items: flex-end;
      justify-content: center;
      gap: 4px;
    }
    /* The body's mute-state styling is on the fader/meter children
     * via their own opacity, not on the body container — so the
     * cursor target stays the fader, not the gap around it. */
    foyer-fader {
      flex: 0 0 auto;
    }
    foyer-fader.muted {
      opacity: 0.4;
      pointer-events: none;
    }
    foyer-meter {
      width: 6px;
      flex: 0 0 6px;
    }
    foyer-meter.muted {
      opacity: 0.4;
    }
  `;

  constructor() {
    super();
    this._gainCtl = null;
    this._enableCtl = null;
    this._meterCtl = null;
  }

  connectedCallback() {
    super.connectedCallback();
    const store = window.__foyer?.store;
    this._gainCtl = new ControlController(this, store, "metronome.gain");
    this._enableCtl = new ControlController(this, store, "transport.metronome");
    this._meterCtl = new ControlController(this, store, "metronome.meter");
  }

  render() {
    const gainDb = Number(this._gainCtl?.value ?? 0);
    const norm = dbToNorm(gainDb);
    // Clicking ON → M is NOT lit. Clicking OFF → M lit (user reads
    // it as "muted"). This is the regular track-strip M semantic.
    const clickingOn = !!this._enableCtl?.value;
    const muted = !clickingOn;
    const meterDb = Number(this._meterCtl?.value ?? -60);
    return html`
      <div class="swatch"></div>
      <div class="header" title="Metronome">${icon("metronome", 16)}</div>
      <div class="m-row">
        <foyer-toggle tone="mute" label="M" .on=${muted}
          title=${muted
            ? "Metronome muted — click to enable click output"
            : "Mute metronome (engine stops clicking; strip stays open)"}
          @input=${this._onMuteToggle}></foyer-toggle>
      </div>
      <div class="spacer"></div>
      <div class="body">
        <foyer-fader
          class=${muted ? "muted" : ""}
          .value=${norm}
          .label=${muted ? "—" : `${gainDb.toFixed(1)} dB`}
          @input=${this._onFaderInput}
          @reset=${this._onFaderReset}
        ></foyer-fader>
        <foyer-meter
          class=${muted ? "muted" : ""}
          .value=${muted ? -60 : meterDb}
          height="150"
        ></foyer-meter>
      </div>
    `;
  }

  _onMuteToggle = (ev) => {
    const wantMuted = !!ev.detail?.value;
    window.__foyer?.ws?.controlSet("transport.metronome", wantMuted ? 0 : 1);
  };

  _onFaderInput = (ev) => {
    if (!this._enableCtl?.value) return;        // muted — read-only
    const v = Number(ev.detail?.value);
    if (!Number.isFinite(v)) return;
    window.__foyer?.ws?.controlSet("metronome.gain", normToDb(v));
  };

  _onFaderReset = () => {
    if (!this._enableCtl?.value) return;
    window.__foyer?.ws?.controlSet("metronome.gain", 0);
  };
}
customElements.define("foyer-metronome-strip", MetronomeStrip);
