// SPDX-License-Identifier: Apache-2.0
//
// Windows FAB — tear-out presentation of the open-windows list
// (`<foyer-window-list>`). Was a fixed rail button on the right-dock;
// now a dockable FAB so the user can float it if they prefer.

import { html } from "lit";
import "foyer-ui-core/widgets/window-list.js";
import { icon } from "foyer-ui-core/icons.js";
import { QuadrantFab } from "./quadrant-fab.js";

export class FoyerWindowsFab extends QuadrantFab {
  constructor() {
    super();
    this.storageKey = "foyer.windows";
    this._fabTitle = "Windows";
    this._fabAccent = "accent-2";
  }

  _dockMeta() {
    return {
      label: "Windows",
      icon: "squares-2x2",
      accent: this._fabAccent,
      expandsRail: false,
      defaultDocked: true,
    };
  }

  _renderFabContent() {
    return icon("squares-2x2", 22);
  }

  _renderPanelContent() {
    return html`<foyer-window-list></foyer-window-list>`;
  }
}

customElements.define("foyer-windows-fab", FoyerWindowsFab);
