// Regression for the "backend unavailable" agent bug: after
// `swap_backend`, the agent runtime's `Weak<dyn Backend>` used to
// dangle on the dropped previous Arc — every tool call resolved with
// status=error / result_json="backend unavailable". Fix is the
// `AppState::install_active_backend` helper, called from every site
// that swaps the backend pointer.
//
// This spec:
//   1. spawns a self-contained SSE mock LLM under fixtures/,
//   2. points the in-process agent at it via `agent_set_config`,
//   3. opens a fresh stub project via `launch_project` (triggers
//      `swap_backend` → `install_active_backend`),
//   4. sends `agent_send`; the mock returns a tool_call to
//      `session.summary`; the agent must dispatch the tool against
//      the new backend and resolve it with status="done".
//
// Pre-bug behavior: status="error", result_json="backend unavailable".
// Post-fix: status="done", result_json carries the track count.

import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = 9911;
const MOCK_LLM = `http://127.0.0.1:${MOCK_PORT}/v1`;

let mockProc = null;

test.beforeAll(async () => {
  const script = resolve(__dirname, "..", "fixtures", "mock-llm.py");
  mockProc = spawn("python3", [script, String(MOCK_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait for the mock to print its ready line.
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("mock-llm boot timeout")), 5000);
    mockProc.stdout.on("data", (buf) => {
      if (buf.toString().includes("mock-llm ready")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    mockProc.on("error", reject);
  });
});

test.afterAll(async () => {
  if (mockProc) mockProc.kill();
});

test("agent tools reach backend after swap_backend (no more 'backend unavailable')", async ({ page }) => {
  page.setDefaultTimeout(20_000);

  const wsMessages = [];
  await page.exposeFunction("__pushWs", (msg) => wsMessages.push(msg));

  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");

  await page.evaluate(() => {
    window.__foyer.ws.addEventListener("envelope", (ev) => {
      const body = ev.detail?.body;
      if (body && body.type) window.__pushWs({ type: body.type, body });
    });
  });

  // Point agent at mock + start a fresh session so prior transcripts
  // (from running this spec twice or from prior sessions on disk)
  // don't confuse the followup detection.
  await page.evaluate((endpoint) => {
    window.__foyer.ws.send({
      type: "agent_set_config", endpoint, model: "mock", api_key: "",
    });
    window.__foyer.ws.send({ type: "agent_session_new" });
  }, MOCK_LLM);
  {
    const t = Date.now();
    while (Date.now() - t < 5_000) {
      if (wsMessages.some((m) => m.type === "agent_session_activated")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Trigger swap_backend with a unique stub project path.
  const projectPath = `/tmp/foyer-agent-swap-${Date.now()}`;
  await page.evaluate((p) => {
    window.__foyer.ws.send({
      type: "launch_project", backend_id: "stub", project_path: p,
    });
  }, projectPath);

  // The swap fires `BackendSwapped` on a brand-new path; on a
  // re-clicked path it short-circuits with a `SessionSnapshot`
  // emit. Either signals that `install_active_backend` ran.
  {
    const t = Date.now();
    while (Date.now() - t < 10_000) {
      if (wsMessages.some((m) =>
        m.type === "backend_swapped" || m.type === "session_snapshot"
      )) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      wsMessages.some((m) =>
        m.type === "backend_swapped" || m.type === "session_snapshot"
      ),
      "backend swap (or path-match short-circuit) did not produce a recognisable event",
    ).toBe(true);
  }

  // Drive the agent.
  await page.evaluate(() => {
    window.__foyer.ws.send({ type: "agent_send", body: "summarize the session" });
  });

  let toolUpdate = null;
  {
    const t = Date.now();
    while (Date.now() - t < 15_000) {
      toolUpdate = wsMessages.find(
        (m) => m.type === "agent_tool_update" &&
               (m.body.status === "done" || m.body.status === "error"),
      );
      if (toolUpdate) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  expect(toolUpdate, "an agent_tool_update with terminal status should arrive").toBeTruthy();
  expect(
    toolUpdate.body.status,
    `tool resolved with: ${JSON.stringify(toolUpdate.body)}`,
  ).toBe("done");
  expect(toolUpdate.body.result_json || "").not.toContain("backend unavailable");
  expect(toolUpdate.body.result_json || "").toMatch(/tracks/);
});
