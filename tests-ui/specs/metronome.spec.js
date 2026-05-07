// Metronome surface — visibility (Show/Hide row in the mixer config
// popup → localStorage pref) and engine state (M button on the strip
// → `transport.metronome`) are independent. The strip stays open
// when muted, with the fader disabled.
import { test, expect } from "@playwright/test";
import { DEEP_FIND, primeSessionsList } from "./_boot.js";

const PREF_KEY = "foyer.mixer.show-metronome-strip.v1";

test("metronome strip: visibility pref + engine mute are independent", async ({ page }) => {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.waitForFunction(
    () => typeof window.__foyer?.layout?.setTree === "function",
  );
  await primeSessionsList(page);
  await page.evaluate(() => {
    window.__foyer.layout.setTree({ kind: "leaf", id: "t_mix", view: "mixer", props: {} });
  });
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    return !!deepFind("foyer-mixer");
  })()`);

  // Schema must surface metronome — otherwise the icon won't render.
  const hasMetronomeShape = await page.evaluate(() => {
    const t = window.__foyer.store.state.session?.transport;
    return !!t?.metronome && !!t?.metronome_gain && !!t?.metronome_peak;
  });
  expect(hasMetronomeShape).toBe(true);

  // Reset to a known state. Strip pref off; engine clicking off.
  // The previous run of this very test ends with clicking=on (after
  // un-muting via M); the stub-backend process persists state across
  // page reloads in the same playwright session, so we have to walk
  // it back to zero or the snapshot served on the next reload still
  // reports clicking=on.
  await page.evaluate((key) => localStorage.setItem(key, "0"), PREF_KEY);
  await page.evaluate(() => window.__foyer.ws.controlSet("transport.metronome", 0));
  await page.waitForFunction(
    () => {
      const v = window.__foyer.store.state.controls.get("transport.metronome");
      // `undefined` does NOT count as "off" — it just means the
      // controls map hasn't received an echo for this key yet, in
      // which case we keep waiting.
      return v === false || v === 0;
    },
  );
  await page.reload();
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await primeSessionsList(page);
  await page.evaluate(() => {
    window.__foyer.layout.setTree({ kind: "leaf", id: "t_mix", view: "mixer", props: {} });
  });
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    return !!deepFind("foyer-mixer");
  })()`);

  // Strip not mounted yet.
  const stripBefore = await page.evaluate(`(() => {
    ${DEEP_FIND}
    return !!deepFind("foyer-metronome-strip");
  })()`);
  expect(stripBefore).toBe(false);

  // Click "Show" in the mixer config popup → strip mounts.
  await page.evaluate(`(() => {
    ${DEEP_FIND}
    const mx = deepFind("foyer-mixer");
    const buttons = [...mx.shadowRoot.querySelectorAll("details.mx-menu .group button")];
    const showBtn = buttons.find((b) => b.textContent.trim() === "Show");
    showBtn.click();
  })()`);
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    return !!deepFind("foyer-metronome-strip");
  })()`);

  // Strip width is the declared 35 px (±2 for box-sizing rounding).
  const width = await page.evaluate(`(() => {
    ${DEEP_FIND}
    const s = deepFind("foyer-metronome-strip");
    return Math.round(s.getBoundingClientRect().width);
  })()`);
  expect(width).toBeGreaterThanOrEqual(33);
  expect(width).toBeLessThanOrEqual(37);

  // Engine clicking is still off → M button on strip is lit. Wait
  // for the snapshot's transport.metronome value to reach the
  // controls map before asserting (Lit's first render of the strip
  // may run before the snapshot's value is hydrated). Type can be
  // bool `false` from the snapshot or `0` from a recent ControlSet
  // echo — accept either.
  await page.waitForFunction(
    () => {
      const v = window.__foyer.store.state.controls.get("transport.metronome");
      return v !== undefined && !v;
    },
  );
  const muteOnAtOpen = await page.evaluate(`(() => {
    ${DEEP_FIND}
    const strip = deepFind("foyer-metronome-strip");
    const m = strip.shadowRoot.querySelector("foyer-toggle");
    return !!m.on;
  })()`);
  expect(muteOnAtOpen).toBe(true);

  // Press M (un-mute) → engine flips on, strip stays mounted.
  await page.evaluate(`(() => {
    ${DEEP_FIND}
    const strip = deepFind("foyer-metronome-strip");
    const m = strip.shadowRoot.querySelector("foyer-toggle");
    m.dispatchEvent(new CustomEvent("input", { detail: { value: false }, bubbles: true, composed: true }));
  })()`);
  await page.waitForFunction(
    () => !!window.__foyer.store.state.controls.get("transport.metronome"),
  );
  const stripStillThere = await page.evaluate(`(() => {
    ${DEEP_FIND}
    return !!deepFind("foyer-metronome-strip");
  })()`);
  expect(stripStillThere).toBe(true);

  // Click "Hide" in the mixer config popup → strip retracts. Engine
  // state is unchanged — visibility is independent of clicking.
  await page.evaluate(`(() => {
    ${DEEP_FIND}
    const mx = deepFind("foyer-mixer");
    const buttons = [...mx.shadowRoot.querySelectorAll("details.mx-menu .group button")];
    const hideBtn = buttons.find((b) => b.textContent.trim() === "Hide");
    hideBtn.click();
  })()`);
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    return !deepFind("foyer-metronome-strip");
  })()`);
  const engineStillOn = await page.evaluate(
    () => !!window.__foyer.store.state.controls.get("transport.metronome"),
  );
  expect(engineStillOn).toBe(true);
});
