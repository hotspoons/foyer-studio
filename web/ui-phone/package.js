// SPDX-License-Identifier: Apache-2.0
// foyer-ui-phone — touch-first transport remote for phones.
//
// A deliberately small UI variant. The premise: you're behind a drum
// kit / a guitar / at a vocal mic and you need to drive playback,
// arm tracks, and adjust your monitor mix without leaving the
// instrument. That means BIG touch targets, ZERO mouse-affordances,
// no timeline / mixer surfaces, no plugin chrome.
//
// Surface area (intentionally narrow):
//   * Transport: play / stop / record / loop, position + tempo readout
//   * Tracks: per-track arm / solo / mute toggles + monitor fader
//   * Audio: master-bus Listen button (existing audioController)
//   * Sessions: read-only switcher when multiple are open; picker
//     gated on RBAC `launch_project` so tunnel guests without that
//     right see "waiting for host" instead.
//
// **Not in scope** (route to ui-full on desktop / tablet):
//   * Plugin panels, MIDI editor, beat sequencer, region edits
//   * New Session / project creation (open existing only)
//   * Per-track audition listen — punted on purpose. Audition routing
//     is where DAW UIs go from fun to incomprehensible; we'll get
//     there once the simple shape proves itself.
//
// Three-tier rule: imports from foyer-core (state, ws, audio,
// rbac) and foyer-ui-core (icons, theme, modals). NEVER from
// foyer-ui-full — variants are siblings, not subclasses.

import { registerUiVariant } from "foyer-core/registry/ui-variants.js";

export const MANIFEST = {
  name: "foyer-ui-phone",
  version: "0.1.0",
  role: "ui",
  description: "Touch-first transport remote for phones — play/record/" +
    "arm/loop with a monitor mix fader. No mixer/timeline/plugin chrome.",
  variant: {
    id: "phone",
    label: "Foyer Phone",
    // Phones only. ui-full returns 0 in this band so any positive
    // score here wins. Tablets (touch + minDim 600..900) intentionally
    // stay on ui-full until we ship a tablet-targeted variant —
    // tablets have enough room for the real surface.
    match: ({ touch, minDim }) => {
      if (touch && minDim < 600) return 12;
      return 0;
    },
  },
};

registerUiVariant({
  ...MANIFEST.variant,
  boot: async () => {
    // Mount the Lit shell. Core bootstrap has already wired store + ws
    // + populated registries; we just paint.
    await import("./app.js");
    const el = document.createElement("foyer-phone-app");
    document.body.appendChild(el);
    return { root: el, teardown: () => el.remove() };
  },
});
