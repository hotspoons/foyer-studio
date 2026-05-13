// End-to-end smoke for the multi-window family.
//
// Opens two pages in one browser context — the second carries
// `?parent=<first-page-peer-id>` — and asserts:
//
//   1. The first connection comes up as Primary with a freshly-minted
//      peer_id.
//   2. The second connection adopts the parent's peer_id and lands as
//      Secondary.
//   3. The BroadcastChannel hello round-trip populates the sibling
//      table on BOTH windows.
//   4. The audio gate rejects `audio_ingress_open` from the Secondary
//      with the `secondary_window_audio` error code.

import { test, expect } from "@playwright/test";

const SLOT = "1";

async function readConnection(page) {
  return await page.evaluate(() => ({
    connection: window.__foyer.store.state.connection,
    role: window.__foyer.multiWindow?.role,
    peer: window.__foyer.multiWindow?.peerId,
    siblings: window.__foyer.multiWindow?.siblings || [],
    slot: window.__foyer.windowSlotId,
  }));
}

test("primary + secondary windows share peer_id and audio is gated", async ({ browser }) => {
  const ctx = await browser.newContext();
  // First (primary) window.
  const primaryPage = await ctx.newPage();
  await primaryPage.goto("/");
  await primaryPage.waitForFunction(
    () => window.__foyer?.store?.state?.connection?.peerId,
    null,
    { timeout: 10_000 },
  );
  const primary = await readConnection(primaryPage);
  expect(primary.role).toBe("primary");
  expect(primary.slot).toBe("0");
  expect(typeof primary.peer).toBe("string");
  expect(primary.peer.length).toBeGreaterThan(8);

  // Second (secondary) window attached via ?parent=.
  const secondaryPage = await ctx.newPage();
  await secondaryPage.goto(`/?parent=${primary.peer}&slot=${SLOT}`);
  await secondaryPage.waitForFunction(
    () => window.__foyer?.store?.state?.connection?.peerId,
    null,
    { timeout: 10_000 },
  );
  const secondary = await readConnection(secondaryPage);
  expect(secondary.peer).toBe(primary.peer);
  expect(secondary.role).toBe("secondary");
  expect(secondary.slot).toBe(SLOT);

  // BroadcastChannel hello settles within a few hundred ms.
  await primaryPage.waitForFunction(
    () => (window.__foyer.multiWindow?.siblings || []).length === 1,
    null,
    { timeout: 3000 },
  );
  await secondaryPage.waitForFunction(
    () => (window.__foyer.multiWindow?.siblings || []).length === 1,
    null,
    { timeout: 3000 },
  );

  // Audio gate: secondary can't open ingress.
  await secondaryPage.evaluate(() => {
    window.__foyer.__capturedErrors = [];
    window.__foyer.ws.addEventListener("envelope", (ev) => {
      const b = ev.detail?.body;
      if (b?.type === "error") window.__foyer.__capturedErrors.push(b);
    });
    window.__foyer.ws.send({
      type: "audio_ingress_open",
      stream_id: 999,
      source: { kind: "master" },
      format: { sample_rate: 48000, channels: 1, format: "f32_le", frame_size: 480 },
    });
  });
  await secondaryPage.waitForFunction(
    () => (window.__foyer.__capturedErrors || []).some(
      (e) => e.code === "secondary_window_audio",
    ),
    null,
    { timeout: 3000 },
  );

  // The PRIMARY should be unaffected — it can still issue the same
  // command without tripping the gate. We don't actually need the
  // ingress to *succeed* (no real mic), just to NOT be rejected
  // with secondary_window_audio.
  await primaryPage.evaluate(() => {
    window.__foyer.__capturedErrors = [];
    window.__foyer.ws.addEventListener("envelope", (ev) => {
      const b = ev.detail?.body;
      if (b?.type === "error") window.__foyer.__capturedErrors.push(b);
    });
    window.__foyer.ws.send({
      type: "audio_ingress_open",
      stream_id: 998,
      source: { kind: "master" },
      format: { sample_rate: 48000, channels: 1, format: "f32_le", frame_size: 480 },
    });
  });
  await new Promise((r) => setTimeout(r, 400));
  const primaryErrors = await primaryPage.evaluate(
    () => window.__foyer.__capturedErrors,
  );
  for (const e of primaryErrors) {
    expect(e.code).not.toBe("secondary_window_audio");
  }
});
