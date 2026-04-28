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

export async function bootTimeline(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.waitForFunction(
    () => typeof window.__foyer?.layout?.setTree === "function",
  );
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
