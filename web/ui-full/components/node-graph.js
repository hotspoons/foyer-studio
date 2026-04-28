// Generic SVG node-graph editor.
//
// Ported from zip-ties' zt-dag-canvas (agent cadre builder). Kept the
// rendering primitives — nodes, handles, curved edges, pan/zoom/drag —
// and dropped the agent/cell/cadre-specific semantics so this can host
// any wiring UI (audio routing, plugin sidechains, automation chains, …).
//
// Data model:
//   nodes: [{
//     id:     string              — unique
//     label:  string              — primary title
//     sub?:   string              — subtitle line
//     x, y:   number              — top-left in graph coordinates
//     w?, h?: number              — default from node sizing constants
//     kind?:  "audio" | "midi" | "control" | string
//     inputs:  [{ id, label?, color? }]   — left-side ports (top → bottom)
//     outputs: [{ id, label?, color? }]   — right-side ports
//     color?: string              — border accent
//     selected?: boolean          — consumers can drive selection too
//   }]
//   edges: [{
//     id?:  string
//     from: { node: string, port: string }
//     to:   { node: string, port: string }
//     color?: string
//   }]
//
// Events:
//   node-select  detail: { id, multi: boolean, selected: string[] }
//   node-move    detail: { id, x, y, final: boolean }
//   edge-create  detail: { from: {node,port}, to: {node,port} }
//   edge-remove  detail: { id?, from: {node,port}, to: {node,port} }
//   canvas-pan   detail: { vbX, vbY, zoom }   (persistable hint)
//
// Backward-edge curve config (tuned via web/debug-curves.html — which is a
// self-contained bakeoff page with sliders). Change the active style /
// config by patching the two statics below.

import { LitElement, html, svg, css, nothing } from "lit";

const NODE_W_DEFAULT = 180;
const NODE_H_MIN = 56;
const PORT_ROW_H = 18;
const PORT_PAD_Y = 12;   // top/bottom padding inside a node before the first/last port
const HEADER_H = 30;
const HANDLE_R = 5;

/** Backward-edge curve-style bakeoff. */
const CURVE_STYLES = {
  "two-segment": (sx, sy, tx, ty, cfg) => {
    const { turnR = 50, spreadBase = 0.3, vOffBase = 0.25, vOffMin = 50 } = cfg;
    const gap = Math.abs(tx - sx);
    const spread = Math.max(turnR, gap * spreadBase + turnR);
    const vOff = Math.abs(ty - sy) * vOffBase + vOffMin;
    const midX = (sx + tx) / 2;
    const midY = (sy + ty) / 2;
    const loopY = sy <= ty ? midY - vOff : midY + vOff;
    return `M ${sx} ${sy} C ${sx + turnR} ${sy}, ${sx + spread} ${loopY}, ${midX} ${loopY} C ${tx - spread} ${loopY}, ${tx - turnR} ${ty}, ${tx} ${ty}`;
  },
  "wide-arc": (sx, sy, tx, ty, cfg) => {
    const { turnR = 60, loopMinY = 80, vScale = 0.5 } = cfg;
    const gap = Math.abs(tx - sx);
    const vDist = Math.abs(ty - sy);
    const vOff = Math.max(loopMinY, vDist * vScale + gap * 0.2);
    const midX = (sx + tx) / 2;
    const minEndY = Math.min(sy, ty);
    const loopY = minEndY - vOff;
    return `M ${sx} ${sy} C ${sx + turnR} ${sy}, ${midX + turnR} ${loopY}, ${midX} ${loopY} C ${midX - turnR} ${loopY}, ${tx - turnR} ${ty}, ${tx} ${ty}`;
  },
  "rounded-rect": (sx, sy, tx, ty, cfg) => {
    const { padX = 40, padY = 60, cornerR = 25 } = cfg;
    const rightX = Math.max(sx, tx) + padX;
    const topY = Math.min(sy, ty) - padY;
    const cr = Math.min(cornerR,
      (rightX - sx) / 2, Math.abs(sy - topY) / 2,
      Math.abs(rightX - tx) / 2, Math.abs(ty - topY) / 2);
    return [
      `M ${sx} ${sy}`,
      `L ${rightX - cr} ${sy}`,
      `Q ${rightX} ${sy}, ${rightX} ${sy + (topY < sy ? -cr : cr)}`,
      `L ${rightX} ${topY + (topY < sy ? cr : -cr)}`,
      `Q ${rightX} ${topY}, ${rightX - cr} ${topY}`,
      `L ${tx - padX + cr} ${topY}`,
      `Q ${tx - padX} ${topY}, ${tx - padX} ${topY + cr}`,
      `L ${tx - padX} ${ty - (topY < ty ? cr : -cr)}`,
      `Q ${tx - padX} ${ty}, ${tx - padX + cr} ${ty}`,
      `L ${tx} ${ty}`,
    ].join(" ");
  },
  "smooth-cubic": (sx, sy, tx, ty, cfg) => {
    const { hSpread = 80, vMin = 70, vGapScale = 0.4 } = cfg;
    const gap = Math.abs(tx - sx);
    const vOff = Math.max(vMin, Math.abs(ty - sy) * vGapScale + gap * 0.15);
    const loopY = Math.min(sy, ty) - vOff;
    return `M ${sx} ${sy} C ${sx + hSpread} ${loopY}, ${tx - hSpread} ${loopY}, ${tx} ${ty}`;
  },
};

// Winner of the debug-curves bakeoff (tuned by Rich).
const DEFAULT_CURVE_STYLE = "two-segment";
const DEFAULT_CURVE_CONFIG = { turnR: 101, spreadBase: 0, vOffBase: 0, vOffMin: 20 };

function portColor(kind, override) {
  if (override) return override;
  switch (kind) {
    case "midi":    return "var(--color-accent-3)";
    case "control": return "var(--color-warning)";
    case "audio":   return "var(--color-accent)";
    default:        return "var(--color-text-muted)";
  }
}

function nodeSize(node) {
  const inN = (node.inputs || []).length;
  const outN = (node.outputs || []).length;
  const rows = Math.max(inN, outN);
  const h = Math.max(NODE_H_MIN, HEADER_H + PORT_PAD_Y * 2 + rows * PORT_ROW_H);
  const w = node.w || NODE_W_DEFAULT;
  return { w, h: node.h || h };
}

/** Resolve a port anchor in node-local coords. */
function portY(node, portId, side) {
  const list = side === "in" ? node.inputs : node.outputs;
  const idx = (list || []).findIndex(p => p.id === portId);
  if (idx < 0) return HEADER_H + PORT_PAD_Y;
  return HEADER_H + PORT_PAD_Y + idx * PORT_ROW_H + PORT_ROW_H / 2;
}

export class NodeGraph extends LitElement {
  static properties = {
    nodes:        { type: Array },
    edges:        { type: Array },
    readonly:     { type: Boolean },
    curveStyle:   { type: String,  attribute: "curve-style" },
    curveConfig:  { type: Object },
    _vbX:         { state: true },
    _vbY:         { state: true },
    _vbW:         { state: true },
    _vbH:         { state: true },
    _zoom:        { state: true },
    _posOffsets:  { state: true },
    _selected:    { state: true },
    _dragging:    { state: true },
    _nodeDrag:    { state: true },
    _panning:     { state: true },
  };

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: relative;
      background: var(--color-surface);
      color: var(--color-text);
      font-family: var(--font-sans);
      overflow: hidden;
      user-select: none;
    }
    svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .dot-grid {
      fill: color-mix(in oklab, var(--color-text-muted) 30%, transparent);
    }
    .node-rect {
      fill: var(--color-surface-elevated);
      stroke: var(--color-border);
      stroke-width: 1;
      transition: stroke 0.12s ease;
    }
    .node-rect.selected { stroke: var(--color-accent); stroke-width: 2; }
    .node-header {
      fill: color-mix(in oklab, var(--color-surface-muted) 80%, transparent);
    }
    .node-title {
      fill: var(--color-text);
      font-weight: 600;
      font-size: 12px;
      pointer-events: none;
    }
    .node-sub {
      fill: var(--color-text-muted);
      font-size: 10px;
      pointer-events: none;
    }
    .port-label {
      fill: var(--color-text-muted);
      font-size: 10px;
      pointer-events: none;
    }
    .handle {
      stroke-width: 1.5;
      cursor: crosshair;
      transition: r 0.1s ease, stroke-width 0.1s ease;
    }
    .handle:hover { stroke-width: 2.5; }
    .edge {
      fill: none;
      stroke: var(--color-text-muted);
      stroke-opacity: 0.6;
      stroke-width: 1.5;
      pointer-events: none;
    }
    .edge.selected {
      stroke: var(--color-accent);
      stroke-opacity: 1;
      stroke-width: 2;
    }
    .edge-hit {
      fill: none;
      stroke: transparent;
      stroke-width: 12;
      cursor: pointer;
    }
    .edge-ghost {
      stroke: var(--color-accent);
      stroke-width: 2;
      stroke-dasharray: 6 4;
      fill: none;
      pointer-events: none;
    }
    .zoom-chip {
      position: absolute;
      top: 8px; right: 8px;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--color-text-muted);
      background: color-mix(in oklab, var(--color-surface-elevated) 80%, transparent);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      pointer-events: none;
    }
  `;

  constructor() {
    super();
    this.nodes = [];
    this.edges = [];
    this.readonly = false;
    this.curveStyle = DEFAULT_CURVE_STYLE;
    this.curveConfig = { ...DEFAULT_CURVE_CONFIG };
    this._vbX = 0;
    this._vbY = 0;
    this._vbW = 0;
    this._vbH = 0;
    this._zoom = 1;
    this._posOffsets = new Map();
    this._selected = new Set();
    this._dragging = null;  // edge creation — { from: {node,port}, x1, y1, x2, y2 }
    this._nodeDrag = null;  // { id, startPt, origX, origY, moved }
    this._panning = null;   // { startX, startY, origVbX, origVbY }
    this._onMove = this._onPointerMove.bind(this);
    this._onUp = this._onPointerUp.bind(this);
  }

  firstUpdated() {
    this._autoFit();
  }

  updated(changed) {
    if (changed.has("nodes") && this._vbW === 0) this._autoFit();
  }

  _autoFit() {
    const bb = this._bbox();
    if (!bb) return;
    const pad = 48;
    this._vbX = bb.x - pad;
    this._vbY = bb.y - pad;
    this._vbW = Math.max(400, bb.w + pad * 2);
    this._vbH = Math.max(300, bb.h + pad * 2);
  }

  _bbox() {
    if (!this.nodes?.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) {
      const { w, h } = nodeSize(n);
      const p = this._pos(n);
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + w);
      y1 = Math.max(y1, p.y + h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  _pos(node) {
    const off = this._posOffsets.get(node.id);
    if (!off) return { x: node.x, y: node.y };
    return { x: node.x + off.dx, y: node.y + off.dy };
  }

  _svgPoint(ev) {
    const svgEl = this.renderRoot?.querySelector("svg");
    if (!svgEl) return { x: ev.clientX, y: ev.clientY };
    const pt = svgEl.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return { x: ev.clientX, y: ev.clientY };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  /* ── Interaction ── */

  _onSvgMouseDown(ev) {
    if (ev.button !== 0) return;
    if (ev.shiftKey || ev.target.tagName === "svg" || ev.target.classList.contains("dag-bg")) {
      this._startPan(ev);
      if (ev.target.tagName === "svg" || ev.target.classList.contains("dag-bg")) {
        if (!(ev.ctrlKey || ev.metaKey)) {
          this._selected = new Set();
          this.requestUpdate();
        }
      }
    }
  }

  _startPan(ev) {
    ev.preventDefault();
    this._panning = {
      startX: ev.clientX,
      startY: ev.clientY,
      origVbX: this._vbX,
      origVbY: this._vbY,
    };
    window.addEventListener("pointermove", this._onMove);
    window.addEventListener("pointerup", this._onUp);
  }

  _onNodeDown(ev, node) {
    if (this.readonly) return;
    if (ev.shiftKey) return;  // shift+drag always pans
    if (ev.target.classList.contains("handle")) return;
    ev.preventDefault();
    ev.stopPropagation();
    const pt = this._svgPoint(ev);
    const pos = this._pos(node);
    this._nodeDrag = {
      id: node.id,
      startPt: pt,
      origX: pos.x,
      origY: pos.y,
      moved: false,
      group: new Map(),  // id -> origPos for multi-select drag
    };
    if (!this._selected.has(node.id) && !(ev.ctrlKey || ev.metaKey)) {
      this._selected = new Set([node.id]);
    }
    for (const sid of this._selected) {
      if (sid === node.id) continue;
      const sn = this.nodes.find(n => n.id === sid);
      if (sn) this._nodeDrag.group.set(sid, this._pos(sn));
    }
    window.addEventListener("pointermove", this._onMove);
    window.addEventListener("pointerup", this._onUp);
  }

  _onNodeClick(ev, node) {
    if (this._nodeDrag?.moved) return;
    ev.stopPropagation();
    const multi = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    const next = multi ? new Set(this._selected) : new Set();
    if (multi && next.has(node.id)) next.delete(node.id);
    else next.add(node.id);
    this._selected = next;
    this.dispatchEvent(new CustomEvent("node-select", {
      detail: { id: node.id, multi, selected: [...next] },
      bubbles: true, composed: true,
    }));
  }

  _onHandleDown(ev, node, port, side) {
    if (this.readonly) return;
    if (side !== "out") return;  // only outputs start a drag
    ev.preventDefault();
    ev.stopPropagation();
    const pt = this._svgPoint(ev);
    const pos = this._pos(node);
    const { w } = nodeSize(node);
    const py = portY(node, port.id, "out");
    this._dragging = {
      from: { node: node.id, port: port.id },
      x1: pos.x + w, y1: pos.y + py,
      x2: pt.x, y2: pt.y,
    };
    window.addEventListener("pointermove", this._onMove);
    window.addEventListener("pointerup", this._onUp);
  }

  _onHandleUp(ev, node, port, side) {
    if (!this._dragging) return;
    if (side !== "in") return;
    ev.stopPropagation();
    const from = this._dragging.from;
    this._dragging = null;
    this._cleanup();
    if (from.node === node.id) return;  // no self-loop on same node
    // Dedupe: don't emit if edge already exists
    const exists = (this.edges || []).some(e =>
      e.from.node === from.node && e.from.port === from.port &&
      e.to.node === node.id && e.to.port === port.id);
    if (exists) return;
    this.dispatchEvent(new CustomEvent("edge-create", {
      detail: { from, to: { node: node.id, port: port.id } },
      bubbles: true, composed: true,
    }));
  }

  _onEdgeClick(ev, edge) {
    if (this.readonly) return;
    ev.stopPropagation();
    this.dispatchEvent(new CustomEvent("edge-remove", {
      detail: { id: edge.id, from: edge.from, to: edge.to },
      bubbles: true, composed: true,
    }));
  }

  _onPointerMove(ev) {
    if (this._dragging) {
      const pt = this._svgPoint(ev);
      this._dragging = { ...this._dragging, x2: pt.x, y2: pt.y };
      return;
    }
    if (this._nodeDrag) {
      const pt = this._svgPoint(ev);
      const dx = pt.x - this._nodeDrag.startPt.x;
      const dy = pt.y - this._nodeDrag.startPt.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this._nodeDrag.moved = true;
      const node = this.nodes.find(n => n.id === this._nodeDrag.id);
      if (node) {
        const nextOff = new Map(this._posOffsets);
        const newDx = (this._nodeDrag.origX + dx) - node.x;
        const newDy = (this._nodeDrag.origY + dy) - node.y;
        nextOff.set(node.id, { dx: newDx, dy: newDy });
        for (const [gid, gp] of this._nodeDrag.group) {
          const gn = this.nodes.find(n => n.id === gid);
          if (gn) nextOff.set(gid, { dx: (gp.x + dx) - gn.x, dy: (gp.y + dy) - gn.y });
        }
        this._posOffsets = nextOff;
        this.dispatchEvent(new CustomEvent("node-move", {
          detail: {
            id: node.id,
            x: this._nodeDrag.origX + dx,
            y: this._nodeDrag.origY + dy,
            final: false,
          },
          bubbles: true, composed: true,
        }));
      }
      return;
    }
    if (this._panning) {
      const dx = (ev.clientX - this._panning.startX) * this._zoom;
      const dy = (ev.clientY - this._panning.startY) * this._zoom;
      this._vbX = this._panning.origVbX - dx;
      this._vbY = this._panning.origVbY - dy;
    }
  }

  _onPointerUp() {
    if (this._nodeDrag?.moved) {
      const id = this._nodeDrag.id;
      const n = this.nodes.find(x => x.id === id);
      if (n) {
        const p = this._pos(n);
        this.dispatchEvent(new CustomEvent("node-move", {
          detail: { id, x: p.x, y: p.y, final: true },
          bubbles: true, composed: true,
        }));
      }
    }
    if (this._panning) {
      this.dispatchEvent(new CustomEvent("canvas-pan", {
        detail: { vbX: this._vbX, vbY: this._vbY, zoom: this._zoom },
        bubbles: true, composed: true,
      }));
    }
    this._cleanup();
  }

  _cleanup() {
    this._dragging = null;
    this._nodeDrag = null;
    this._panning = null;
    window.removeEventListener("pointermove", this._onMove);
    window.removeEventListener("pointerup", this._onUp);
  }

  _onWheel(ev) {
    ev.preventDefault();
    const factor = ev.deltaY > 0 ? 1.08 : 0.92;
    const pt = this._svgPoint(ev);
    const newZoom = Math.max(0.2, Math.min(6, this._zoom * factor));
    const k = newZoom / this._zoom;
    this._vbX += (pt.x - this._vbX) * (1 - k);
    this._vbY += (pt.y - this._vbY) * (1 - k);
    this._vbW *= k;
    this._vbH *= k;
    this._zoom = newZoom;
  }

  /* ── Rendering ── */

  _edgeAnchors(edge) {
    const src = this.nodes.find(n => n.id === edge.from.node);
    const tgt = this.nodes.find(n => n.id === edge.to.node);
    if (!src || !tgt) return null;
    const sp = this._pos(src), tp = this._pos(tgt);
    const ss = nodeSize(src);
    return {
      sx: sp.x + ss.w,
      sy: sp.y + portY(src, edge.from.port, "out"),
      tx: tp.x,
      ty: tp.y + portY(tgt, edge.to.port, "in"),
    };
  }

  _edgePath(sx, sy, tx, ty) {
    if (tx < sx) {
      const fn = CURVE_STYLES[this.curveStyle] || CURVE_STYLES[DEFAULT_CURVE_STYLE];
      return fn(sx, sy, tx, ty, this.curveConfig || DEFAULT_CURVE_CONFIG);
    }
    const dx = Math.max(20, Math.abs(tx - sx) * 0.4);
    return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  }

  _renderNode(node) {
    const pos = this._pos(node);
    const { w, h } = nodeSize(node);
    const selected = this._selected.has(node.id) || !!node.selected;
    const accentStroke = node.color || null;

    const inputs = node.inputs || [];
    const outputs = node.outputs || [];

    return svg`
      <g transform="translate(${pos.x}, ${pos.y})"
         @mousedown=${(e) => this._onNodeDown(e, node)}
         @click=${(e) => this._onNodeClick(e, node)}>
        <rect class=${`node-rect ${selected ? "selected" : ""}`}
              width=${w} height=${h} rx="6"
              style=${accentStroke && !selected ? `stroke:${accentStroke}` : ""} />
        <rect class="node-header" width=${w} height=${HEADER_H} rx="6" />
        <rect class="node-header" y=${HEADER_H - 6} width=${w} height="6" />
        <text class="node-title" x="10" y=${HEADER_H / 2 + 4}>
          ${(node.label || node.id).slice(0, 28)}
        </text>
        ${node.sub ? svg`
          <text class="node-sub" x="10" y=${HEADER_H + 14}>
            ${node.sub.slice(0, 32)}
          </text>` : nothing}

        ${inputs.map((p, i) => {
          const y = HEADER_H + PORT_PAD_Y + i * PORT_ROW_H + PORT_ROW_H / 2;
          const c = portColor(node.kind, p.color);
          return svg`
            <g>
              <circle class="handle"
                      cx="0" cy=${y} r=${HANDLE_R}
                      fill="var(--color-surface)"
                      stroke=${c}
                      @mouseup=${(e) => this._onHandleUp(e, node, p, "in")} />
              ${p.label ? svg`
                <text class="port-label" x="10" y=${y + 3}>${p.label}</text>
              ` : nothing}
            </g>`;
        })}

        ${outputs.map((p, i) => {
          const y = HEADER_H + PORT_PAD_Y + i * PORT_ROW_H + PORT_ROW_H / 2;
          const c = portColor(node.kind, p.color);
          return svg`
            <g>
              <circle class="handle"
                      cx=${w} cy=${y} r=${HANDLE_R}
                      fill="var(--color-surface)"
                      stroke=${c}
                      @mousedown=${(e) => this._onHandleDown(e, node, p, "out")} />
              ${p.label ? svg`
                <text class="port-label" x=${w - 10} y=${y + 3}
                      text-anchor="end">${p.label}</text>
              ` : nothing}
            </g>`;
        })}
      </g>`;
  }

  _renderEdge(edge) {
    const a = this._edgeAnchors(edge);
    if (!a) return nothing;
    const d = this._edgePath(a.sx, a.sy, a.tx, a.ty);
    const highlight = this._selected.has(edge.from.node) || this._selected.has(edge.to.node);
    return svg`
      <g>
        <path class="edge-hit" d=${d}
              @click=${(e) => this._onEdgeClick(e, edge)}>
          <title>Click to remove</title>
        </path>
        <path class=${`edge ${highlight ? "selected" : ""}`}
              d=${d}
              style=${edge.color ? `stroke:${edge.color}` : ""} />
      </g>`;
  }

  render() {
    const vb = `${this._vbX} ${this._vbY} ${Math.max(1, this._vbW)} ${Math.max(1, this._vbH)}`;
    const ghost = this._dragging
      ? this._edgePath(this._dragging.x1, this._dragging.y1, this._dragging.x2, this._dragging.y2)
      : null;

    return html`
      <svg viewBox=${vb}
           @mousedown=${(e) => this._onSvgMouseDown(e)}
           @wheel=${(e) => this._onWheel(e)}>
        <defs>
          <pattern id="fg-dots" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle class="dot-grid" cx="1" cy="1" r="1"/>
          </pattern>
        </defs>
        <rect class="dag-bg"
              x=${this._vbX} y=${this._vbY}
              width=${this._vbW} height=${this._vbH}
              fill="url(#fg-dots)" />
        ${(this.edges || []).map(e => this._renderEdge(e))}
        ${(this.nodes || []).map(n => this._renderNode(n))}
        ${ghost ? svg`<path class="edge-ghost" d=${ghost} />` : nothing}
      </svg>
      <div class="zoom-chip">${Math.round(100 / this._zoom)}%</div>
    `;
  }
}
customElements.define("foyer-node-graph", NodeGraph);
