// Time-range slice cut / copy / paste on the timeline.
//
// Covers the late-Apr feedback round on "cut/copy/paste no where near
// usable":
//   - sliced clipboard captures the carved-out portion (offset INTO the
//     region + length), not the whole region;
//   - cut decoration overlays only the slice, so the user can see what
//     stays vs. what leaves on the next paste;
//   - cut + paste of a sliced clipboard SPLITS the source around the
//     gap (truncate "before" + duplicate_region_range for "after"),
//     matching Reaper's "cut a chunk out" expectation;
//   - the Edit menu (foyer-main-menu) routes cut/copy/paste to the
//     timeline client-side — earlier the catalog action `edit.copy`
//     fell through to `invoke_action` which the headless shim refuses
//     (dispatch.cc:2761), so the menu items silently no-op'd.

import { test, expect } from "@playwright/test";
import { DEEP_FIND, bootTimeline as baseBootTimeline } from "./_boot.js";

async function bootTimeline(page) {
  await baseBootTimeline(page);
  // Stub seeds regions lazily on the first list_regions call, which
  // the timeline issues when it mounts. Wait until at least one track
  // has regions in its local cache.
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    if (!tv) return false;
    const tracks = window.__foyer.store.state.session?.tracks || [];
    return tracks.some((t) => (tv._regionsByTrack[t.id] || []).length > 0);
  })()`);
}

/** Pick a region from the first populated track and return enough info
 *  to build deterministic time-range slice selections against it. The
 *  stub seeds 6-second regions; we slice 1s..3s (offset 48000, len
 *  96000 at 48kHz). */
async function pickPopulatedRegion(page) {
  return page.evaluate(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    const tracks = window.__foyer.store.state.session.tracks;
    for (const t of tracks) {
      const rs = tv._regionsByTrack[t.id] || [];
      if (rs.length) {
        const r = rs[0];
        return {
          trackId: t.id,
          regionId: r.id,
          start: r.start_samples,
          length: r.length_samples,
          count: rs.length,
        };
      }
    }
    return null;
  })()`);
}

async function regionsOnTrack(page, trackId) {
  return page.evaluate(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    return (tv._regionsByTrack[${JSON.stringify(trackId)}] || []).map(r => ({
      id: r.id,
      start: r.start_samples,
      length: r.length_samples,
      source_offset: r.source_offset_samples ?? null,
    }));
  })()`);
}

async function selectRegionAndRange(page, regionId, rangeStart, rangeEnd) {
  await page.evaluate(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    tv._selectedRegionIds = new Set([${JSON.stringify(regionId)}]);
    tv._selection = {
      startSamples: ${rangeStart},
      endSamples: ${rangeEnd},
    };
    tv.requestUpdate();
  })()`);
}

test.describe("timeline region: time-range slice ops", () => {
  test.setTimeout(60_000);

  test("copy with active time selection captures the slice offset+length", async ({ page }) => {
    await bootTimeline(page);
    const r = await pickPopulatedRegion(page);
    expect(r).not.toBeNull();
    // Slice the middle of the region: 1s..3s into it.
    const sliceStartTimeline = r.start + 48_000;
    const sliceEndTimeline = r.start + 48_000 + 96_000;
    await selectRegionAndRange(page, r.regionId, sliceStartTimeline, sliceEndTimeline);

    const clip = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tv = deepFind("foyer-timeline-view");
      tv.copyRegionSelection({ silent: true });
      const c = tv._regionClipboard;
      return {
        sliced: c?.sliced,
        items: c?.items?.map(it => ({
          slice_start: it.slice_start,
          slice_len: it.slice_len,
          full_length: it.full_length,
          region_start_samples: it.region_start_samples,
        })),
      };
    })()`);
    expect(clip.sliced).toBe(true);
    expect(clip.items).toHaveLength(1);
    const it = clip.items[0];
    expect(it.slice_start).toBe(48_000);
    expect(it.slice_len).toBe(96_000);
    expect(it.region_start_samples).toBe(r.start);
    expect(it.full_length).toBe(r.length);
  });

  test("cut decoration overlays only the slice rectangle, not the whole region", async ({ page }) => {
    await bootTimeline(page);
    const r = await pickPopulatedRegion(page);
    const sliceStartTimeline = r.start + 48_000;
    const sliceEndTimeline = r.start + 48_000 + 96_000;
    await selectRegionAndRange(page, r.regionId, sliceStartTimeline, sliceEndTimeline);
    await page.evaluate(`(() => {
      ${DEEP_FIND}
      deepFind("foyer-timeline-view").cutRegionSelection();
    })()`);
    // Wait for Lit to flush the cut-pending state into the DOM.
    await page.waitForFunction(`(() => {
      ${DEEP_FIND}
      const tv = deepFind("foyer-timeline-view");
      const regionEl = tv.renderRoot.querySelector(\`.region[data-id="${r.regionId}"]\`);
      return !!regionEl?.querySelector(".cut-slice-overlay");
    })()`);

    const overlay = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tv = deepFind("foyer-timeline-view");
      const regionEl = tv.renderRoot.querySelector(\`.region[data-id="${r.regionId}"]\`);
      const overlayEl = regionEl.querySelector(".cut-slice-overlay");
      const regionRect = regionEl.getBoundingClientRect();
      const overlayRect = overlayEl.getBoundingClientRect();
      return {
        regionWidth: regionRect.width,
        overlayWidth: overlayRect.width,
        overlayLeft: overlayRect.left - regionRect.left,
      };
    })()`);
    // Expected: slice covers 33.3% of the region (96000 / 288000).
    // Allow ±5% slack for sub-pixel rounding.
    const ratio = overlay.overlayWidth / overlay.regionWidth;
    expect(ratio).toBeGreaterThan(0.28);
    expect(ratio).toBeLessThan(0.38);
    // And the slice should NOT start at x=0 — it's offset by 1s of the
    // 6s region (~16.7% in).
    const leftRatio = overlay.overlayLeft / overlay.regionWidth;
    expect(leftRatio).toBeGreaterThan(0.10);
    expect(leftRatio).toBeLessThan(0.22);
  });

  test("Edit > Copy menu item routes through the timeline client-side", async ({ page }) => {
    await bootTimeline(page);
    const r = await pickPopulatedRegion(page);
    await selectRegionAndRange(page, r.regionId, r.start + 48_000, r.start + 48_000 + 96_000);

    // The catalog action `edit.copy` fell through to `invoke_action`
    // before — verify the main-menu now intercepts it and fills the
    // clipboard via the timeline.
    const result = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const mm = deepFind("foyer-main-menu");
      mm._invoke({ id: "edit.copy", enabled: true });
      const tv = deepFind("foyer-timeline-view");
      return {
        sliced: tv._regionClipboard?.sliced,
        items: tv._regionClipboard?.items?.length ?? 0,
        mode: tv._regionClipboard?.mode,
      };
    })()`);
    expect(result.mode).toBe("copy");
    expect(result.items).toBe(1);
    expect(result.sliced).toBe(true);
  });

  test("cut + paste splits the source around the slice (truncate before + after-clone)", async ({ page }) => {
    await bootTimeline(page);
    const r = await pickPopulatedRegion(page);
    const before = await regionsOnTrack(page, r.trackId);
    const sliceStartIn = 48_000;             // 1s into region
    const sliceLen = 96_000;                 // 2s slice
    const sliceStartTimeline = r.start + sliceStartIn;
    const sliceEndTimeline = r.start + sliceStartIn + sliceLen;
    await selectRegionAndRange(page, r.regionId, sliceStartTimeline, sliceEndTimeline);

    await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tv = deepFind("foyer-timeline-view");
      tv.cutRegionSelection();
      tv.pasteRegions({ at: 1_000_000 });
    })()`);

    // Cut should split source into "before" + "after"; paste lands one
    // new region. Net: +2 regions on the track (before-truncate + after-
    // clone + pasted-slice = 3 pieces from what was 1).
    await page.waitForFunction(`(() => {
      ${DEEP_FIND}
      const tv = deepFind("foyer-timeline-view");
      return (tv._regionsByTrack[${JSON.stringify(r.trackId)}] || []).length === ${before.length + 2};
    })()`);

    const after = await regionsOnTrack(page, r.trackId);
    // The original region id should still exist (truncated to the
    // "before" length) — update_region keeps the same id.
    const truncated = after.find((x) => x.id === r.regionId);
    expect(truncated).toBeDefined();
    expect(truncated.length).toBe(sliceStartIn);
    expect(truncated.start).toBe(r.start);

    // The "after" piece should sit at start + sliceStartIn + sliceLen
    // with length = full_length - (sliceStartIn + sliceLen).
    const afterStart = r.start + sliceStartIn + sliceLen;
    const afterLen = r.length - sliceStartIn - sliceLen;
    const afterClone = after.find(
      (x) => x.start === afterStart && x.length === afterLen,
    );
    expect(afterClone).toBeDefined();
    expect(afterClone.source_offset).toBe(sliceStartIn + sliceLen);

    // The paste destination region (start === 1_000_000) should carry
    // the slice content (offset 48_000, length 96_000).
    const pasted = after.find((x) => x.start === 1_000_000);
    expect(pasted).toBeDefined();
    expect(pasted.length).toBe(sliceLen);
    expect(pasted.source_offset).toBe(sliceStartIn);
  });

});
