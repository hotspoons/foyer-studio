import { LitElement, html, css } from "lit";

export class Toggle extends LitElement {
  static properties = {
    on: { type: Boolean, reflect: true },
    label: { type: String },
    tone: { type: String }, // "mute" | "solo" | "rec" | "default"
  };

  static styles = css`
    :host { display: inline-block; }
    button {
      font: inherit;
      font-family: var(--font-sans);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      padding: 3px 9px;
      min-width: 34px;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text-muted);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    button:hover {
      color: var(--color-text);
      border-color: var(--color-accent);
      transform: translateY(-1px);
    }
    button:active { transform: translateY(0); }
    :host([on]) button {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.35);
    }
    /* Tone palette matches the timeline's lane-ctl-btn styling so the
     * mixer + timeline read as one consistent surface. Mixer keeps
     * the soft drop-shadow glow that the timeline doesn't have, but
     * the actual color identity per tone is unified:
     *   mute → warning yellow (was danger red — collided with rec)
     *   solo → #dece5c (timeline's distinct yellow-green)
     *   rec  → danger red */
    :host([on][tone="mute"]) button {
      background: var(--color-warning);
      color: #0f172a;
      box-shadow: 0 2px 8px color-mix(in oklab, var(--color-warning) 45%, transparent);
    }
    :host([on][tone="solo"]) button {
      background: #dece5c;
      color: #0f172a;
      box-shadow: 0 2px 8px rgba(222, 206, 92, 0.45);
    }
    :host([on][tone="rec"])  button {
      background: var(--color-danger);
      color: #fff;
      box-shadow: 0 2px 8px rgba(239, 68, 68, 0.35);
    }
  `;

  constructor() {
    super();
    this.on = false;
    this.label = "";
    this.tone = "default";
  }

  render() {
    return html`<button @click=${this._click}>${this.label}</button>`;
  }

  _click() {
    const next = !this.on;
    this.dispatchEvent(new CustomEvent("input", {
      detail: { value: next },
      bubbles: true,
      composed: true,
    }));
  }
}
customElements.define("foyer-toggle", Toggle);
