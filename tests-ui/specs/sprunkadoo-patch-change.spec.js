// Regression test for the Sprunkadoo "patch resets to Grand Piano
// after one loop" bug (root cause logged 2026-05-26):
//
//   The Ardour shim seeds every newly-created MIDI region with a
//   PatchChange event at tick 0. When a costume's patch program
//   doesn't match that seeded PC, every loop wrap fires the stale
//   PC and overrides the synth back to whatever was set at region
//   creation time (usually Piano = program 0).
//
//   Fix is in two parts:
//     (a) The shim stops auto-seeding the PatchChange on
//         create_region (libfoyer_shim.so).
//     (b) The client deletes any existing in-region PatchChange
//         after applying a new patch's program. The delete command
//         must use field `patch_change_id` — the schema rejects the
//         shorter `id` field. We had `id` for an embarrassing
//         number of days; the server quietly logged
//         "client command rejected: parse: missing field
//         `patch_change_id`" and our deletes never reached the shim.
//
// This spec proves the client-side wire format is correct. The shim
// fix is C++-side and unit-tested via the live foyer + Ardour repro
// at /tmp/repro-region.js (committed alongside this spec for the
// record).
//
// Test approach:
//   1. Boot ?ui=sprunkadoo against the running foyer (stub backend
//      is fine — we're testing what the CLIENT sends, not what the
//      shim does with it).
//   2. Force the app into a ready state with a known stage.
//   3. Plant a fake session snapshot containing a track + region
//      with an existing tick-0 patch_change so the bridge has
//      something to clean up.
//   4. Hook ws.send to capture outgoing commands.
//   5. Trigger assignPatch — exercises the same code path the kid's
//      drag uses.
//   6. Assert that the captured stream includes a delete_patch_change
//      command whose payload has the proper schema fields.

import { test, expect } from "@playwright/test";

test.describe("sprunkadoo patch-change wiping", () => {
  test("assignPatch sends delete_patch_change with patch_change_id field", async ({ page }) => {
    page.setDefaultTimeout(30_000);

    // The Sprunkadoo bootstrap calls launch_project which the stub
    // backend doesn't support; that's OK, the WS layer remains open
    // and we drive the rest of the test directly.
    await page.goto("/?ui=sprunkadoo");
    await page.waitForFunction(
      () => window.__foyer?.store?.state?.status === "open",
      null,
      { timeout: 30_000 },
    );
    // Sprunkadoo's bootstrap re-fires session events for a few
    // seconds; give it room before we force-ready.
    await page.waitForTimeout(2_500);

    const captured = await page.evaluate(async () => {
      function deepFind(tag) {
        const stack = [document];
        while (stack.length) {
          const r = stack.pop();
          const hit = r.querySelector?.(tag);
          if (hit) return hit;
          for (const el of r.querySelectorAll?.("*") || []) {
            if (el.shadowRoot) stack.push(el.shadowRoot);
          }
        }
        return null;
      }
      const app = deepFind("sprunki-app");
      if (!app) return { err: "no sprunki-app" };

      const store = (await import("/ui-sprunkadoo/state-store.js"))
        .sprunkiStore();
      const f = window.__foyer;

      // Force-ready so handlers run.
      app._status = "ready";

      // Plant a synthetic backend snapshot: one MIDI track with our
      // patch's plugin already loaded, and a region carrying the
      // exact stale tick-0 patch_change that the Ardour shim's
      // create_region seed used to leave behind. Both regionsByTrack
      // (the live store representation) and session.tracks (the
      // fallback path inside _findRegion) get populated.
      const trackId = "T_test";
      const regionId = "R_test";
      const stalePc = {
        id: "patchchange.test.0",
        channel: 0,
        program: 0,
        bank: 0,
        start_ticks: 0,
      };
      const region = {
        id: regionId,
        name: "Sprunki",
        notes: [],
        patch_changes: [stalePc],
      };
      f.store.state.session = f.store.state.session || {};
      f.store.state.session.tracks = [
        { id: "_master", kind: "master" },
        {
          id: trackId,
          kind: "midi",
          name: "Sprunki Slot 1",
          plugins: [
            // Match Mr Tree's instrument_uri (GMSYNTH) so the
            // ensurePatchInstrument early-return path fires.
            { id: "plg.gmsynth", uri: "http://gareus.org/oss/lv2/gmsynth" },
          ],
          regions: [region],
        },
      ];
      f.store.state.regionsByTrack = f.store.state.regionsByTrack || new Map();
      f.store.state.regionsByTrack.set(trackId, [region]);

      const slotId = store.stage[0].id;
      store.setTracks(slotId, { track_id: trackId, region_id: regionId });

      // Hook ws.send to capture every command.
      window.__sent = [];
      const origSend = f.ws.send.bind(f.ws);
      f.ws.send = (obj) => {
        if (typeof obj === "object" && obj && obj.type) {
          window.__sent.push(obj);
        }
        return origSend(obj);
      };

      // Drive the patch assignment. mr-tree-organ uses gmsynth
      // (same as the planted plugin) and gm_program=16, so
      // ensurePatchInstrument's happy path fires and the app's
      // _applyPatchProgramToSlot kicks off the set_track_midi_patch
      // + delete_patch_change sweep.
      store.assignPatch(slotId, "mr-tree-organ");
      await new Promise((r) => setTimeout(r, 3_000));

      return {
        sent: window.__sent.slice(),
        stalePc,
        trackId,
        regionId,
      };
    });

    expect(captured.err, captured.err || "boot ok").toBeFalsy();

    // (1) set_track_midi_patch fires with Mr Tree's program (16).
    const setPatch = captured.sent.find(
      (s) => s.type === "set_track_midi_patch" && s.track_id === captured.trackId,
    );
    expect(setPatch, "set_track_midi_patch fired for the track").toBeTruthy();
    expect(setPatch.program).toBe(16);
    expect(setPatch.channel).toBe(0);

    // (2) delete_patch_change fires for the stale tick-0 PC. The
    // critical assertion: field name is `patch_change_id`, NOT
    // `id`. The server's schema rejects the latter and the deletes
    // never reach the shim.
    const deletes = captured.sent.filter(
      (s) => s.type === "delete_patch_change" && s.region_id === captured.regionId,
    );
    expect(deletes.length, "at least one delete_patch_change sent").toBeGreaterThanOrEqual(1);
    for (const d of deletes) {
      expect(
        d.patch_change_id,
        "schema-correct field name (NOT `id`) — server's DeletePatchChange variant requires `patch_change_id`",
      ).toBe(captured.stalePc.id);
      // Belt-and-suspenders: the legacy `id` field MUST NOT be on
      // the payload. If it sneaks back in, the schema parser would
      // still reject (because `patch_change_id` is missing) but a
      // future schema-rename could silently re-introduce the bug.
      expect(d.id, "no legacy `id` field on delete_patch_change").toBeUndefined();
    }
  });
});
