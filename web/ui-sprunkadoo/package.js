// SPDX-License-Identifier: Apache-2.0
// foyer-ui-sprunkadoo — Sprunkadoo, the kid-friendly music toy.
//
// Renamed 2026-05-25 per Rich's 8-year-old's pick. Previously
// "sprunki" (still the OG game we drew the costume vocabulary
// from); the variant id + label now read "sprunkadoo" so the kid
// sees their name on the boot screen and the URL slug. INTERNAL
// element tags + CSS class names stay `sprunki-*` for now —
// they're scoped to this shadow root so nothing breaks, and a
// wholesale tag rename would churn every file in this variant
// for purely cosmetic gain.
//
// A kid-friendly, character-driven music toy. Each character
// occupies a slot on the stage. Drag costumes from the palette
// onto the cast — they play their signature sound on top of a
// 4-bar loop. Multiple characters layer into a full groove.
//
// **Pre-baked sounds:** Each character maps to a General MIDI
// preset (or AvlDrums for the percussion cast). No plugin panels,
// no MIDI editor — just drag costumes around. Grown-ups can flip
// the GM program per slot in Settings → Advanced.
//
// **Beat sequencer under the hood:** Every step toggle writes
// through Foyer's `set_sequencer_layout` protocol, which means the
// arrangement is automatically rendered as MIDI notes into an
// Ardour region. Transport (play/stop/tempo) drives the native
// engine.
//
// Three-tier rule: imports from `foyer-core` (state, ws) and
// `foyer-ui-core` (icons, theme). Never from `foyer-ui-full` —
// variants are siblings, not subclasses.

import { registerUiVariant } from "foyer-core/registry/ui-variants.js";

export const MANIFEST = {
  name: "foyer-ui-sprunkadoo",
  version: "0.1.0",
  role: "ui",
  description:
    "Sprunkadoo — tap characters onto a beat grid to build grooves. " +
    "Pre-baked instrument presets, no MIDI knowledge required. " +
    "Powered by Foyer's sequencer engine.",
  variant: {
    id: "sprunkadoo",
    label: "Sprunkadoo",
    // Opt-in via ?ui=sprunkadoo (or the legacy ?ui=sprunki alias) /
    // Preferences. Aliases are read by foyer-core's variant resolver
    // so bookmarks from the prior name still land here.
    match: () => 0,
    aliases: ["sprunki"],
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
