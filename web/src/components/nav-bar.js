// Top-level navigation between surfaces: mixer, timeline, plugins, projects.
// Hash-routed — setting `location.hash` switches the visible surface.
//
// Note: the view id "session" is kept for backward-compat with saved layouts;
// the user-facing label is "Projects" because this surface is a project
// picker, not a view of the currently-loaded session (which is what the
// right-dock "Session" info panel shows).

import { LitElement, html, css } from "lit";
import { icon } from "../icons.js";

export const VIEWS = [
  { id: "mixer",    label: "Mixer",    icon: "adjustments-horizontal" },
  { id: "timeline", label: "Timeline", icon: "list-bullet" },
  { id: "plugins",  label: "Plugins",  icon: "puzzle-piece" },
  { id: "session",  label: "Projects", icon: "folder-open" },
];

export function currentView() {
  const h = (location.hash || "#mixer").replace(/^#/, "").split("/")[0];
  return VIEWS.some(v => v.id === h) ? h : "mixer";
}

export class NavBar extends LitElement {
  static properties = {
    active: { type: String },
  };

  static styles = css`
    :host {
      display: flex;
      gap: 4px;
      padding: 6px 14px;
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
    }
    button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font: inherit;
      font-family: var(--font-sans);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      padding: 4px 10px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    button:hover {
      color: var(--color-text);
      background: var(--color-surface-elevated);
    }
    button.active {
      color: #fff;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      border-color: transparent;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.35);
    }
  `;

  render() {
    return html`
      ${VIEWS.map(v => html`
        <button
          class=${v.id === this.active ? "active" : ""}
          @click=${() => { location.hash = v.id; }}
          title=${v.label}
        >
          ${icon(v.icon, 14)}
          <span>${v.label}</span>
        </button>
      `)}
    `;
  }
}
customElements.define("foyer-nav-bar", NavBar);
