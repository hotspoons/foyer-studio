// Multi-monitor detection via the Window Management API.
//
// Chromium (≥100) ships `window.getScreenDetails()` behind the
// `window-management` permission. Firefox and Safari don't yet implement it
// (as of writing). We gracefully fall back to `window.screen` everywhere.
//
// Used by the layout FAB + slot picker to show "which monitor" when the user
// is on an ultrawide or a multi-head desktop.
//
// API surface:
//   probeScreens()   — async. returns ScreenReport.
//   watchScreens(cb) — subscribe to screenschange events.

/**
 * @typedef {Object} ScreenInfo
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 * @property {number} availLeft
 * @property {number} availTop
 * @property {number} availWidth
 * @property {number} availHeight
 * @property {boolean} isPrimary
 * @property {boolean} isInternal
 * @property {number} devicePixelRatio
 * @property {string} label
 */

/**
 * @typedef {Object} ScreenReport
 * @property {"full"|"fallback"|"denied"|"unsupported"} source
 * @property {ScreenInfo[]} screens
 * @property {ScreenInfo|null} current
 */

function asFallbackScreen() {
  const s = window.screen || {};
  return {
    left: 0,
    top: 0,
    width: s.width ?? window.innerWidth,
    height: s.height ?? window.innerHeight,
    availLeft: 0,
    availTop: 0,
    availWidth: s.availWidth ?? window.innerWidth,
    availHeight: s.availHeight ?? window.innerHeight,
    isPrimary: true,
    isInternal: true,
    devicePixelRatio: window.devicePixelRatio || 1,
    label: "Primary",
  };
}

function fromDetail(d) {
  return {
    left: d.left ?? 0,
    top: d.top ?? 0,
    width: d.width ?? 0,
    height: d.height ?? 0,
    availLeft: d.availLeft ?? 0,
    availTop: d.availTop ?? 0,
    availWidth: d.availWidth ?? d.width ?? 0,
    availHeight: d.availHeight ?? d.height ?? 0,
    isPrimary: !!d.isPrimary,
    isInternal: !!d.isInternal,
    devicePixelRatio: d.devicePixelRatio ?? window.devicePixelRatio ?? 1,
    label: d.label ?? "Screen",
  };
}

/** Attempt to read full multi-monitor details. Resolves to a ScreenReport. */
export async function probeScreens() {
  // Permissions gate — avoids an unprompted API call.
  try {
    if (!window.getScreenDetails) {
      return { source: "unsupported", screens: [asFallbackScreen()], current: asFallbackScreen() };
    }
    let permission = "granted";
    try {
      const r = await navigator.permissions?.query?.({ name: "window-management" });
      if (r && r.state) permission = r.state;
    } catch {}
    if (permission === "denied") {
      return { source: "denied", screens: [asFallbackScreen()], current: asFallbackScreen() };
    }
    const details = await window.getScreenDetails();
    const screens = (details.screens || []).map(fromDetail);
    const current = fromDetail(details.currentScreen || details.screens?.[0] || asFallbackScreen());
    return { source: "full", screens, current };
  } catch (err) {
    // Some browsers refuse from non-user-gesture contexts; fall back.
    console.debug("probeScreens fallback:", err);
    return { source: "fallback", screens: [asFallbackScreen()], current: asFallbackScreen() };
  }
}

/**
 * Subscribe to screen-topology changes when supported. Returns an unsubscribe
 * function. In unsupported browsers the callback never fires.
 */
export function watchScreens(cb) {
  let details = null;
  let cancelled = false;
  (async () => {
    try {
      if (!window.getScreenDetails) return;
      details = await window.getScreenDetails();
      if (cancelled) return;
      const handler = async () => {
        try {
          const next = await probeScreens();
          cb(next);
        } catch {}
      };
      details.addEventListener?.("screenschange", handler);
      details.addEventListener?.("currentscreenchange", handler);
    } catch {}
  })();
  return () => {
    cancelled = true;
  };
}

/** Quick sync check — does the browser advertise MM support at all? */
export function supportsMultiMonitor() {
  return typeof window.getScreenDetails === "function";
}
