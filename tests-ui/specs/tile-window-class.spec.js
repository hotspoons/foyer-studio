// Floating <foyer-window> ↔ tile-tree round-trip:
//   · A widget-class window (track editor, etc.) carries a viewKind +
//     viewProps; clicking the "Send to tile layer" button mounts a
//     leaf in the tree and closes the window.
//   · The tile leaf hosts the same underlying widget element with
//     the same per-id props (trackId / regionId / pluginId).
//   · Tile leaves expose a "Float" button in chrome that pops the
//     leaf back out into a foyer-window.
//   · A leaf whose entity is gone (track deleted) shows a placeholder
//     with Float / Close affordances instead of mounting the widget.

import { test, expect } from "@playwright/test";
import { DEEP_FIND, primeSessionsList } from "./_boot.js";

async function bootMixer(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.waitForFunction(
    () => typeof window.__foyer?.layout?.setTree === "function",
  );
  await primeSessionsList(page);
  await page.evaluate(() => {
    window.__foyer.layout.setTree({ kind: "leaf", id: "tw_mix", view: "mixer", props: {} });
  });
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    return !!deepFind("foyer-mixer");
  })()`);
}

/// Pull a couple of real audio-track ids from the live session.
/// The stub backend's track set drifts across the spec suite (other
/// tests duplicate / delete / rename tracks), so hardcoding
/// "track.kick" is brittle once the suite has been running.
async function pickAudioTrackIds(page, n = 3) {
  return page.evaluate((count) => {
    const tracks = window.__foyer.store.state.session?.tracks || [];
    return tracks
      .filter((t) => t.kind === "audio")
      .slice(0, count)
      .map((t) => t.id);
  }, n);
}

test.describe("tile/window round-trip", () => {
  test("sendToTiles mounts a track-editor leaf and respects trackId", async ({ page }) => {
    await bootMixer(page);
    const [tid] = await pickAudioTrackIds(page, 1);
    expect(tid).toBeTruthy();

    const result = await page.evaluate((target) => {
      const id = window.__foyer.layout.sendToTiles("track-editor", {
        trackId: target,
      });
      return { id };
    }, tid);
    expect(result.id).toBeTruthy();

    await page.waitForFunction(`(() => {
      ${DEEP_FIND}
      return !!deepFind("foyer-track-editor-modal");
    })()`);

    const trackId = await page.evaluate(`(() => {
      ${DEEP_FIND}
      return deepFind("foyer-track-editor-modal").trackId;
    })()`);
    expect(trackId).toBe(tid);
  });

  test("missing-entity placeholder renders when the track is gone", async ({ page }) => {
    await bootMixer(page);
    await page.evaluate(() => {
      window.__foyer.layout.sendToTiles("track-editor", {
        trackId: "track.does-not-exist",
      });
    });
    await page.waitForFunction(`(() => {
      ${DEEP_FIND}
      return !!deepFind("foyer-tile-leaf")?.shadowRoot.querySelector(".missing-entity");
    })()`);
    const title = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const leaf = deepFind("foyer-tile-leaf");
      // There may be multiple tile-leaf elements; find the one whose
      // body holds the missing-entity placeholder.
      function deepFindAll(tag) {
        const out = [];
        const stack = [document.querySelector("foyer-app").shadowRoot];
        while (stack.length) {
          const r = stack.pop();
          if (!r) continue;
          for (const el of r.querySelectorAll(tag)) out.push(el);
          for (const el of r.querySelectorAll("*")) if (el.shadowRoot) stack.push(el.shadowRoot);
        }
        return out;
      }
      const leaves = deepFindAll("foyer-tile-leaf");
      for (const l of leaves) {
        const t = l.shadowRoot.querySelector(".missing-entity-title");
        if (t) return t.textContent.trim();
      }
      return null;
    })()`);
    expect(title).toBe("Track is gone");
  });

  test("sendToTiles dedupes by entity identity", async ({ page }) => {
    await bootMixer(page);
    const [tid] = await pickAudioTrackIds(page, 1);
    const firstId = await page.evaluate((t) =>
      window.__foyer.layout.sendToTiles("track-editor", { trackId: t }),
      tid,
    );
    const secondId = await page.evaluate((t) =>
      window.__foyer.layout.sendToTiles("track-editor", { trackId: t }),
      tid,
    );
    // Same identity → focuses existing leaf instead of creating a duplicate.
    expect(secondId).toBe(firstId);
  });

  test("pop-out chrome button hides on native tile views (mixer / timeline)", async ({ page }) => {
    await bootMixer(page);
    const [tid] = await pickAudioTrackIds(page, 1);
    expect(tid).toBeTruthy();
    // Add a track-editor tile alongside the mixer so we have one of
    // each kind in the tree to inspect.
    await page.evaluate((t) =>
      window.__foyer.layout.sendToTiles("track-editor", { trackId: t }),
      tid,
    );
    await page.waitForFunction(`(() => {
      ${DEEP_FIND}
      return !!deepFind("foyer-track-editor-modal");
    })()`);

    const matrix = await page.evaluate(() => {
      const out = [];
      const stack = [document.querySelector("foyer-app").shadowRoot];
      while (stack.length) {
        const r = stack.pop();
        if (!r) continue;
        for (const el of r.querySelectorAll("foyer-tile-leaf")) {
          const popBtn = el.shadowRoot.querySelector('button[title*="Pop out"]');
          out.push({ view: el.leaf?.view, hasPop: !!popBtn });
        }
        for (const el of r.querySelectorAll("*")) if (el.shadowRoot) stack.push(el.shadowRoot);
      }
      return out;
    });
    const mixer = matrix.find((m) => m.view === "mixer");
    const editor = matrix.find((m) => m.view === "track-editor");
    expect(mixer?.hasPop).toBe(false);
    expect(editor?.hasPop).toBe(true);
  });

  test("widget view in floating-tiles renders + pops out as foyer-window", async ({ page }) => {
    await bootMixer(page);
    const [tid] = await pickAudioTrackIds(page, 1);
    expect(tid).toBeTruthy();
    // Mimic the user's drop-zone landing: send a track-editor entry
    // straight into floating-tiles (slot placement). Bypasses the
    // tile-leaf header drag, but the resulting state is the same
    // as a successful drop-zone drag-and-drop into the right-half
    // slot.
    const floatId = await page.evaluate((t) =>
      window.__foyer.layout.openFloating("track-editor", { trackId: t }, { slot: "right-half" }),
      tid,
    );
    expect(floatId).toBeTruthy();

    // Body should render the actual track-editor element with the
    // right trackId — NOT the "Unknown view: …" fallback.
    await page.waitForFunction(`(() => {
      ${DEEP_FIND}
      const ft = deepFind("foyer-floating-tiles");
      return !!ft?.shadowRoot.querySelector("foyer-track-editor-modal");
    })()`);
    const fromFloatTiles = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const ft = deepFind("foyer-floating-tiles");
      const ed = ft.shadowRoot.querySelector("foyer-track-editor-modal");
      return ed?.trackId || null;
    })()`);
    expect(fromFloatTiles).toBe(tid);

    // Click "Pop out as floating window" — should convert the
    // floating-tiles entry into a foyer-window. Old entry goes away.
    await page.evaluate((id) => {
      function deepFind(tag) {
        const stack = [document.querySelector("foyer-app").shadowRoot];
        while (stack.length) {
          const r = stack.pop(); if (!r) continue;
          const hit = r.querySelector(tag);
          if (hit) return hit;
          for (const el of r.querySelectorAll("*")) if (el.shadowRoot) stack.push(el.shadowRoot);
        }
        return null;
      }
      const ft = deepFind("foyer-floating-tiles");
      const win = ft.shadowRoot.querySelector(`[data-float-id="${id}"]`);
      const btn = win.querySelector('button[title*="Pop out"]');
      btn.click();
    }, floatId);

    await page.waitForFunction((t) =>
      document.querySelector(`foyer-window[storage-key$="${t}"]`),
      tid,
    );
    const stillInFloats = await page.evaluate((id) =>
      window.__foyer.layout.floating().some((f) => f.id === id),
      floatId,
    );
    expect(stillInFloats).toBe(false);
  });

  test("floating a widget tile lands on top of existing windows", async ({ page }) => {
    await bootMixer(page);
    const [tA, tB, tC] = await pickAudioTrackIds(page, 3);
    expect(tA).toBeTruthy();
    expect(tB).toBeTruthy();
    expect(tC).toBeTruthy();
    // Open two existing track-editor windows so the new float has
    // peers to compete with for z-order.
    await page.evaluate(async (t) => {
      const m = await import("/ui-full/components/track-editor-modal.js");
      m.openTrackEditor(t);
    }, tA);
    await page.waitForFunction((t) =>
      document.querySelector(`foyer-window[storage-key$="${t}"]`),
      tA,
    );
    await page.evaluate(async (t) => {
      const m = await import("/ui-full/components/track-editor-modal.js");
      m.openTrackEditor(t);
    }, tB);
    await page.waitForFunction((t) =>
      document.querySelector(`foyer-window[storage-key$="${t}"]`),
      tB,
    );

    // Send a third track-editor to the tile layer, then float it
    // back out. The freshly-floated window should end up above the
    // first two so the user can grab it without z-fighting.
    const tileId = await page.evaluate((t) =>
      window.__foyer.layout.sendToTiles("track-editor", { trackId: t }),
      tC,
    );
    expect(tileId).toBeTruthy();

    await page.waitForFunction(`(() => {
      ${DEEP_FIND}
      const leaves = [];
      const stack = [document.querySelector("foyer-app").shadowRoot];
      while (stack.length) {
        const r = stack.pop();
        if (!r) continue;
        for (const el of r.querySelectorAll("foyer-tile-leaf")) leaves.push(el);
        for (const el of r.querySelectorAll("*")) if (el.shadowRoot) stack.push(el.shadowRoot);
      }
      return leaves.some((l) => l.leaf?.view === "track-editor");
    })()`);

    // Pop the bass leaf back out via _float.
    await page.evaluate(`(() => {
      const stack = [document.querySelector("foyer-app").shadowRoot];
      while (stack.length) {
        const r = stack.pop();
        if (!r) continue;
        for (const el of r.querySelectorAll("foyer-tile-leaf")) {
          if (el.leaf?.view === "track-editor") { el._float(); return; }
        }
        for (const el of r.querySelectorAll("*")) if (el.shadowRoot) stack.push(el.shadowRoot);
      }
    })()`);

    await page.waitForFunction((t) =>
      document.querySelector(`foyer-window[storage-key$="${t}"]`),
      tC,
    );

    const zs = await page.evaluate(({ a, b, c }) => {
      const wins = [...document.querySelectorAll("foyer-window")];
      const out = {};
      for (const w of wins) {
        const key = w.storageKey || "";
        const z = parseInt(w.style.zIndex || "0", 10) || 0;
        if (key.endsWith(a)) out.a = z;
        if (key.endsWith(b)) out.b = z;
        if (key.endsWith(c)) out.c = z;
      }
      return out;
    }, { a: tA, b: tB, c: tC });
    expect(zs.c).toBeGreaterThan(zs.a);
    expect(zs.c).toBeGreaterThan(zs.b);
  });
});
