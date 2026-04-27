// Transport-bar session-meta cluster: clock readout, time-signature
// num/den, hideable as a unit. Covers TODO #131-#132 (clock view) and
// #131 (time signature surface).

import { test, expect } from "@playwright/test";

const DEEP_FIND = `
  function deepFind(tag) {
    const stack = [document.querySelector("foyer-app").shadowRoot];
    while (stack.length) {
      const r = stack.pop();
      const hit = r.querySelector(tag);
      if (hit) return hit;
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) stack.push(el.shadowRoot);
    }
    return null;
  }
`;

async function bootSession(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.waitForFunction(
    () => typeof window.__foyer?.layout?.setTree === "function",
  );
  // Mount any session-loaded view so foyer-transport-bar is in the
  // render tree (welcome screen suppresses it).
  await page.evaluate(() => {
    window.__foyer.layout.setTree({
      kind: "leaf", id: "test_t", view: "timeline", props: {},
    });
  });
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    return !!deepFind("foyer-transport-bar");
  })()`);
}

test.describe("transport meta cluster", () => {
  test.setTimeout(60_000);

  test("clock readout shows time + bar.beat.16th, time signature is 4/4 by default", async ({ page }) => {
    await bootSession(page);
    const readout = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tb = deepFind("foyer-transport-bar");
      const sr = tb.shadowRoot;
      const clock = sr.querySelector(".clock");
      const tsInputs = sr.querySelectorAll(".ts input");
      return {
        clockText: clock?.innerText || null,
        tsNum: tsInputs[0]?.value,
        tsDen: tsInputs[1]?.value,
      };
    })()`);
    // Two lines: M:SS.mmm and bar.beat.subdiv.
    expect(readout.clockText).toMatch(/^\d+:\d{2}\.\d{3}\n\d+\.\d+\.\d+$/);
    expect(readout.tsNum).toBe("4");
    expect(readout.tsDen).toBe("4");
  });

  test("eye toggle hides the cluster and persists across reload", async ({ page }) => {
    await bootSession(page);
    // Hide.
    await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tb = deepFind("foyer-transport-bar");
      tb.shadowRoot.querySelector(".meta-toggle").click();
    })()`);
    expect(await page.evaluate(`(() => {
      ${DEEP_FIND}
      return !!deepFind("foyer-transport-bar").shadowRoot.querySelector(".meta-cluster");
    })()`)).toBe(false);
    expect(await page.evaluate(() =>
      localStorage.getItem("foyer.transport.show-meta.v1"),
    )).toBe("0");

    // Reload — cluster stays hidden.
    await page.reload();
    await page.waitForFunction(
      () => typeof window.__foyer?.layout?.setTree === "function",
    );
    await page.evaluate(() => {
      window.__foyer.layout.setTree({
        kind: "leaf", id: "test_t", view: "timeline", props: {},
      });
    });
    await page.waitForFunction(`(() => {
      ${DEEP_FIND}
      return !!deepFind("foyer-transport-bar");
    })()`);
    const stillHidden = await page.evaluate(`(() => {
      ${DEEP_FIND}
      return !!deepFind("foyer-transport-bar").shadowRoot.querySelector(".meta-cluster");
    })()`);
    expect(stillHidden).toBe(false);

    // Click again to restore.
    await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tb = deepFind("foyer-transport-bar");
      tb.shadowRoot.querySelector(".meta-toggle").click();
    })()`);
    expect(await page.evaluate(`(() => {
      ${DEEP_FIND}
      return !!deepFind("foyer-transport-bar").shadowRoot.querySelector(".meta-cluster");
    })()`)).toBe(true);
  });

  test("ts inputs surface time-signature controls and snap-to-power-of-2", async ({ page }) => {
    // The live WS round-trip is exercised by the smoke spec; here we
    // verify the bits that are TRANSPORT-BAR specific and don't need
    // the server: the inputs surface ts.num / ts.den from the store,
    // and the denominator handler snaps non-pow-2 input to the nearest
    // power of 2 before sending. Driving the handler directly avoids a
    // race we hit when two consecutive transport.* controlSets land on
    // the stub WS while a timeline view is also mounted (see the
    // probe-tsA.js notes — unrelated to this feature, separate fix).
    await bootSession(page);
    const surfaced = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tb = deepFind("foyer-transport-bar");
      return {
        num: tb.shadowRoot.querySelectorAll(".ts input")[0]?.value,
        den: tb.shadowRoot.querySelectorAll(".ts input")[1]?.value,
        ctlNum: window.__foyer.store.state.controls.get("transport.ts.num"),
        ctlDen: window.__foyer.store.state.controls.get("transport.ts.den"),
      };
    })()`);
    // Inputs reflect the live store values.
    expect(Number(surfaced.num)).toBe(Number(surfaced.ctlNum));
    expect(Number(surfaced.den)).toBe(Number(surfaced.ctlDen));

    // Handler snaps 5 → 4 (closest power of 2). We capture what the
    // handler tries to write rather than asserting the live store
    // (the snap behavior is purely client-side, no need to round-trip).
    const snapped = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tb = deepFind("foyer-transport-bar");
      let lastSent = null;
      const orig = window.__foyer.ws.controlSet.bind(window.__foyer.ws);
      window.__foyer.ws.controlSet = (id, v) => { if (id === "transport.ts.den") lastSent = v; return orig(id, v); };
      try {
        tb._onTsDen({ currentTarget: { value: "5" } });
      } finally {
        window.__foyer.ws.controlSet = orig;
      }
      return lastSent;
    })()`);
    expect(snapped).toBe(4);
  });
});
