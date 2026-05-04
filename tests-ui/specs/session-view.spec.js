// `<foyer-session-view>` — TDZ + stale-last-path recovery.
//
// Scope:
//   * `_renderRow` must not crash when a session-dir row arrives in
//     save-as mode. The TDZ regression read `atomic` before the local
//     const was initialized — first paint of the picker in save-as
//     mode threw "Cannot access 'atomic' before initialization" and
//     the listing never showed.
//   * The picker recovers silently when the last-remembered path is
//     gone from the backend. The expected behavior is: drop the dead
//     entry from history, fall back to jail root, no error banner.
//
// Both tests instantiate the element directly with a fake ws so we
// don't have to spin up a real backend with a real jail and stage a
// non-existent folder. The fake ws records sent commands and lets the
// test push synthetic envelopes back, mimicking what the picker sees
// in production.

import { test, expect } from "@playwright/test";
import { primeSessionsList } from "./_boot.js";

async function bootPicker(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.waitForFunction(() => typeof window.__foyer?.layout?.setTree === "function");
  await primeSessionsList(page);
  await page.evaluate(async () => {
    await import("/ui-full/components/session-view.js");
  });
}

/// Mount a session-view with a fake ws: connectedCallback fires
/// `list_backends` + the initial `browse_path`, but our fake ws
/// queues sent commands and lets the test push envelopes back via
/// `pushEnvelope(body)`. Returns a JS handle.
async function mountPicker(page, props) {
  return page.evaluateHandle((props) => {
    document.querySelectorAll("foyer-session-view").forEach((e) => e.remove());

    // Save the real ws so other components on the page (toolbar,
    // status bar) keep working; we only need our element to use the
    // fake.
    const realWs = window.__foyer.ws;
    const sent = [];
    const listeners = new Set();
    const fakeWs = {
      send(body) { sent.push(body); },
      addEventListener(type, fn) { if (type === "envelope") listeners.add(fn); },
      removeEventListener(type, fn) { if (type === "envelope") listeners.delete(fn); },
      pushEnvelope(body) {
        const ev = { detail: { body } };
        for (const fn of [...listeners]) fn(ev);
      },
    };
    window.__foyer.ws = fakeWs;
    try {
      const el = document.createElement("foyer-session-view");
      Object.assign(el, props);
      document.body.appendChild(el);
      // Stash for the test
      el.__sent = sent;
      el.__pushEnvelope = (body) => fakeWs.pushEnvelope(body);
      el.__restoreWs = () => { window.__foyer.ws = realWs; };
      return el;
    } catch (e) {
      window.__foyer.ws = realWs;
      throw e;
    }
  }, props);
}

test.describe("foyer-session-view", () => {
  test("renderRow survives a session-dir entry in save-as mode (TDZ guard)", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await bootPicker(page);
    const handle = await mountPicker(page, { mode: "save_as" });
    await handle.evaluate((el) => el.updateComplete);

    // Push a listing that includes a session-dir entry. Save-as mode
    // is what trips the regressed branch — `atomic` is computed from
    // (kind === "session_dir" && mode === "save_as").
    await handle.evaluate((el) => {
      el.__pushEnvelope({
        type: "path_listed",
        listing: {
          path: "",
          parent: null,
          entries: [
            { name: "Some Session", path: "Some Session", kind: "session_dir", session_name: "Some Session" },
            { name: "subdir",        path: "subdir",        kind: "dir" },
            { name: "notes.txt",     path: "notes.txt",     kind: "file", size_bytes: 42 },
          ],
        },
      });
    });
    await handle.evaluate((el) => el.updateComplete);

    const probe = await handle.evaluate((el) => ({
      rowCount: el.shadowRoot.querySelectorAll(".row").length,
      atomicCount: el.shadowRoot.querySelectorAll(".row.atomic-session").length,
    }));

    expect(probe.rowCount).toBe(3);
    // Save-as mode flags session-dir rows as atomic (read-only here);
    // exactly the entry we passed in should pick up the class.
    expect(probe.atomicCount).toBe(1);
    expect(errors, errors.join("\n")).toEqual([]);
    await handle.evaluate((el) => el.__restoreWs());
  });

  test("recovers silently when the last-remembered path is gone", async ({ page }) => {
    await bootPicker(page);
    // Plant a stale last-path so the picker boots into a folder the
    // backend will reject.
    await page.evaluate(() => {
      try {
        localStorage.setItem("foyer.picker.last-path", "deleted/folder/path");
      } catch {}
    });

    const handle = await mountPicker(page, { mode: "open" });
    await handle.evaluate((el) => el.updateComplete);

    // Confirm the element kicked off a browse for the stale path.
    const initial = await handle.evaluate((el) => {
      const browse = el.__sent.filter((c) => c.type === "browse_path");
      return { browse, calls: el.__sent.length };
    });
    expect(initial.browse[0]).toMatchObject({ type: "browse_path", path: "deleted/folder/path" });

    // Backend says "no such path" for the stale entry.
    await handle.evaluate((el) => {
      el.__pushEnvelope({
        type: "error",
        code: "browse_failed",
        message: "no such path: deleted/folder/path",
      });
    });
    await handle.evaluate((el) => el.updateComplete);

    // Recovery should:
    //   * fire a follow-up browse_path with "" (jail root)
    //   * NOT show an error banner
    //   * drop the dead entry from history
    //   * write "" back to the saved last-path
    const recovered = await handle.evaluate((el) => {
      const browse = el.__sent.filter((c) => c.type === "browse_path");
      const errBanner = el.shadowRoot.querySelector(".error, .error-banner")?.textContent || "";
      return {
        browses: browse.map((c) => c.path),
        errVisible: !!errBanner.trim(),
        history: el._history.slice(),
        savedPath: localStorage.getItem("foyer.picker.last-path") || "",
      };
    });

    // First browse was the stale path; second is the recovery to root.
    expect(recovered.browses[0]).toBe("deleted/folder/path");
    expect(recovered.browses[recovered.browses.length - 1]).toBe("");
    expect(recovered.errVisible).toBe(false);
    expect(recovered.history).toContain("");
    expect(recovered.history).not.toContain("deleted/folder/path");
    expect(recovered.savedPath).toBe("");

    await handle.evaluate((el) => el.__restoreWs());
  });

  test("recovers from a clicked-but-vanished subfolder mid-session", async ({ page }) => {
    // Reset last-path so we boot at jail root.
    await page.evaluate(() => {
      try { localStorage.removeItem("foyer.picker.last-path"); } catch {}
    });
    await bootPicker(page);

    const handle = await mountPicker(page, { mode: "open" });
    await handle.evaluate((el) => el.updateComplete);

    // Boot listing: jail root with one folder.
    await handle.evaluate((el) => {
      el.__pushEnvelope({
        type: "path_listed",
        listing: {
          path: "",
          parent: null,
          entries: [{ name: "stale", path: "stale", kind: "dir" }],
        },
      });
    });
    await handle.evaluate((el) => el.updateComplete);

    // User clicks the folder. We simulate by calling the navigate
    // handler directly — no DOM gymnastics needed for this assertion.
    await handle.evaluate((el) => el._navigate("stale"));
    await handle.evaluate((el) => el.updateComplete);

    // Backend errors: folder is gone (race between listing + click).
    await handle.evaluate((el) => {
      el.__pushEnvelope({
        type: "error",
        code: "browse_failed",
        message: "no such path: stale",
      });
    });
    await handle.evaluate((el) => el.updateComplete);

    const after = await handle.evaluate((el) => {
      const browse = el.__sent.filter((c) => c.type === "browse_path");
      const errBanner = el.shadowRoot.querySelector(".error, .error-banner")?.textContent || "";
      return {
        browses: browse.map((c) => c.path),
        errVisible: !!errBanner.trim(),
        history: el._history.slice(),
      };
    });

    // Sequence: "" (initial), "stale" (click), "" (recovery).
    expect(after.browses).toEqual(["", "stale", ""]);
    expect(after.errVisible).toBe(false);
    expect(after.history).not.toContain("stale");

    await handle.evaluate((el) => el.__restoreWs());
  });
});
