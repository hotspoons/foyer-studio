// Smoke for the desktop Take ("I") chip on `<foyer-track-strip>`. The
// chip's logic lives in `web/core/audio/track-mic.js` (shared with
// the phone surface), and this test asserts:
//   * The chip renders next to M/S/● when an audio track exists,
//     `control_set` is allowed, and `rbac.isTunnel` is true.
//   * It does NOT render on MIDI tracks even when tunnel is on.
//   * `isTunnel=false` hides the chip entirely (host workflow — the
//     studio rig already has the mic, browser ingress would just add
//     latency).
//
// Stub backend has no real tunnel, so we poke `store.state.rbac` to
// flip the flag client-side. The chip's gating reads from there
// directly, so this is the same view the production UI sees on a
// genuine tunnel guest.

import { test, expect } from "@playwright/test";
import { primeSessionsList, DEEP_FIND } from "./_boot.js";

const DEEP = `
  ${DEEP_FIND}
  function deepFindAll(tag) {
    const out = [];
    const stack = [document.querySelector("foyer-app").shadowRoot];
    while (stack.length) {
      const r = stack.pop();
      for (const el of r.querySelectorAll(tag)) out.push(el);
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) stack.push(el.shadowRoot);
    }
    return out;
  }
`;

async function bootMixer(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.waitForFunction(() => typeof window.__foyer?.layout?.setTree === "function");
  await primeSessionsList(page);
  await page.evaluate(() => {
    window.__foyer.layout.setTree({ kind: "leaf", id: "t", view: "mixer", props: {} });
  });
  await page.waitForFunction(`(() => { ${DEEP} return !!deepFind("foyer-mixer"); })()`);
}

async function findStrip(page, kind) {
  return page.evaluateHandle(
    `(() => { ${DEEP}
      const strips = deepFindAll("foyer-track-strip");
      return strips.find((s) => s.track?.kind === ${JSON.stringify(kind)}) || null;
    })()`,
  );
}

async function setTunnel(page, on) {
  // Forge a permissive role too: isTunnel=true with an empty roleAllow
  // would deny `control_set`, which the chip's RBAC gate uses, and the
  // chip would stay hidden for reasons unrelated to what we're testing.
  // In real production a tunnel client always carries an assigned role
  // — we mirror that with a wildcard allow.
  await page.evaluate((on) => {
    const s = window.__foyer.store;
    if (!s.state.rbac) s.state.rbac = {};
    s.state.rbac.isTunnel = !!on;
    s.state.rbac.isAuthenticated = true;
    s.state.rbac.roleAllow = on ? ["*"] : [];
    s.dispatchEvent(new CustomEvent("change"));
  }, on);
}

test.describe("desktop Take chip", () => {
  test("renders alongside M/S/● on audio tracks (no tunnel required)", async ({ page }) => {
    // Desktop chip is intentionally NOT gated on tunnel — the desktop
    // UI is frequently a remote control surface against a DAW
    // running elsewhere (Cloud Run, studio LAN, container) where
    // `rbac.isTunnel` is false. Boot WITHOUT flipping the tunnel
    // flag and assert the chip still appears.
    await bootMixer(page);
    await setTunnel(page, false);

    await page.waitForFunction(`(() => { ${DEEP} return deepFindAll("foyer-track-strip").length > 0; })()`);

    const result = await page.evaluate(`(() => { ${DEEP}
      const strips = deepFindAll("foyer-track-strip");
      const audio = strips.find((s) => s.track?.kind === "audio");
      if (!audio) return { error: "no audio strip", count: strips.length };
      audio.requestUpdate();
      return audio.updateComplete.then(() => {
        const toggles = audio.shadowRoot.querySelectorAll("foyer-toggle");
        const labels = Array.from(toggles).map((t) => t.label);
        const take = audio.shadowRoot.querySelector("foyer-toggle.take-toggle");
        return { labels, hasTake: !!take, takeLabel: take?.label };
      });
    })()`);

    expect(result.hasTake).toBe(true);
    expect(result.takeLabel).toBe("I");
    expect(result.labels).toContain("I");
    expect(result.labels).toContain("M");
    expect(result.labels).toContain("S");
  });

  test("renders under a tunnel guest too", async ({ page }) => {
    // Same chip should appear regardless of tunnel flag — the
    // earlier gating that hid this for non-tunnel hosts is the
    // exact regression this test guards against.
    await bootMixer(page);
    await setTunnel(page, true);
    await page.waitForFunction(`(() => { ${DEEP} return deepFindAll("foyer-track-strip").length > 0; })()`);

    const hasTake = await page.evaluate(`(() => { ${DEEP}
      const strips = deepFindAll("foyer-track-strip");
      const audio = strips.find((s) => s.track?.kind === "audio");
      if (!audio) return false;
      audio.requestUpdate();
      return audio.updateComplete.then(() => !!audio.shadowRoot.querySelector("foyer-toggle.take-toggle"));
    })()`);

    expect(hasTake).toBe(true);
  });

  test("does not render on MIDI tracks", async ({ page }) => {
    await bootMixer(page);
    await page.waitForFunction(`(() => { ${DEEP} return deepFindAll("foyer-track-strip").length > 0; })()`);

    const hasTake = await page.evaluate(`(() => { ${DEEP}
      const strips = deepFindAll("foyer-track-strip");
      const midi = strips.find((s) => s.track?.kind === "midi");
      if (!midi) return null;        // session has no MIDI track — skip
      midi.requestUpdate();
      return midi.updateComplete.then(() => !!midi.shadowRoot.querySelector("foyer-toggle.take-toggle"));
    })()`);

    if (hasTake === null) {
      test.info().annotations.push({ type: "skip", description: "no MIDI track in stub session" });
      return;
    }
    expect(hasTake).toBe(false);
  });

  test("hides when control_set is denied", async ({ page }) => {
    // RBAC gate is the load-bearing one now that tunnel is dropped
    // — a viewer-role tunnel guest with no control_set perm should
    // NOT see the chip.
    await bootMixer(page);
    await page.evaluate(() => {
      const s = window.__foyer.store;
      if (!s.state.rbac) s.state.rbac = {};
      s.state.rbac.isTunnel = true;
      s.state.rbac.isAuthenticated = true;
      s.state.rbac.roleAllow = [];   // deny everything
      s.dispatchEvent(new CustomEvent("change"));
    });
    await page.waitForFunction(`(() => { ${DEEP} return deepFindAll("foyer-track-strip").length > 0; })()`);

    const hasTake = await page.evaluate(`(() => { ${DEEP}
      const strips = deepFindAll("foyer-track-strip");
      const audio = strips.find((s) => s.track?.kind === "audio");
      if (!audio) return false;
      audio.requestUpdate();
      return audio.updateComplete.then(() => !!audio.shadowRoot.querySelector("foyer-toggle.take-toggle"));
    })()`);

    expect(hasTake).toBe(false);
  });
});
