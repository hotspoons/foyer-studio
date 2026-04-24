# Hacking the Foyer UI

Foyer is a web-native control surface for a DAW (today: Ardour). The
shipping UI is one way to paint the backend — not the only way. This
document is your entry point for building another UI, a lite phone
control surface, a kids UI, or a totally different renderer (React,
Svelte, Vue, native) against Foyer's backend.

> **TL;DR.** Foyer's browser tree is three packages with one-way
> dependencies:
>
> ```
> foyer-core  ──►  foyer-ui-core  ──►  foyer-ui
> (renderless)     (primitives)        (shipping UI)
> ```
>
> You can swap, replace, or skip any tier below the one above you.
> Write a React UI? Keep core, drop ui-core + ui entirely. Want Lit
> widgets but a different layout? Keep core + ui-core, drop ui.

## On-disk layout

When `foyer serve` boots for the first time, it dumps the shipping
web assets to `$XDG_DATA_HOME/foyer/web/` (typically
`~/.local/share/foyer/web/`) and serves from there. Edit the files in
place and refresh the browser — no build step, no bundler, no npm.
The on-disk copy is the source of truth after first boot; delete the
folder to restore the shipped assets, or pass `--web-root <path>` to
serve from anywhere.

```
~/.local/share/foyer/web/
├── index.html             ← page shell + import map
├── boot.js                ← "which UIs are available on this page"
├── core/                  ← foyer-core: ws, store, registries, RBAC
│   ├── bootstrap.js
│   ├── registry/{features,ui-variants,widgets,views}.js
│   ├── ws.js  store.js  rbac.js
│   ├── audio/*
│   └── automation/*
├── ui-core/               ← foyer-ui-core: tiling, windowing, widgets
│   ├── fallback-ui.js     ← "If you lived here you'd be home now"
│   ├── layout/*           ← tile tree, drop zones, plugin layer
│   └── widgets/*          ← knob, fader, meter, toggle, modals
├── ui-full/               ← the shipping UI variant (one of many)
│   ├── app.js             ← top-level shell + connects everything
│   ├── components/*       ← mixer, timeline, transport bar, etc.
│   └── package.js         ← manifest + registerUiVariant call
├── ui-*/                  ← any sibling folder matching `ui-*/` + a
│                            package.js is auto-discovered via the
│                            server's /variants.json endpoint
├── vendor/                ← vendored Lit, import-map targets
└── styles/tw.build.css    ← compiled Tailwind
```

## Adding a new UI variant

Drop a folder, restart the server:

1. Create `<web_root>/ui-myvariant/` — on an installed Foyer that's
   `~/.local/share/foyer/web/ui-myvariant/`. (Override the location
   with `--web-root <path>`.)
2. Put a `package.js` in it (template in Recipe 1 below).
3. Restart `foyer serve`.
4. `curl http://<host>:3838/variants.json` to confirm discovery.
5. Reload the browser. Your variant's `match()` function runs
   against the viewport and competes with siblings; the highest
   score wins. Force yours with `?ui=myvariant`.

`boot.js` fetches `/variants.json` at page load and dynamically
imports each entry's `package.js` — the import's side-effect is a
`registerUiVariant({...})` call on foyer-core's registry.

### What's in the import map

Just the stable cross-package contracts that every variant wants:

```html
<script type="importmap">
{
  "imports": {
    "lit":             "/vendor/lit/index.js",
    "foyer-core":      "/core/index.js",
    "foyer-core/":     "/core/",
    "foyer-ui-core":   "/ui-core/index.js",
    "foyer-ui-core/":  "/ui-core/"
  }
}
</script>
```

Your variant's package imports `foyer-core` and (if you want the
shipped primitives) `foyer-ui-core` via those bare specifiers, and
references its own files by relative paths. No URL routing magic,
no bundler; the browser resolves everything at load time.

## Recipe 1 — add a new UI variant

Ship a minimal "touch control surface" alongside the full UI that
auto-selects on phone-sized viewports.

**Step 1.** Create `<web_root>/ui-touch/package.js`
(`~/.local/share/foyer/web/ui-touch/package.js` on an installed
Foyer):

```js
import { registerUiVariant } from "foyer-core/registry/ui-variants.js";

export const MANIFEST = {
  name: "foyer-ui-touch",
  version: "0.1.0",
  role: "ui",
  description: "Big-buttons phone control surface — transport + " +
    "mute/solo/arm per track, nothing else.",
  variant: {
    id: "touch",
    label: "Touch Surface",
    // Return a score: higher = better fit for this env. Phones win
    // on small-touch devices; lose on desktops where the full UI
    // returns 10.
    match: ({ touch, minDim }) => {
      if (!touch) return 0;
      if (minDim < 600) return 100;  // phone
      if (minDim < 900) return 20;   // tablet
      return 5;
    },
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
```

**Step 2.** Create `<web_root>/ui-touch/app.js`:

```js
import { LitElement, html, css } from "lit";
// Reach into core for state, ui-core for primitives.
import "foyer-ui-core/widgets/toggle.js";

export class TouchApp extends LitElement {
  static styles = css`
    :host { display: grid; grid-template-columns: 1fr; gap: 16px; padding: 16px; }
    button { font-size: 24px; padding: 28px; border-radius: 8px; }
  `;
  render() {
    const ws = window.__foyer.ws;
    return html`
      <button @click=${() => ws.controlSet("transport.playing", true)}>▶ Play</button>
      <button @click=${() => ws.controlSet("transport.playing", false)}>⏹ Stop</button>
      <button @click=${() => ws.controlSet("transport.recording", true)}>⏺ Record</button>
    `;
  }
}
customElements.define("foyer-touch-app", TouchApp);
```

**Step 3.** Restart `foyer serve`. That's it.

Load Foyer on a phone → touch variant auto-selects (because its
`match({touch: true, minDim: < 600})` returns 100, beating the
shipping UI's 10). Load on desktop → full UI still wins. Force
either: `?ui=touch` or `?ui=full`.

`boot.js` calls `/variants.json`, gets back
`{"variants": ["ui-full", "ui-touch"]}`, imports each, and the
registry has both variants to pick from. No HTML edit, no bundler,
no restart needed after the first `foyer serve` discovered them.

## Recipe 2 — override a single widget

Replace the shipping knob with a chunkier version just for your
variant, without touching ui-core or the rest of ui.

```js
// /ui-touch/widgets/chunky-knob.js
import { LitElement, html, css } from "lit";
import { registerWidget } from "foyer-core/registry/widgets.js";

export class ChunkyKnob extends LitElement {
  /* ... */
}
customElements.define("chunky-knob", ChunkyKnob);
registerWidget("knob", "chunky-knob", { variant: "touch" });
```

Any component that resolves through the registry (e.g. via
`widgetTag("knob")`) picks up the override for the touch variant and
falls through to the default `foyer-knob` otherwise. For shipping UI
code that hardcodes `<foyer-knob>` today, you can either swap the
hardcoded tag out for a `widgetTag(...)` lookup, or define your
`chunky-knob` element to extend/wrap `foyer-knob` and customElements
will happily let you use both names.

## Recipe 3 — gate surfaces by backend capability

Not every DAW supports every feature. The server sends a capability
snapshot in `ClientGreeting.features`; core mirrors it into the
feature registry.

```js
import { showFeature, onFeatureChange } from "foyer-core/registry/features.js";

class MyMenu extends LitElement {
  render() {
    return html`
      ${showFeature("sequencer")
        ? html`<button>Beat Sequencer</button>`
        : null}
      ${showFeature("surround_pan")
        ? html`<button>Surround Pan</button>`
        : null}
    `;
  }
  connectedCallback() {
    super.connectedCallback();
    this._off = onFeatureChange(() => this.requestUpdate());
  }
  disconnectedCallback() {
    this._off?.();
    super.disconnectedCallback();
  }
}
```

Missing entries default to optimistic (show). Explicit `false` hides.

## Recipe 4 — register a new tile view

Add a custom pane that users can split into. The tile system is
view-registry-driven — just declare the view and the element tag.

```js
import { registerView } from "foyer-core/registry/views.js";
import { LitElement, html } from "lit";

class MyPane extends LitElement {
  render() { return html`<h1>Hello from a custom pane</h1>`; }
}
customElements.define("my-pane", MyPane);

registerView({
  id: "my-pane",
  label: "My Pane",
  icon: "sparkles",        // ui-core icon name
  elementTag: "my-pane",
  order: 100,              // sort order in the split-tile menu
});
```

The user can now split any existing tile into this view. The tile
leaf instantiates your element on render and passes `session` and
`path` props — respect them or ignore them as needed.

## Recipe 5 — drive the UI from the CLI (probe + Playwright)

`just ui-probe <subcommand>` launches a headless Chromium, drives the
live UI, and prints results. Useful for:

- Screenshotting the current state (`just ui-probe screenshot /tmp/f.png`)
- Clicking a selector (`just ui-probe click 'foyer-main-menu button'`)
- Evaluating JS against `window.__foyer` (`just ui-probe eval 'window.__foyer.store.state.status'`)
- Dumping diagnostics (`just ui-probe dump`)

Under the hood: `web/ui-tests/probe.js` — extend it with more
subcommands as you need them.

For deeper smoke testing: `just test-ui` runs the Playwright spec
suite at `web/ui-tests/specs/*.spec.js`. Start with the existing
smoke and chrome specs; add new ones per feature you care about.

## Recipe 6 — skip ui-core entirely (bring your own UI framework)

foyer-core has zero DOM or Lit in it. A React UI would look like:

```jsx
// /ui-react/entry.jsx
import { bootFoyerCore } from "foyer-core";
import { registerUiVariant } from "foyer-core/registry/ui-variants.js";
import React from "react";
import { createRoot } from "react-dom/client";

registerUiVariant({
  id: "react",
  label: "React UI",
  match: () => 1,
  boot: async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const reactRoot = createRoot(root);
    const { App } = await import("./App.jsx");
    reactRoot.render(<App />);
    return { root, teardown: () => { reactRoot.unmount(); root.remove(); } };
  },
});
```

Your `App.jsx` reaches into `window.__foyer.store` and
`window.__foyer.ws` for state + wire access, exactly like the
shipping UI does. foyer-ui-core's tiling, windowing, and widgets are
optional — drop them if React's ecosystem has what you need.

## Debugging + dev flow

### Live reload

There isn't one built in — the browser caches aggressively. A quick
hard refresh (Ctrl+Shift+R / Cmd+Shift+R) bypasses the cache. If you
find yourself reloading a lot, consider dropping
`<meta http-equiv="Cache-Control" content="no-store" />` into your
`index.html` during dev.

### Inspecting state

Open DevTools console. `window.__foyer` gives you:

- `store` — the reactive state store (`window.__foyer.store.state`)
- `ws` — the WebSocket client; `.send({ type: "..." })` to poke commands
- `layout` — the layout store (current tile tree, floats, slot state)
- `mountVariant({ id: "..." })` — swap variants live without refresh

### Forcing a variant

```
http://127.0.0.1:3838/?ui=full
http://127.0.0.1:3838/?ui=touch
localStorage.setItem("foyer.ui.variant", "touch")
```

### Bypass the UI entirely (for scripts / agents)

```js
import { bootFoyerCore } from "foyer-core";
const { store, ws } = bootFoyerCore({ skipUi: true });
// store + ws are now live; no DOM painted.
ws.send({ type: "control_set", id: "transport.playing", value: true });
```

## The contracts that matter

You can safely break anything in `foyer-ui/` — it's the shipping UI,
not a library. But **these don't change without a schema bump**:

1. **WS wire format** — defined in
   `crates/foyer-schema/src/message.rs`. `Event`, `Command`, and
   `Envelope` are the shared vocabulary between browser + sidecar +
   shim. Change those, change every client.
2. **foyer-core's public barrel** — `web/core/index.js`. Add freely;
   remove with a migration note.
3. **Registry shapes** — `registerUiVariant`, `registerWidget`,
   `registerView`, `setFeatures`. Alternate UIs depend on these;
   treat them like a library's public API.

Everything else is fair game. Fork, mutate, experiment. The point of
the split is that a web UI author should be able to focus on
interaction + aesthetics without having to also own the wire
protocol, the audio ingress, or the RBAC model.

## Things that are not yet great

- **Per-control RBAC gating.** The shipping mixer/track-editor/plugin
  surfaces still render write controls for all roles; clicks denied
  for a viewer surface a banner instead of disabling up-front.
- **Live reload.** See above. A `foyer serve --watch` mode that
  sends a browser-side reload on file change would be nice.
- **Hot widget registration.** The widget registry is real but
  tile-leaf + most of the shipping UI still hardcode element tags.
  Migrating everything through the registry is a multi-touch sweep.
- **Tests.** The Playwright harness covers boot + chrome smoke but
  not feature-level interaction (drag, drop, beat-grid editing).

Patches welcome. Keep the dependency arrow one-way — core → ui-core
→ ui — and the split stays coherent.
