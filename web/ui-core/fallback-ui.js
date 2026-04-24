// Fallback shell — shown when foyer-core boots but no UI variant is
// registered (or all registered variants chose to match: 0 for the
// current device).
//
// Intentionally plain. No Lit, no Tailwind dependency, no routing,
// no registrations. Works against raw DOM so a reader ripping out
// ui-core and writing their own front-end can still see something
// useful during development.
//
// If you're seeing this shell and you DID register a variant:
//   · check DevTools console for `[foyer-core] variant mount failed`
//   · check that your variant's `match(env)` returns > 0 for your
//     viewport
//   · pass `?ui=<yourId>` on the URL to force it

const CSS = `
  :host, .foyer-fallback {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                 Inter, sans-serif;
    background: radial-gradient(ellipse at top, #1a1d24 0%, #0c0e12 65%);
    color: #cfd3da;
    z-index: 9999;
    padding: 2rem;
    text-align: center;
  }
  .foyer-fallback h1 {
    margin: 0;
    font-size: 2.25rem;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: #e9ecf1;
  }
  .foyer-fallback h1 .dot {
    display: inline-block;
    width: 0.6em;
    height: 0.6em;
    border-radius: 50%;
    background: #6bc48a;
    margin-right: 0.35em;
    vertical-align: middle;
    box-shadow: 0 0 14px #6bc48a;
    animation: foyer-pulse 2s ease-in-out infinite;
  }
  .foyer-fallback p {
    margin: 0;
    max-width: 34rem;
    line-height: 1.5;
    color: #9aa0aa;
  }
  .foyer-fallback code {
    background: rgba(255, 255, 255, 0.06);
    padding: 0.1em 0.4em;
    border-radius: 4px;
    font-size: 0.9em;
    color: #d6c694;
  }
  .foyer-fallback .status {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    font-size: 0.9rem;
    color: #7f8692;
    margin-top: 0.5rem;
  }
  .foyer-fallback .status .chip {
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    padding: 0.15rem 0.65rem;
    font-variant-numeric: tabular-nums;
  }
  .foyer-fallback .status .chip.live   { border-color: rgba(107, 196, 138, 0.5); color: #cfeedd; }
  .foyer-fallback .status .chip.closed { border-color: rgba(226, 120, 120, 0.5); color: #f4c2c2; }
  @keyframes foyer-pulse {
    0%, 100% { box-shadow: 0 0 14px #6bc48a; transform: scale(1); }
    50%      { box-shadow: 0 0 4px  #6bc48a; transform: scale(0.9); }
  }
`;

/**
 * Paint the fallback shell into document.body and wire live status.
 * Returns `{ root, teardown }` in the same shape variant.boot() uses.
 */
export async function mountFallback({ reason = "no-variant-registered" } = {}) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.className = "foyer-fallback";
  root.setAttribute("data-reason", reason);
  root.innerHTML = `
    <h1><span class="dot"></span>If you lived here, you'd be home now</h1>
    <p>
      <strong>foyer-core</strong> is running and your back-end is reachable,
      but no UI variant has been registered for this device.
      Import a <code>foyer-ui-*</code> package or your own renderer to take
      over this surface.
    </p>
    <p>
      Force a specific variant with <code>?ui=&lt;id&gt;</code>, or set
      <code>localStorage['foyer.ui.variant']</code>. Pick from the registry
      via <code>__foyer.mountVariant({ id })</code>.
    </p>
    <div class="status">
      <span class="chip" data-role="status">ws: connecting…</span>
      <span class="chip" data-role="peers">peers: 0</span>
      <span class="chip" data-role="reason">reason: ${reason}</span>
    </div>
  `;
  document.body.appendChild(root);

  // Wire live status — uses the global store when available.
  const statusEl = root.querySelector('[data-role="status"]');
  const peersEl = root.querySelector('[data-role="peers"]');
  const store = globalThis.__foyer?.store;
  const offs = [];
  if (store) {
    const refresh = () => {
      const s = store.state;
      const st = s.status || "idle";
      statusEl.textContent = `ws: ${st}`;
      statusEl.className = `chip ${st === "open" ? "live" : st === "closed" || st === "error" ? "closed" : ""}`;
      const peers = s.peers?.size ?? 0;
      peersEl.textContent = `peers: ${peers}`;
    };
    refresh();
    const onChange = () => refresh();
    store.addEventListener("change", onChange);
    offs.push(() => store.removeEventListener("change", onChange));
  }

  return {
    root,
    teardown: () => {
      for (const off of offs) { try { off(); } catch { /* ignore */ } }
      root.remove();
      style.remove();
    },
  };
}
