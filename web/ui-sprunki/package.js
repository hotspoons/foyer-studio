// SPDX-License-Identifier: Apache-2.0
// foyer-ui-sprunki — Sprunki-style music game built on Foyer's sequencer.
//
// A kid-friendly, character-driven music toy. Each "sprunki" character
// occupies a slot on the beat grid. Click a character to add them to a
// beat — they play their signature sound on that step. Multiple
// characters layer into a full groove.
//
// **Pre-baked sounds:** Each character maps to a General MIDI pitch
// with a pre-selected instrument bank. No plugin panels, no MIDI
// editor — just tap characters on a grid and listen.
//
// **Beat sequencer under the hood:** Every character toggle writes
// through Foyer's `set_sequencer_layout` protocol, which means the
// arrangement is automatically rendered as MIDI notes into an Ardour
// region. Transport (play/stop/tempo) drives the native engine.
//
// Three-tier rule: imports from `foyer-core` (state, ws) and
// `foyer-ui-core` (icons, theme). Never from `foyer-ui-full` —
// variants are siblings, not subclasses.

import { registerUiVariant } from "foyer-core/registry/ui-variants.js";

export const MANIFEST = {
  name: "foyer-ui-sprunki",
  version: "0.1.0",
  role: "ui",
  description:
    "Sprunki-style music toy — tap characters onto a beat grid to " +
    "build grooves. Pre-baked instrument presets, no MIDI knowledge " +
    "required. Powered by Foyer's sequencer engine.",
  variant: {
    id: "sprunki",
    label: "Sprunki Beats",
    // Opt-in via ?ui=sprunki or Preferences.
    match: () => 0,
  },
};

registerUiVariant({
  ...MANIFEST.variant,
  boot: async () => {
    await import("./app.js");
    const el = document.createElement("sprunki-app");
    document.body.appendChild(el);
    return { root: el, teardown: () => el.remove() };
  },
});
