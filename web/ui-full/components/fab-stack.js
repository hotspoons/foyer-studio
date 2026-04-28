// FAB container that positions draggable FABs, snapping them to an edge when
// dropped near one. Each FAB is a child element with its own click behavior;
// this component only handles position + docking. The agent's FAB still lives
// inside agent-panel.js but we supply a thin wrapper FAB for the layout
// manager. In the future, FABs could also stack along a docked edge.
//
// State shape (localStorage under foyer.fabs.v1):
//   { [fabId]: { edge: "none" | "left" | "right" | "top" | "bottom", offset: px } }

const KEY = "foyer.fabs.v1";

export function loadFabState() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch { return {}; }
}

export function saveFabState(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

/**
 * Install draggable + snap behavior on a fixed-positioned FAB element.
 * Returns a disposer. Subscribes to a click callback fired when the drag
 * was less than 4px total (i.e. a tap).
 *
 * @param {HTMLElement} el
 * @param {string} fabId
 * @param {{ onTap?: () => void }} opts
 */
export function installFab(el, fabId, opts = {}) {
  const state = loadFabState();
  let mine = state[fabId] || { edge: "none", offset: 24, perp: 24 };
  apply(mine);

  function apply(s) {
    el.style.position = "fixed";
    el.style.transition = "none";
    // `offset` is distance along the parallel edge from top-left origin.
    // `perp` is distance from the docked edge to the FAB (0 = flush).
    switch (s.edge) {
      case "left":
        el.style.left = `${s.perp}px`;
        el.style.right = "";
        el.style.top = `${s.offset}px`;
        el.style.bottom = "";
        break;
      case "right":
        el.style.right = `${s.perp}px`;
        el.style.left = "";
        el.style.top = `${s.offset}px`;
        el.style.bottom = "";
        break;
      case "top":
        el.style.top = `${s.perp}px`;
        el.style.bottom = "";
        el.style.left = `${s.offset}px`;
        el.style.right = "";
        break;
      case "bottom":
        el.style.bottom = `${s.perp}px`;
        el.style.top = "";
        el.style.left = `${s.offset}px`;
        el.style.right = "";
        break;
      case "none":
      default:
        el.style.right = `${s.offset}px`;
        el.style.bottom = `${s.perp}px`;
        el.style.left = "";
        el.style.top = "";
        break;
    }
  }

  const onPointerDown = (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    try { el.setPointerCapture(ev.pointerId); } catch {}
    const startX = ev.clientX;
    const startY = ev.clientY;
    const rect = el.getBoundingClientRect();
    const offX = startX - rect.left;
    const offY = startY - rect.top;
    let moved = false;

    const move = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 4) moved = true;
      const x = e.clientX - offX;
      const y = e.clientY - offY;
      // Free-float while dragging.
      el.style.left = `${Math.max(0, Math.min(window.innerWidth - rect.width, x))}px`;
      el.style.top  = `${Math.max(0, Math.min(window.innerHeight - rect.height, y))}px`;
      el.style.right = "";
      el.style.bottom = "";
    };
    const up = (e) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      try { el.releasePointerCapture(ev.pointerId); } catch {}
      if (!moved) { opts.onTap?.(); return; }
      // Snap to nearest edge if within 60px.
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const distLeft = r.left;
      const distRight = window.innerWidth - r.right;
      const distTop = r.top;
      const distBottom = window.innerHeight - r.bottom;
      const snap = 60;
      let next = { edge: "none", offset: window.innerWidth - r.right, perp: window.innerHeight - r.bottom };
      const min = Math.min(distLeft, distRight, distTop, distBottom);
      if (min < snap) {
        if (min === distLeft)        next = { edge: "left",   offset: r.top, perp: 0 };
        else if (min === distRight)  next = { edge: "right",  offset: r.top, perp: 0 };
        else if (min === distTop)    next = { edge: "top",    offset: r.left, perp: 0 };
        else                         next = { edge: "bottom", offset: r.left, perp: 0 };
      } else {
        // Keep using "none" (floating) with bottom-right offsets.
        next = { edge: "none", offset: window.innerWidth - r.right, perp: window.innerHeight - r.bottom };
      }
      mine = next;
      const all = loadFabState();
      all[fabId] = mine;
      saveFabState(all);
      apply(mine);
      void e;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  el.addEventListener("pointerdown", onPointerDown);

  return () => el.removeEventListener("pointerdown", onPointerDown);
}
