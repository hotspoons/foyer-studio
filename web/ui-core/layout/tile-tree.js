// Pure tile-tree data model. No Lit, no DOM, no deps.
//
// A tile is either a Leaf (holds a named view + props) or a Split (a row or
// column of children with ratios summing to 1). The tree is immutable-ish —
// all operations return a new root and never mutate input.
//
// Coordinates: splits are either "row" (children laid horizontally, ratios
// control width) or "column" (children laid vertically, ratios control
// height). Matches CSS flex-direction naming.
//
// Every node carries a stable `id`. IDs are short random strings; we do not
// rely on DOM element identity for focus/keyboard — we always look things up
// through the tree.

export const DIR = Object.freeze({ ROW: "row", COLUMN: "column" });

let _id = 0;
function mkId(prefix) {
  _id += 1;
  return `${prefix}_${Date.now().toString(36)}_${_id.toString(36)}`;
}

/** Build a leaf holding the given view name. */
export function leaf(view, props = {}) {
  return { kind: "leaf", id: mkId("l"), view, props };
}

/** Build a split of the given children with equal ratios. */
export function split(direction, children) {
  const n = children.length;
  return {
    kind: "split",
    id: mkId("s"),
    direction,
    children,
    ratios: new Array(n).fill(1 / n),
  };
}

// ── lookup ───────────────────────────────────────────────────────────────

/** Collect every leaf in tree-iteration order. */
export function leaves(tree) {
  const out = [];
  (function walk(n) {
    if (n.kind === "leaf") out.push(n);
    else n.children.forEach(walk);
  })(tree);
  return out;
}

/** Find the parent split of a node with `id` plus its child index, or null. */
export function parentOf(tree, id) {
  function walk(node) {
    if (node.kind !== "split") return null;
    for (let i = 0; i < node.children.length; i++) {
      if (node.children[i].id === id) return { parent: node, index: i };
      const r = walk(node.children[i]);
      if (r) return r;
    }
    return null;
  }
  return walk(tree);
}

export function findById(tree, id) {
  if (tree.id === id) return tree;
  if (tree.kind === "split") {
    for (const c of tree.children) {
      const r = findById(c, id);
      if (r) return r;
    }
  }
  return null;
}

// ── update ───────────────────────────────────────────────────────────────

/** Replace the node with `id` using the result of `fn(node)`. Returns new root. */
export function mapNode(tree, id, fn) {
  if (tree.id === id) return fn(tree);
  if (tree.kind !== "split") return tree;
  let changed = false;
  const next = tree.children.map(c => {
    const nc = mapNode(c, id, fn);
    if (nc !== c) changed = true;
    return nc;
  });
  return changed ? { ...tree, children: next } : tree;
}

/** Remove the node with `id`. If its sibling becomes an only child, the
 *  parent split collapses. Returns new root (or null if id === root). */
export function removeNode(tree, id) {
  if (tree.id === id) return null;
  if (tree.kind !== "split") return tree;
  const children = [];
  const ratios = [];
  for (let i = 0; i < tree.children.length; i++) {
    const c = tree.children[i];
    if (c.id === id) continue;
    const nc = removeNode(c, id);
    if (nc === null) continue;
    children.push(nc);
    ratios.push(tree.ratios[i]);
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]; // collapse
  // Renormalize ratios.
  const sum = ratios.reduce((a, b) => a + b, 0);
  const norm = ratios.map(r => r / sum);
  return { ...tree, children, ratios: norm };
}

/** Split a leaf — turn it into a Split containing the leaf plus a new
 *  leaf on the given side. `side` is "before" or "after". Returns new root. */
export function splitLeaf(tree, leafId, direction, newView, side = "after", props = {}) {
  return mapNode(tree, leafId, (node) => {
    const fresh = leaf(newView, props);
    const children = side === "before" ? [fresh, node] : [node, fresh];
    return split(direction, children);
  });
}

/** Set a leaf's view to a new one (same id retained). */
export function setLeafView(tree, leafId, view, props = {}) {
  return mapNode(tree, leafId, (n) => ({ ...n, view, props }));
}

/** Adjust a split's ratio at `edgeIndex` (0-based, between child[edgeIndex] and
 *  child[edgeIndex+1]). `delta` is in normalized units (-1..1). */
export function resizeSplit(tree, splitId, edgeIndex, delta) {
  return mapNode(tree, splitId, (n) => {
    if (n.kind !== "split") return n;
    const ratios = n.ratios.slice();
    // Ratio floor: 3% of the parent. Small enough that splits in an ultrawide
    // workspace can compress a sibling to a slim rail (~100px on 3440px) and
    // still have other children dominate.
    const min = 0.03;
    const a = edgeIndex;
    const b = edgeIndex + 1;
    const next_a = Math.max(min, Math.min(1 - min, ratios[a] + delta));
    const shrinkB = ratios[a] + ratios[b] - next_a;
    if (shrinkB < min) return n;
    ratios[a] = next_a;
    ratios[b] = shrinkB;
    return { ...n, ratios };
  });
}

// ── focus / keyboard navigation ──────────────────────────────────────────

/**
 * Find the leaf closest to `(fromRect)` in `direction` ("left","right","up","down").
 * `rectById` is a map of leafId → DOMRect. Returns the winning leaf's id, or null.
 */
export function focusNeighbor(tree, fromId, direction, rectById) {
  const from = rectById.get(fromId);
  if (!from) return null;
  const fc = { x: from.left + from.width / 2, y: from.top + from.height / 2 };

  let best = null;
  let bestScore = Infinity;
  for (const lf of leaves(tree)) {
    if (lf.id === fromId) continue;
    const r = rectById.get(lf.id);
    if (!r) continue;
    const rc = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const dx = rc.x - fc.x;
    const dy = rc.y - fc.y;
    const aligned =
      (direction === "left"  && dx < -4) ||
      (direction === "right" && dx >  4) ||
      (direction === "up"    && dy < -4) ||
      (direction === "down"  && dy >  4);
    if (!aligned) continue;
    // Primary distance along the axis; small penalty for perpendicular drift.
    const along = direction === "left" || direction === "right" ? Math.abs(dx) : Math.abs(dy);
    const cross = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = along + cross * 2;
    if (score < bestScore) { bestScore = score; best = lf.id; }
  }
  return best;
}

// ── serialization ────────────────────────────────────────────────────────

export function serialize(tree) {
  return JSON.stringify(tree);
}

export function deserialize(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    return sanitize(parsed);
  } catch {
    return null;
  }
}

function sanitize(node) {
  if (node?.kind === "leaf" && typeof node.view === "string") {
    return { ...node, id: node.id || mkId("l"), props: node.props || {} };
  }
  if (node?.kind === "split" && Array.isArray(node.children) && node.children.length >= 1) {
    const children = node.children.map(sanitize).filter(Boolean);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    let ratios = Array.isArray(node.ratios) && node.ratios.length === children.length
      ? node.ratios.map(Number)
      : new Array(children.length).fill(1 / children.length);
    const sum = ratios.reduce((a, b) => a + b, 0) || 1;
    ratios = ratios.map(r => r / sum);
    const direction = node.direction === DIR.COLUMN ? DIR.COLUMN : DIR.ROW;
    return {
      kind: "split",
      id: node.id || mkId("s"),
      direction,
      children,
      ratios,
    };
  }
  return null;
}

// ── default trees ────────────────────────────────────────────────────────

export function defaultTree() {
  return leaf("mixer");
}

export const PRESETS = {
  // Singletons
  mixer:    () => leaf("mixer"),
  timeline: () => leaf("timeline"),
  plugins:  () => leaf("plugins"),
  session:  () => leaf("session"),
  console:  () => leaf("console"),
  diagnostics: () => leaf("diagnostics"),

  // Two-pane arrangements — any combination of main surfaces can live together.
  "timeline-over-mixer":         () => split(DIR.COLUMN, [leaf("timeline"), leaf("mixer")]),
  "mixer-over-timeline":         () => split(DIR.COLUMN, [leaf("mixer"), leaf("timeline")]),
  "timeline-left-mixer-right":   () => split(DIR.ROW,    [leaf("timeline"), leaf("mixer")]),
  "mixer-left-timeline-right":   () => split(DIR.ROW,    [leaf("mixer"), leaf("timeline")]),
  "plugins-left-mixer-right":    () => split(DIR.ROW,    [leaf("plugins"), leaf("mixer")]),
  "mixer-left-plugins-right":    () => split(DIR.ROW,    [leaf("mixer"), leaf("plugins")]),
  "session-left-timeline-right": () => split(DIR.ROW,    [leaf("session"), leaf("timeline")]),

  // Three-column layout: session is a narrow left rail (1/6), timeline and
  // mixer each take 5/12 of the width. All three are full-height so nothing
  // is ever vertically cropped — the mental model is "file browser + two
  // equal work surfaces" which is the common DAW shape.
  "session+timeline+mixer": () => ({
    ...split(DIR.ROW, [leaf("session"), leaf("timeline"), leaf("mixer")]),
    ratios: [1/6, 5/12, 5/12],
  }),
  // Older stacked shape kept under a second id for anyone who prefers the
  // session-rail + timeline-over-mixer arrangement.
  "session+timeline-over-mixer": () => split(DIR.ROW, [
    leaf("session"),
    split(DIR.COLUMN, [leaf("timeline"), leaf("mixer")]),
  ]),

  // Everything at once.
  everything: () => split(DIR.COLUMN, [
    split(DIR.ROW, [leaf("session"), leaf("plugins")]),
    split(DIR.ROW, [leaf("timeline"), leaf("mixer")]),
  ]),

  // PLAN 139 — a tall left pane and two stacked right panes at half
  // height each. The default placement puts timeline on the left
  // (the "long view" of the session) with mixer and plugins stacked
  // on the right (the work surfaces). It's a one-hand-on-keyboard /
  // one-hand-on-mouse layout: keep the playhead moving on the left
  // while you tweak channels + plugins on the right.
  "timeline-left-mixer-over-plugins": () => ({
    ...split(DIR.ROW, [
      leaf("timeline"),
      split(DIR.COLUMN, [leaf("mixer"), leaf("plugins")]),
    ]),
    ratios: [0.5, 0.5],
  }),
};
