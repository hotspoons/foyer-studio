// foyer-ui-core — shared browser UI primitives.
//
// This layer sits between foyer-core (renderless) and any concrete
// UI (foyer-ui, foyer-ui-lite, foyer-ui-touch, foyer-ui-kids, or a
// third-party skin). It holds the stuff every browser-based UI wants
// but that's still our opinion:
//
//   · Tiling + windowing (tile-tree, drop-zones, floating-tiles,
//     plugin-layer, keybinds) — the desktop-environment shell.
//   · Primitive widgets (knob, fader, meter, toggle, number-scrub,
//     param-control) — styled but DAW-agnostic.
//   · Modal primitives (confirm, prompt, preview, context-menu).
//   · The boot-time fallback UI — a minimal "foyer-core is running,
//     you haven't wired up a renderer yet" surface that core mounts
//     when no UI variant is registered. See fallback-ui.js.
//   · Shared CSS variables + icon SVGs.
//
// **Deletable.** A replacement UI that prefers React/Svelte/Vue
// primitives can skip this package entirely and consume foyer-core
// directly. Nothing in foyer-core imports from here — the dependency
// arrow only ever points core → ui-core → ui.
export const MANIFEST = {
  name: "foyer-ui-core",
  version: "0.1.0",
  role: "ui-core",
  description: "Browser UI primitives for Foyer — tiling, windowing, " +
    "widgets, modals, fallback shell. Deletable if you bring your own.",
};
