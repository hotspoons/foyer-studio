// Top-level navigation between surfaces: mixer, timeline, plugins, projects.
// Hash-routed — setting `location.hash` switches the visible surface.
//
// Note: the view id "session" is kept for backward-compat with saved layouts;
// the user-facing label is "Projects" because this surface is a project
// picker, not a view of the currently-loaded session (which is what the
// right-dock "Session" info panel shows).

import { LitElement, html, css } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { registerView, listViews, currentView } from "foyer-core/registry/views.js";

// Register the shipping UI's view catalog. Alternate UIs declare
// their own set (or override individual entries by re-registering
// with the same id + their own label/icon/order).
// Tile-class views only. Plugins / Console / Diagnostics moved to the
// widgets layer (right-dock spawn menu); Projects is a modal
// (`<foyer-project-picker-modal>`), reachable from the welcome screen
// + Session menu rather than living in this list.
const DEFAULT_VIEWS = [
  { id: "mixer",    label: "Mixer",    icon: "adjustments-horizontal", order: 10, elementTag: "foyer-mixer" },
  { id: "timeline", label: "Timeline", icon: "list-bullet",            order: 20, elementTag: "foyer-timeline-view" },
];
for (const v of DEFAULT_VIEWS) registerView(v);

/** Re-export so callers that imported VIEWS keep working. */
export const VIEWS = DEFAULT_VIEWS;
export { currentView };

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
