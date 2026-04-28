// foyer-ui-core public entry — primitives, windowing, fallback.
//
// The fallback shell is exported so third-party UIs that want a
// dependable "empty but pleasant" state can reuse it during their
// own loading phases. Primitives (knob, fader, meter, modals, tile
// tree, etc.) register themselves with the widget registry as
// side-effects of import; components that want a specific element
// can either import it directly or resolve via `widgetTag(...)`.
export { MANIFEST } from "./package.js";
export { mountFallback } from "./fallback-ui.js";
