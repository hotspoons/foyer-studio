// Region clipboard ops on the timeline: cut / copy / paste / duplicate
// / mute. Covers TODO #129 ("standard DAW workflow"). The undo half of
// each op is already covered by the shim's wrap-in-group plumbing —
// this spec just verifies the client-side sends the right commands and
// the resulting region count + state reflects the op.

import { test, expect } from "@playwright/test";
import { DEEP_FIND, bootTimeline as baseBootTimeline } from "./_boot.js";

async function bootTimeline(page) {
  await baseBootTimeline(page);
  // Stub seeds regions lazily on the first list_regions call, which the
  // timeline issues only after it mounts. Wait until at least one track
  // has regions in its local cache.
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    if (!tv) return false;
    const tracks = window.__foyer.store.state.session?.tracks || [];
    return tracks.some((t) => (tv._regionsByTrack[t.id] || []).length > 0);
  })()`);
}

/** Find the first track that already has at least one region in the
 *  stub session. */
async function pickPopulatedTrack(page) {
  return page.evaluate(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    const tracks = window.__foyer.store.state.session.tracks;
    for (const t of tracks) {
      const rs = tv._regionsByTrack[t.id] || [];
      if (rs.length) return { trackId: t.id, regionId: rs[0].id, count: rs.length };
    }
    return null;
  })()`);
}

async function regionCount(page, trackId) {
  return page.evaluate(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    return (tv._regionsByTrack[${JSON.stringify(trackId)}] || []).length;
  })()`);
}

async function waitForRegionCount(page, trackId, target) {
  await page.waitForFunction(
    `(() => {
      ${DEEP_FIND}
      const tv = deepFind("foyer-timeline-view");
      return (tv._regionsByTrack[${JSON.stringify(trackId)}] || []).length === ${target};
    })()`,
  );
}

async function selectRegion(page, regionId) {
  await page.evaluate(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    tv._selectedRegionIds.clear();
    tv._selectedRegionIds.add(${JSON.stringify(regionId)});
  })()`);
}

test.describe("region clipboard / mute / duplicate", () => {
  test.setTimeout(60_000);

  test("copy + paste at playhead grows the region count by 1", async ({ page }) => {
    await bootTimeline(page);
    const seed = await pickPopulatedTrack(page);
    expect(seed).not.toBeNull();
    await selectRegion(page, seed.regionId);
    const before = await regionCount(page, seed.trackId);
    await page.evaluate(`(() => {
      ${DEEP_FIND}
      deepFind("foyer-timeline-view").copyRegionSelection();
    })()`);
    expect(await page.evaluate(`(() => {
      ${DEEP_FIND}
      return deepFind("foyer-timeline-view").hasClipboard();
    })()`)).toBe(true);
    // Move playhead well clear of the source region, paste, count grows by 1.
    await page.evaluate(() => {
      window.__foyer.ws.controlSet("transport.position", 480_000); // ~10s @ 48k
    });
    await new Promise((r) => setTimeout(r, 250));
    await page.evaluate(`(() => {
      ${DEEP_FIND}
      deepFind("foyer-timeline-view").pasteRegionsAtPlayhead();
    })()`);
    await waitForRegionCount(page, seed.trackId, before + 1);
  });

  test("duplicate selection lands a clone next to the original", async ({ page }) => {
    await bootTimeline(page);
    const seed = await pickPopulatedTrack(page);
    await selectRegion(page, seed.regionId);
    const before = await regionCount(page, seed.trackId);
    await page.evaluate(`(() => {
      ${DEEP_FIND}
      deepFind("foyer-timeline-view").duplicateRegionSelection();
    })()`);
    await waitForRegionCount(page, seed.trackId, before + 1);
  });

  test("mute toggle flips the muted flag on the selected region", async ({ page }) => {
    await bootTimeline(page);
    const seed = await pickPopulatedTrack(page);
    await selectRegion(page, seed.regionId);
    const before = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tv = deepFind("foyer-timeline-view");
      return !!(tv._regionsByTrack[${JSON.stringify(seed.trackId)}] || [])
        .find((r) => r.id === ${JSON.stringify(seed.regionId)})?.muted;
    })()`);
    await page.evaluate(`(() => {
      ${DEEP_FIND}
      deepFind("foyer-timeline-view").toggleMuteRegionSelection();
    })()`);
    await page.waitForFunction(
      `(() => {
        ${DEEP_FIND}
        const tv = deepFind("foyer-timeline-view");
        return !!(tv._regionsByTrack[${JSON.stringify(seed.trackId)}] || [])
          .find((r) => r.id === ${JSON.stringify(seed.regionId)})?.muted !== ${before};
      })()`,
    );
    const after = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tv = deepFind("foyer-timeline-view");
      return !!(tv._regionsByTrack[${JSON.stringify(seed.trackId)}] || [])
        .find((r) => r.id === ${JSON.stringify(seed.regionId)})?.muted;
    })()`);
    expect(after).toBe(!before);
  });

  test("cut + paste removes the original AND creates a clone; clipboard clears", async ({ page }) => {
    await bootTimeline(page);
    const seed = await pickPopulatedTrack(page);
    await selectRegion(page, seed.regionId);
    const before = await regionCount(page, seed.trackId);
    await page.evaluate(`(() => {
      ${DEEP_FIND}
      deepFind("foyer-timeline-view").cutRegionSelection();
    })()`);
    // Cut MUST NOT delete the original until paste fires (DuplicateRegion
    // needs the source to still exist server-side).
    expect(await regionCount(page, seed.trackId)).toBe(before);
    await page.evaluate(() => {
      window.__foyer.ws.controlSet("transport.position", 960_000);
    });
    await new Promise((r) => setTimeout(r, 200));
    await page.evaluate(`(() => {
      ${DEEP_FIND}
      deepFind("foyer-timeline-view").pasteRegionsAtPlayhead();
    })()`);
    // Paste sends duplicate THEN delete — net effect on the same track
    // is no change to the count, but the original ID is gone.
    await page.waitForFunction(
      `(() => {
        ${DEEP_FIND}
        const tv = deepFind("foyer-timeline-view");
        const list = tv._regionsByTrack[${JSON.stringify(seed.trackId)}] || [];
        return list.length === ${before}
          && !list.some((r) => r.id === ${JSON.stringify(seed.regionId)});
      })()`,
    );
    expect(await regionCount(page, seed.trackId)).toBe(before);
    expect(await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tv = deepFind("foyer-timeline-view");
      return !(tv._regionsByTrack[${JSON.stringify(seed.trackId)}] || [])
        .some((r) => r.id === ${JSON.stringify(seed.regionId)});
    })()`)).toBe(true);
    // Clipboard is cleared after a cut/paste — guards against a second
    // paste re-deleting an already-gone source.
    expect(await page.evaluate(`(() => {
      ${DEEP_FIND}
      return deepFind("foyer-timeline-view").hasClipboard();
    })()`)).toBe(false);
  });

  test("user-visible toast feedback for empty selection / copy / paste", async ({ page }) => {
    // Regression: when this batch first shipped, copying a region produced
    // no visible feedback (cut even less so — originals stay until paste).
    // Users assumed the keybind / menu item was broken. The fix adds a
    // toast on every clipboard op + a warning when there's no selection.
    // Listed last in the file because the paste it does adds a region
    // and confuses the cut/paste test's pickPopulatedTrack heuristic
    // when the cut/paste test runs after.
    await bootTimeline(page);
    const seed = await pickPopulatedTrack(page);

    await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tv = deepFind("foyer-timeline-view");
      tv._selectedRegionIds.clear();
      tv.copyRegionSelection();
    })()`);
    await page.waitForFunction(() => {
      const stack = document.getElementById("foyer-toast-stack");
      return !!stack && Array.from(stack.children)
        .some((el) => /Nothing selected/.test(el.textContent || ""));
    });

    await selectRegion(page, seed.regionId);
    await page.evaluate(`(() => {
      ${DEEP_FIND}
      deepFind("foyer-timeline-view").copyRegionSelection();
    })()`);
    await page.waitForFunction(() => {
      const stack = document.getElementById("foyer-toast-stack");
      return !!stack && Array.from(stack.children)
        .some((el) => /Copied 1 region/.test(el.textContent || ""));
    });

    await page.evaluate(`(() => {
      ${DEEP_FIND}
      deepFind("foyer-timeline-view").pasteRegionsAtPlayhead();
    })()`);
    await page.waitForFunction(() => {
      const stack = document.getElementById("foyer-toast-stack");
      return !!stack && Array.from(stack.children)
        .some((el) => /Pasted 1 region/.test(el.textContent || ""));
    });
  });
});
