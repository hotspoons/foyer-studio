// "Tap to enable audio" — phone tunnel-guest gesture-handoff guard.
//
// Background. master-controller.js installs a capture-phase
// pointerdown handler on `window` that auto-starts the listener on
// the very first user gesture. To avoid the "tap a Listen button →
// gesture handler starts audio → button's @click sees `_on=true` →
// stops it" double-fire, the handler hands off (unbinds without
// starting) when the gesture's composedPath includes any element
// carrying `data-foyer-listen-toggle="1"`. Listen buttons in the
// phone top-bar and the desktop mixer have that marker.
//
// The phone's tunnel-only "Tap to enable audio" prompt was missing
// the marker, so the gesture handler always fired BEFORE the
// prompt's @click handler — net effect was audio plays for ~50ms
// then stops, prompt stays visible. This spec asserts the marker is
// in place so a refactor doesn't regress the fix.

import { test, expect } from "@playwright/test";

const DEEP_FIND_PHONE = `
  function deepFindPhone(tag) {
    const root = document.querySelector("foyer-phone-app");
    if (!root) return null;
    const stack = [root.shadowRoot];
    while (stack.length) {
      const r = stack.pop();
      const hit = r.querySelector(tag);
      if (hit) return hit;
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) stack.push(el.shadowRoot);
    }
    return null;
  }
`;

async function gotoPhone(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/?ui=phone");
  await page.waitForFunction(() => !!document.querySelector("foyer-phone-app"));
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
}

test.describe("phone tunnel-audio-prompt", () => {
  test("carries data-foyer-listen-toggle so the auto-start gesture handler hands off", async ({ page }) => {
    await gotoPhone(page);
    // Land on an open session (the prompt is gated on `hasSession`).
    await page.evaluate(() => {
      window.__foyer.ws.send({
        type: "launch_project", backend_id: "stub", project_path: "",
      });
    });
    await page.waitForFunction(() => !!window.__foyer.store.currentSession());

    // Force the prompt's two other gates: tunnel guest + audio off.
    // The stub backend reports `is_local: true` so we'd normally skip
    // the prompt; flip rbac.isTunnel + reset audio so the phone shell
    // shows the bar.
    await page.evaluate(() => {
      const s = window.__foyer.store;
      if (!s.state.rbac) s.state.rbac = {};
      s.state.rbac.isTunnel = true;
      s.dispatchEvent(new CustomEvent("change"));
      // Drop any in-flight listener so the prompt's `_audioOn` is
      // false on next render.
      try { window.__foyer.audio.stop({ silent: true }); } catch {}
    });

    // Wait for the prompt to actually render — the phone shell's
    // _audioOn doesn't flip until the audio controller emits a
    // `change`, which the synchronous stop above triggers.
    await page.waitForFunction(`(() => {
      ${DEEP_FIND_PHONE}
      return !!deepFindPhone(".tunnel-audio-prompt");
    })()`);

    const probe = await page.evaluate(`(() => {
      ${DEEP_FIND_PHONE}
      const el = deepFindPhone(".tunnel-audio-prompt");
      return {
        present: !!el,
        marker: el?.dataset?.foyerListenToggle ?? null,
        text: (el?.textContent ?? "").trim(),
      };
    })()`);

    expect(probe.present).toBe(true);
    expect(probe.text).toMatch(/tap to enable/i);
    // Load-bearing: without this attribute the master-controller's
    // gesture handler would auto-start audio in capture phase, the
    // prompt's click would then toggle it off, and the user-visible
    // result is "tap does nothing."
    expect(probe.marker).toBe("1");
  });
});
