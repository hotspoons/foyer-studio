// SPDX-License-Identifier: Apache-2.0
// foyer-ui-touch — tablet- and kid-friendly Foyer UI.
//
// **Not a phone variant.** That's `ui-phone`, which is the
// engineer-at-the-drum-kit transport remote (arm / disarm / record /
// punch, no mixer chrome). This variant lives at a different level:
// FULL feature surface, but reshaped around progressive disclosure
// and large touch targets so it works on:
//
//   * a tablet that's mostly used through touch
//   * a laptop a kid drives, where the desktop UI's tile-tree +
//     floating-window apparatus would be intimidating
//   * any context where the user wants "what plays + what mixes,
//     everything else behind a menu"
//
// Layout (top → bottom):
//
//   ┌─────────────────────────────────────────────────┐
//   │ TOP BAR    session · transport · agent          │
//   ├─────────────────────────────────────────────────┤
//   │ PINNED     [⭐ pin row, hidden if none]         │
//   ├─────────────────────────────────────────────────┤
//   │                                                 │
//   │  ACTIVE PANEL   (Mixer / Timeline / Tracks /    │
//   │                  More menu)                     │
//   │                                                 │
//   ├─────────────────────────────────────────────────┤
//   │ BOTTOM NAV   Mixer | Timeline | Tracks | More   │
//   └─────────────────────────────────────────────────┘
//
// - No tile tree, no floating windows, no docks.
// - "More" is a hierarchical drawer: Pin items from there to push
//   them onto the bottom nav.
// - Bottom nav has a max of 5 visible tabs (Mixer / Timeline /
//   Tracks / More + up to 1 pinned); extra pins go inside More's
//   "Pinned" section as a chip row.
//
// **`match` score is 0 by default.** That means this variant only
// boots when the user opts in via `?ui=touch` or the desktop's
// preferences → UI Variant chooser sets `localStorage`. Auto-
// detection stays in ui-full / ui-phone — this variant is a
// deliberate choice, not an inferred one.
//
// Three-tier rule: imports from `foyer-core` (state, ws, RBAC) and
// `foyer-ui-core` (icons, theme, modals, primitives). It side-effect-
// imports SOME ui-full components by tag (mixer, timeline view, MIDI
// editor, plugin panel, etc.) because those are full-blown widgets
// the desktop has already vetted; ui-touch's job is to compose them
// in a friendlier shell, not re-implement them. See "Reuse vs.
// rebuild" in HACKING.md for the policy.

import { registerUiVariant } from "foyer-core/registry/ui-variants.js";

export const MANIFEST = {
  name: "foyer-ui-touch",
  version: "0.1.0",
  role: "ui",
  description:
    "Tablet- and kid-friendly UI: full-feature, progressive-disclosure, " +
    "tabs + panels (no tile tree / floating windows). " +
    "Opt-in via Preferences → UI Variant.",
  variant: {
    id: "touch",
    label: "Foyer Touch",
    // Opt-in only. Phones win on score in their own band; desktops
    // win on theirs. A user who wants ui-touch picks it from
    // Preferences (or ?ui=touch).
    match: () => 0,
  },
};

registerUiVariant({
  ...MANIFEST.variant,
  boot: async () => {
    await import("./app.js");
    const el = document.createElement("foyer-touch-app");
    document.body.appendChild(el);
    return { root: el, teardown: () => el.remove() };
  },
});
