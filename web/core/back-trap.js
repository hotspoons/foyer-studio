// Browser back-button trap.
//
// Foyer is a single-page DAW surface — there's no "previous page" the
// user usefully wants to navigate to, and the back button is most
// often hit by accident (the engineer reaches for "rewind to start"
// and the gesture overshoots into the browser chrome). Instead of
// surrendering the tab, we keep one sentinel history entry ahead of
// the user at all times: when popstate fires we re-push that sentinel
// and translate the gesture into a transport rewind-to-zero.
//
// The user can still close the tab to actually leave Foyer; this
// trap is specifically for the chrome back arrow.

const SENTINEL = "foyer:back-sentinel";

/**
 * Install the trap. Idempotent — calling twice is a no-op.
 *
 * @param {Object} args
 * @param {{ controlSet: (id: string, v: unknown) => void } | null} args.ws
 * @param {EventTarget & { releaseTransportPositionLock?: () => void }} args.store
 */
export function installBackTrap({ ws, store }) {
  if (globalThis.__foyer_back_trap_installed) return;
  globalThis.__foyer_back_trap_installed = true;

  // The browser preserves `history.state` across full page reloads,
  // so on a refresh we'll already be sitting on the sentinel from
  // the previous session — pushing again would stack a new entry
  // every time the user hits Cmd-R, polluting the back history with
  // dozens of "Foyer Studio" entries. Only push when we're NOT
  // already at a sentinel.
  if (!isSentinelState(history.state)) {
    pushSentinel();
  }

  window.addEventListener("popstate", () => {
    // After the navigation settles we need TWO entries again — the
    // current one (which the user just landed on) plus a fresh
    // sentinel above it for the next back press to consume. We
    // cover both in one rearm helper so the trap is back to its
    // armed shape regardless of how many sentinel entries the page
    // started with (useful when migrating from the older buggy
    // version that had stacked dozens of them).
    //
    // The deferral is load-bearing: Safari and some Chrome builds
    // drop a synchronous pushState made inside a popstate handler.
    // setTimeout(0) lets the navigation event flush first.
    setTimeout(rearm, 0);

    try {
      store?.releaseTransportPositionLock?.();
    } catch {}
    try {
      ws?.controlSet?.("transport.position", 0);
    } catch {}
  });
}

function rearm() {
  // Stamp the current entry so a refresh in this position is
  // recognized as "already armed" by `installBackTrap`, and push a
  // fresh sentinel above it for the next back press.
  try {
    if (!isSentinelState(history.state)) {
      history.replaceState({ [SENTINEL]: 1 }, "", location.href);
    }
    history.pushState({ [SENTINEL]: 1 }, "", location.href);
  } catch {
    // Sandboxed contexts (data: URIs, restrictive CSPs) reject
    // history mutation — the trap is best-effort.
  }
}

function isSentinelState(state) {
  return !!(state && typeof state === "object" && state[SENTINEL]);
}

function pushSentinel() {
  try {
    history.pushState({ [SENTINEL]: 1 }, "", location.href);
  } catch {
    // Some sandboxed contexts (data: URIs, headless test pages with
    // strict CSP, etc.) reject pushState — the trap is best-effort.
  }
}
