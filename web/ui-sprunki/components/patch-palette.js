// Patch palette — the costume-tile rack at the bottom of the
// stage. One tile per entry in `patches.js`. The kid drags a tile
// up onto the stage to assign that patch to a sprunki (or spawn a
// new sprunki on bare stage). Identity mirror of OG sprunki's
// bottom-of-screen costume row.
//
// Drag payload: `application/x-sprunki-patch` carries the patch id.
// The stage component listens for that MIME type; nothing else on
// the page should claim it.

import { LitElement, html, css } from "lit";
import { PATCHES } from "../patches.js";
import { iconUrlFor } from "../sprunki-assets.js";

export class PatchPalette extends LitElement {
  static styles = css`
    /* OG-style costume rack: 2 rows × N columns of OG icon
       tiles. The icon SVG itself already carries the colored
       background; the tile is just a transparent square hosting
       the icon. We use the dimmed variant when a patch is
       already on stage (matches OG's "in use" treatment). */
    :host {
      display: flex;
      justify-content: center;
      padding: 8px 12px 12px;
      background: linear-gradient(180deg, #14172a 0%, #0c0e1b 100%);
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .rack {
      display: grid;
      grid-template-rows: repeat(2, 56px);
      grid-auto-flow: column;
      grid-auto-columns: 56px;
      gap: 4px;
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 2px 4px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.18) transparent;
    }

    .tile {
      width: 56px;
      height: 56px;
      border-radius: 10px;
      background: transparent;
      cursor: grab;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: transform 80ms ease, filter 100ms ease, opacity 100ms ease;
      touch-action: none;
      position: relative;
      border: none;
    }
    .tile:hover {
      transform: translateY(-2px) scale(1.04);
      filter: drop-shadow(0 4px 8px rgba(0,0,0,0.35));
    }
    .tile:active { cursor: grabbing; transform: scale(0.96); }
    .tile.used {
      cursor: not-allowed;
      opacity: 0.55;
      filter: grayscale(0.95);
      transform: none;
    }
    .tile.used:hover { transform: none; }

    .tile-art {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    .tile-art img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      pointer-events: none;
    }
    .tile-emoji {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--tc, #2a2e44);
      border-radius: 10px;
      font-size: 28px;
      line-height: 1;
      pointer-events: none;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
    }
  `;

  static properties = {
    assetsReady: { type: Boolean },
    /** Patch ids currently on stage (any slot). Tiles for these
     *  patches render dimmed + un-draggable. The parent app
     *  computes this on every stage-changed event. */
    usedPatchIds: { type: Object },
  };

  constructor() {
    super();
    this.assetsReady = false;
    this.usedPatchIds = new Set();
  }

  _onDragStart(e, patch) {
    if (this.usedPatchIds?.has?.(patch.id)) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/x-sprunki-patch", patch.id);
    e.dataTransfer.setData("text/plain", patch.id);
    // Ghost image: match the tile look.
    const ghost = document.createElement("div");
    ghost.textContent = patch.emoji || "🎵";
    ghost.style.cssText = `
      font-size:36px;width:56px;height:56px;display:flex;
      align-items:center;justify-content:center;
      background:${patch.color}55;border-radius:12px;
      position:absolute;top:-1000px;
    `;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 28, 28);
    requestAnimationFrame(() => ghost.remove());
  }

  _renderTile(patch) {
    const used = this.usedPatchIds?.has?.(patch.id);
    // OG ships three icon variants per character; we pick the
    // dimmed/grayscale one for "already on stage" tiles so the
    // visual language matches OG's "in use" treatment exactly.
    const variant = used ? "dimmed" : "normal";
    const art = this.assetsReady ? iconUrlFor(patch.sprunki_id, variant) : null;
    return html`
      <div
        class="tile ${used ? "used" : ""}"
        draggable=${used ? "false" : "true"}
        style="--tc: ${patch.color}"
        title=${used ? `${patch.label} — already on stage` : patch.label}
        @dragstart=${(e) => this._onDragStart(e, patch)}
      >
        <div class="tile-art">
          ${art
            ? html`<img src=${art} alt=${patch.label} draggable="false" />`
            : html`<span class="tile-emoji">${patch.emoji}</span>`}
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div class="rack">
        ${PATCHES.map((p) => this._renderTile(p))}
      </div>
    `;
  }
}

customElements.define("sprunki-patch-palette", PatchPalette);
