// Shared boot helpers + shadow-walk used by every spec that needs to
// reach a mounted view. Lives next to the specs (Playwright's testDir
// is `specs/`, so anything here gets picked up — but the leading `_`
// is treated as a non-test file by playwright's discovery glob).
//
// What used to be inlined per spec, with one critical issue: the
// welcome screen now stays up while `state.sessions` is empty (see
// `hasSessions` in [web/ui-full/app.js](../../web/ui-full/app.js)),
// and the stub backend doesn't auto-register a session. Without a
// non-empty sessions list the tile container never mounts and
// `foyer-timeline-view` never renders.
//
// `bootTimeline()` here forges a synthetic session entry and emits
// the `change` + `sessions` events the store listeners expect. The
// session SNAPSHOT itself (with tracks) is already populated by the
// bootstrap exchange — only the sessions LIST needs to be primed for
// the welcome gate.

export const DEEP_FIND = `
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

export async function primeSessionsList(page) {
  await page.evaluate(() => {
    const state = window.__foyer.store.state;
    if (!state.sessions || state.sessions.length === 0) {
      state.sessions = [{ id: "s_test", path: "/tmp/test.ardour", label: "test" }];
      state.currentSessionId = "s_test";
      window.__foyer.store.dispatchEvent(new Event("change"));
      window.__foyer.store.dispatchEvent(new Event("sessions"));
    }
  });
}

/// Wipe the stub backend's mutable test fixtures so this spec starts
/// from the same baseline regardless of what earlier specs in the
/// Playwright run (workers: 1, single shared stub process) mutated.
/// No-op against real DAW backends — the server gates dispatch on
/// the active backend type and just logs+drops the command for
/// anything that isn't stub.
///
/// Why this exists at all: region-clipboard / region-slice / a
/// handful of other state-sensitive specs assume the seeded region
/// fixture (4 × 6-second clips per track). Without this reset they
/// occasionally fail in CI under cumulative mutation pressure from
/// the preceding ~40 specs.
export async function resetStubState(page) {
  await page.evaluate(() => {
    window.__foyer.ws.send({ type: "test_reset_state" });
  });
  // The stub broadcasts an empty `RegionsList` per track on reset
  // so any in-flight `_regionsByTrack` cache (mostly an issue when
  // a prior spec left the timeline view mounted) drops itself. We
  // wait for the wire to drain before proceeding — without the
  // tiny settle, the next `setTree` race could land BEFORE the
  // reset events arrive and the timeline-view picks up the stale
  // pre-reset state again.
  await new Promise((r) => setTimeout(r, 100));
}

export async function bootTimeline(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.waitForFunction(
    () => typeof window.__foyer?.layout?.setTree === "function",
  );
  // Reset the stub's mutable caches BEFORE we set up the rest of
  // the spec — so the `setTree` below mounts a timeline that talks
  // to a freshly-seeded region fixture. The fresh `page.goto` above
  // gave us a clean client; this gives us a clean server.
  await resetStubState(page);
  await primeSessionsList(page);
  await page.evaluate(() => {
    window.__foyer.layout.setTree({
      kind: "leaf", id: "test_t", view: "timeline", props: {},
    });
  });
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    return !!deepFind("foyer-timeline-view");
  })()`);
}
