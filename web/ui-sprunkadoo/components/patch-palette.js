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
      flex-direction: column;
      align-items: center;
      padding: 4px 12px 12px;
      background: linear-gradient(180deg, #14172a 0%, #0c0e1b 100%);
      border-top: 1px solid rgba(255,255,255,0.06);
      transition: box-shadow 120ms ease;
      position: relative;
    }

    /* When the kid is dragging a sprunki on the stage toward the
       palette, the stage component flips this class on us. We
       pulse a red ring + a "drop to remove" label so the kid sees
       this is the drop zone for sending sprunkis home. */
    :host(.drag-remove-target) {
      box-shadow: 0 -2px 24px rgba(255, 80, 80, 0.55),
                  inset 0 0 0 3px rgba(255, 80, 80, 0.8);
      animation: drag-remove-pulse 700ms ease-in-out infinite;
    }
    :host(.drag-remove-target)::before {
      content: "Drop here to remove";
      position: absolute;
      top: -22px;
      left: 50%;
      transform: translateX(-50%);
      padding: 3px 12px;
      background: rgba(255, 80, 80, 0.92);
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border-radius: 999px;
      pointer-events: none;
    }
    @keyframes drag-remove-pulse {
      0%, 100% {
        box-shadow: 0 -2px 24px rgba(255, 80, 80, 0.45),
                    inset 0 0 0 3px rgba(255, 80, 80, 0.7);
      }
      50% {
        box-shadow: 0 -2px 36px rgba(255, 80, 80, 0.75),
                    inset 0 0 0 5px rgba(255, 80, 80, 0.95);
      }
    }
    /* Two rows of tiles laid out as a horizontal scroll. OG sprunki
       offsets every other row by ~half a tile so the rack reads as
       a "brick wall" / "shelf of plushies" — we match that by
       indenting the second row by (half tile + half gap). */
    .rack {
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 4px 8px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.18) transparent;
    }
    .rack-rows {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: max-content;
    }
    .rack-row {
      display: flex;
      gap: 12px;
    }
    .rack-row.row-2 {
      padding-left: 46px;
    }

    .tile {
      width: 80px;
      height: 80px;
      flex: 0 0 80px;
      border-radius: 14px;
      background: transparent;
      cursor: grab;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: transform 110ms cubic-bezier(0.2, 0.8, 0.2, 1.1),
                  filter 120ms ease, opacity 120ms ease;
      touch-action: none;
      position: relative;
      border: none;
    }
    .tile:hover {
      transform: translateY(-6px) scale(1.10);
      filter: drop-shadow(0 6px 14px rgba(0,0,0,0.45));
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
    /* No-art fallback chip — used when the OG asset pack hasn't
       resolved (or isn't installed). Colored circle keyed to the
       patch's accent color with the label's first letter centered. */
    .tile-chip {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--tc, #2a2e44);
      color: #fff;
      border-radius: 14px;
      font-size: 30px;
      font-weight: 700;
      line-height: 1;
      pointer-events: none;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10);
      text-shadow: 0 1px 1px rgba(0,0,0,0.45);
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
    // Ghost image: a colored chip matching the tile look.
    const ghost = document.createElement("div");
    ghost.textContent = (patch.label || "?").charAt(0).toUpperCase();
    ghost.style.cssText = `
      font:700 28px system-ui,sans-serif;color:#fff;
      width:56px;height:56px;display:flex;
      align-items:center;justify-content:center;
      background:${patch.color};border-radius:12px;
      box-shadow:inset 0 0 0 1px rgba(255,255,255,0.18);
      text-shadow:0 1px 1px rgba(0,0,0,0.45);
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
            : html`<span class="tile-chip">${(patch.label || "?").charAt(0).toUpperCase()}</span>`}
        </div>
      </div>
    `;
  }

  render() {
    // Split the visible cast into two rows for the OG-style
    // staggered rack. Row 1 = first half, row 2 = second half
    // offset by half-a-tile.
    const split = Math.ceil(PATCHES.length / 2);
    const row1 = PATCHES.slice(0, split);
    const row2 = PATCHES.slice(split);
    return html`
      <div class="rack">
        <div class="rack-rows">
          <div class="rack-row row-1">${row1.map((p) => this._renderTile(p))}</div>
          <div class="rack-row row-2">${row2.map((p) => this._renderTile(p))}</div>
        </div>
      </div>
    `;
  }
}

customElements.define("sprunki-patch-palette", PatchPalette);
