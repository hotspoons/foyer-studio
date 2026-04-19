// Recursive tile container — renders a tile tree with draggable splitters.
// All structural state lives in LayoutStore; this component just reads, renders,
// and dispatches ops back to the store.

import { LitElement, html, css } from "lit";

import { DIR } from "./tile-tree.js";
import "./tile-leaf.js";

export class TileContainer extends LitElement {
  static properties = {
    node: { type: Object },
    store: { type: Object },
  };

  static styles = css`
    :host {
      display: flex;
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
    }
    :host([direction="row"])    { flex-direction: row; }
    :host([direction="column"]) { flex-direction: column; }

    .splitter {
      flex: 0 0 auto;
      background: var(--color-border);
      opacity: 0.5;
      transition: opacity 0.12s ease, background 0.12s ease;
    }
    .splitter:hover, .splitter.active {
      opacity: 1;
      background: var(--color-accent);
    }
    .splitter.row    { width: 4px; cursor: col-resize; }
    .splitter.column { height: 4px; cursor: row-resize; }
  `;

  render() {
    const n = this.node;
    if (!n) return html``;
    if (n.kind === "leaf") {
      return html`<foyer-tile-leaf .leaf=${n} .store=${this.store}></foyer-tile-leaf>`;
    }
    this.setAttribute("direction", n.direction);
    const children = [];
    for (let i = 0; i < n.children.length; i++) {
      const child = n.children[i];
      const flex = `${n.ratios[i] || (1 / n.children.length)}`;
      children.push(html`
        <div style="flex: ${flex} 1 0; min-width:0; min-height:0; display:flex;"
             @click=${(e) => this._onChildClick(e, child)}>
          <foyer-tile-container .node=${child} .store=${this.store}></foyer-tile-container>
        </div>
      `);
      if (i < n.children.length - 1) {
        const edgeIndex = i;
        children.push(html`
          <div class="splitter ${n.direction}"
               @pointerdown=${(e) => this._startResize(e, n, edgeIndex)}></div>
        `);
      }
    }
    return children;
  }

  _onChildClick(ev, child) {
    // Bubble up to the shell via store.focus once the leaf click lands.
    void ev; void child;
  }

  _startResize(ev, node, edgeIndex) {
    ev.preventDefault();
    ev.stopPropagation();
    const target = ev.currentTarget;
    target.classList.add("active");
    try { target.setPointerCapture(ev.pointerId); } catch {}
    const rect = this.getBoundingClientRect();
    const isRow = node.direction === DIR.ROW;
    const total = isRow ? rect.width : rect.height;
    let lastPos = isRow ? ev.clientX : ev.clientY;

    const onMove = (e) => {
      const cur = isRow ? e.clientX : e.clientY;
      const delta = (cur - lastPos) / total;
      if (Math.abs(delta) < 0.001) return;
      this.store.resize(node.id, edgeIndex, delta);
      lastPos = cur;
    };
    const onUp = () => {
      target.classList.remove("active");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
}
customElements.define("foyer-tile-container", TileContainer);
