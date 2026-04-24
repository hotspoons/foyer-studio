// foyer-ui — the shipping Foyer desktop UI.
//
// One concrete consumer of foyer-core + foyer-ui-core. This is where
// opinionated surfaces live: the transport bar, mixer, timeline,
// track editor, plugin panels, welcome screen, command palette,
// session switcher, etc.
//
// **This is what you replace to theme or reshape Foyer.** Leave core
// and ui-core alone; write a sibling package that exports its own
// manifest + registerUiVariant call, include it in the page, and
// the registry + variant selector will pick it up.
//
// Future siblings: foyer-ui-lite (minimal transport), foyer-ui-touch
// (phone/tablet control surface), foyer-ui-kids (large buttons, few
// controls). Each declares its own manifest + `match` predicate and
// the variant registry picks one at boot based on heuristic, ?ui=
// override, localStorage preference, or server default — in that
// priority order.
import { registerUiVariant } from "foyer-core/registry/ui-variants.js";

export const MANIFEST = {
  name: "foyer-ui",
  version: "0.1.0",
  role: "ui",
  description: "The shipping Foyer desktop UI — full-featured tile + " +
    "dock + mixer + timeline experience.",
  variant: {
    id: "full",
    label: "Foyer Full",
    // `match` scores how well this variant fits the current client.
    // Higher = better. Registry picks the highest unless overridden.
    // The `full` variant is the default fallback (score 1) for any
    // viewport that isn't obviously a touch-first surface.
    match: ({ touch, minDim }) => {
      if (touch && minDim < 600) return 0;    // phone → let touch UI win
      if (touch && minDim < 900) return 1;    // tablet → tie with touch
      return 10;                              // desktop → we win
    },
  },
};

registerUiVariant({
  ...MANIFEST.variant,
  boot: async () => {
    // Mount the Lit-based app shell into document.body. The caller
    // (core bootstrap) has already created store + ws + populated
    // registries; we just paint.
    await import("./app.js");
    const el = document.createElement("foyer-app");
    document.body.appendChild(el);
    return { root: el, teardown: () => el.remove() };
  },
});
