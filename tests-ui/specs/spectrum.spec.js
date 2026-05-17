// SPDX-License-Identifier: Apache-2.0
//
// Spectrum analyser smoke. Verifies:
//
//   1. The stub backend advertises `session.spectrum.available = true`
//      on the snapshot.
//   2. `subscribe_spectrum` → `spectrum_subscribed` ack → a stream of
//      `spectrum_frame` events round-trip through the WS.
//   3. The `<foyer-spectrum-tile>` view mounts cleanly inside the tile
//      tree and renders a non-blank canvas after a few frames.
//
// Doesn't try to assert on pixel content — that's renderer-dependent
// and brittle. Instead samples the waterfall canvas after a settle
// window and asserts at least one non-background pixel exists.

import { test, expect } from "@playwright/test";
import { primeSessionsList, DEEP_FIND } from "./_boot.js";

test.describe("spectrum analyser", () => {
  test("session snapshot advertises spectrum capability", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
    await page.waitForFunction(
      () => !!window.__foyer?.store?.state?.session?.spectrum,
    );
    const caps = await page.evaluate(
      () => window.__foyer.store.state.session.spectrum,
    );
    expect(caps.available).toBe(true);
    expect(Array.isArray(caps.fft_sizes)).toBe(true);
    expect(caps.fft_sizes.length).toBeGreaterThan(0);
    expect(caps.max_frame_rate_hz).toBeGreaterThan(0);
  });

  test("subscribe → spectrum_frame stream → unsubscribe round-trip", async ({
    page,
  }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");

    // Subscribe to the master bus and collect every spectrum_* envelope.
    await page.evaluate(() => {
      window.__spectrum_envelopes = [];
      window.__foyer.ws.addEventListener("envelope", (ev) => {
        const t = ev.detail?.body?.type;
        if (
          t === "spectrum_subscribed"
          || t === "spectrum_unsubscribed"
          || t === "spectrum_frame"
        ) {
          window.__spectrum_envelopes.push(ev.detail.body);
        }
      });
      window.__foyer.ws.send({
        type: "subscribe_spectrum",
        target: { kind: "master" },
        opts: { fft_size: 1024 },
      });
    });

    // Wait until at least the ack + a few frames have landed.
    await page.waitForFunction(() => {
      const ev = window.__spectrum_envelopes || [];
      const frames = ev.filter((b) => b.type === "spectrum_frame").length;
      const ack = ev.some((b) => b.type === "spectrum_subscribed");
      return ack && frames >= 3;
    });

    const summary = await page.evaluate(() => {
      const ev = window.__spectrum_envelopes;
      const ack = ev.find((b) => b.type === "spectrum_subscribed");
      const frames = ev.filter((b) => b.type === "spectrum_frame");
      const first = frames[0];
      return {
        ack_target: ack?.target,
        frame_count: frames.length,
        first_bins: first?.frame?.bins,
        first_channels: first?.frame?.channels?.length,
        first_sample_rate: first?.frame?.sample_rate,
      };
    });
    expect(summary.ack_target).toEqual({ kind: "master" });
    expect(summary.frame_count).toBeGreaterThan(0);
    expect(summary.first_bins).toBeGreaterThan(0);
    expect(summary.first_channels).toBeGreaterThan(0);
    expect(summary.first_sample_rate).toBeGreaterThan(0);

    // Unsubscribe cleanly; expect an ack.
    await page.evaluate(() => {
      window.__spectrum_envelopes_after = [];
      const before = window.__spectrum_envelopes.length;
      window.__foyer.ws.addEventListener("envelope", (ev) => {
        const t = ev.detail?.body?.type;
        if (t === "spectrum_unsubscribed") {
          window.__spectrum_envelopes_after.push(ev.detail.body);
        }
      });
      window.__foyer.ws.send({
        type: "unsubscribe_spectrum",
        target: { kind: "master" },
      });
      void before;
    });
    await page.waitForFunction(
      () => (window.__spectrum_envelopes_after || []).length > 0,
    );
  });

  test("spectrum tile mounts and renders frames", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
    await page.waitForFunction(
      () => typeof window.__foyer?.layout?.setTree === "function",
    );
    // Prime the sessions list so the welcome screen doesn't gate the
    // tile container (stub backend doesn't register a session by
    // default — see _boot.js).
    await primeSessionsList(page);

    // Swap the tile tree to a single spectrum tile.
    await page.evaluate(() => {
      window.__foyer.layout.setTree({
        kind: "leaf",
        id: "spec_tile",
        view: "spectrum",
        props: {},
      });
    });

    // Wait for the inner spectrum element to mount AND collect a few frames.
    await page.waitForFunction(`(() => {
      ${DEEP_FIND}
      const inner = deepFind("foyer-spectrum");
      return !!inner;
    })()`);

    await page.waitForFunction(`(() => {
      ${DEEP_FIND}
      const inner = deepFind("foyer-spectrum");
      return (inner?._history?.length || 0) >= 5;
    })()`);

    const result = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const inner = deepFind("foyer-spectrum");
      const waterfall = inner?.renderRoot?.querySelector("canvas.waterfall");
      const bars = inner?.renderRoot?.querySelector("canvas.bars");
      const hasCanvases = !!waterfall && !!bars;
      // Sample a few pixels in the middle of the waterfall — at least
      // one should be non-(0,0,0) once enough frames have arrived.
      let nonBlack = 0;
      if (waterfall) {
        const ctx = waterfall.getContext("2d");
        try {
          const w = waterfall.width;
          const h = waterfall.height;
          const data = ctx.getImageData(Math.max(0, w - 4), 0, 4, h).data;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] || data[i + 1] || data[i + 2]) nonBlack++;
          }
        } catch (e) { /* ignore */ }
      }
      return { hasCanvases, nonBlack, history: inner._history.length };
    })()`);

    expect(result.hasCanvases).toBe(true);
    expect(result.history).toBeGreaterThanOrEqual(5);
    // At least SOME painted pixels in the rightmost 4 columns of the waterfall.
    expect(result.nonBlack).toBeGreaterThan(0);
  });
});
