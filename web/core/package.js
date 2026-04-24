// foyer-core — renderless DAW business logic.
//
// **Zero UI opinion.** Anything that touches DOM, CSS, SVG, LitElement,
// or tree layout does NOT live here. If you're tempted to import a
// component, write the thing into ui-core instead.
//
// **What lives here:** the WebSocket client, reactive store, RBAC,
// audio ingress/egress facades, automation script runtime, recents,
// session launch dispatcher, transport-return logic, the feature and
// UI-variant registries, and the bootstrap entry point that wires
// these together and hands control to whichever UI is registered.
//
// **Who consumes this:** ui-core (the shipping widget library),
// ui (the shipping Foyer UI), and anyone writing a replacement
// front-end. A React/Svelte/Solid/plain-HTML alternative can `import`
// from here, call `bootFoyerCore()`, register their renderer via
// `registerUiVariant(...)`, and get the full Foyer backend routing
// without carrying any of our DOM opinions.
//
// **Browser facades:** platform-specific APIs (WebSocket, AudioContext,
// IndexedDB, localStorage) are called through thin accessors so a
// headless runtime (node, tests, native shell) can substitute stubs.
// We don't try to be isomorphic today — we just keep the door open.
export const MANIFEST = {
  name: "foyer-core",
  version: "0.1.0",
  role: "core",
  description: "Renderless Foyer DAW business logic — wire protocol, " +
    "state, RBAC, audio, automation, registries. Zero UI opinion.",
};
