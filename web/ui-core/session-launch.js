// Project-launch guard shared by every ui-* variant. Lives in
// ui-core because it depends on a ui-core primitive (the
// confirm-modal) but isn't married to any one variant's surface.
//
// Two interactive checkpoints fire before a `launch_project` hits
// the wire:
//
//   1. Unsaved-changes guard: if the currently-focused session has
//      uncommitted edits, prompt to Save / Switch without saving /
//      Cancel. Without this, switching from the welcome screen / a
//      session sheet / a recents tap would silently lose edits the
//      user hadn't saved.
//
//   2. Crash-recovery prompt: ask the sidecar via
//      `Command::ProbeSessionRecovery` whether the project has a
//      live `.pending` file (uncommitted dirty state from a
//      crashed Ardour run). If yes, ask the user to either
//      RECOVER (preserve the unsaved work — the Ardour shim
//      auto-clicks the native recovery dialog when it opens) or
//      DISCARD (server deletes `.pending` before launch so the
//      dialog never appears). The choice rides on the wire as
//      `LaunchProject.recover_crash`. `.history` files are
//      normal undo state and are never reported / touched.

import { confirmChoice } from "./widgets/confirm-modal.js";

function currentSessionInfo(store) {
  if (!store) return null;
  if (typeof store.currentSession === "function") return store.currentSession();
  const id = store.state?.currentSessionId;
  if (!id) return null;
  return (store.state?.sessions || []).find((s) => s.id === id) || null;
}

function isDirty(store, sessionId) {
  if (!store || !sessionId) return false;
  const info = (store.state?.sessions || []).find((s) => s.id === sessionId);
  if (info) return !!info.dirty;
  return !!store.state?.session?.dirty;
}

async function waitForSaveAck(store, sessionId, timeoutMs = 1800) {
  if (!store || !sessionId || !isDirty(store, sessionId)) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      store.removeEventListener("change", onChange);
      store.removeEventListener("sessions", onChange);
      resolve();
    };
    const onChange = () => {
      if (!isDirty(store, sessionId)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    store.addEventListener("change", onChange);
    store.addEventListener("sessions", onChange);
    onChange();
  });
}

async function confirmUnsavedBeforeLaunch(store, ws) {
  const cur = currentSessionInfo(store);
  if (!cur?.dirty) return true;

  const choice = await confirmChoice({
    title: "Unsaved changes",
    message:
      `"${cur.name || "This session"}" has unsaved changes.\n\n`
      + "Save before switching sessions?",
    confirmLabel: "Save & switch",
    altLabel: "Switch without saving",
    altTone: "danger",
    cancelLabel: "Cancel",
    tone: "warning",
  });
  if (choice === "confirm") {
    ws?.send({ type: "save_session" });
    await waitForSaveAck(store, cur.id);
    return true;
  }
  if (choice === "alt") return true;
  return false;
}

/**
 * Round-trip a `ProbeSessionRecovery` and resolve to the array of
 * artifacts the sidecar found. Returns `[]` on timeout — better to
 * launch without the prompt than block a project open if the
 * server's slow.
 *
 * The probe fires-and-resolves on a single envelope match; the
 * server doesn't carry a request id (broadcast bus), so we filter
 * by matching `project_path`. That's safe: each probe is a single
 * round-trip and we don't fire two in flight for the same path.
 */
function probeSessionRecovery(ws, projectPath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!ws) {
      resolve([]);
      return;
    }
    let done = false;
    const finish = (artifacts) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.removeEventListener("envelope", onEnv);
      resolve(artifacts);
    };
    const onEnv = (ev) => {
      const body = ev.detail?.body;
      if (body?.type !== "session_recovery_available") return;
      if (body.project_path !== projectPath) return;
      finish(body.artifacts || []);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    ws.addEventListener("envelope", onEnv);
    ws.send({ type: "probe_session_recovery", project_path: projectPath });
  });
}

function formatArtifactList(artifacts) {
  // Most-recent first when summarizing — that's the modification
  // the user is most likely to want to preserve.
  const sorted = [...artifacts].sort(
    (a, b) => (b.mtime_unix_ms || 0) - (a.mtime_unix_ms || 0),
  );
  const ageOf = (mtime) => {
    if (!mtime) return null;
    const minutes = Math.max(0, Math.round((Date.now() - mtime) / 60000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  };
  return sorted
    .map((a) => {
      const age = ageOf(a.mtime_unix_ms);
      return age ? `  • ${a.name} — modified ${age}` : `  • ${a.name}`;
    })
    .join("\n");
}

/**
 * Prompt for a project that has uncommitted crash state (`.pending`).
 * Returns one of:
 *   - `true`   → Recover. Sets `recover_crash: true` on the launch
 *                payload so the shim auto-clicks the native dialog.
 *   - `false`  → Discard. Sets `recover_crash: false` so the server
 *                deletes `.pending` before spawn (no dialog opens).
 *   - `null`   → Cancel / user chose to download offline; abort the launch.
 *
 * Bonus power-user escape: a small inline "download project" link
 * inside the message body triggers the offline-recovery flow without
 * eating a button slot.
 */
async function confirmCrashDataBeforeLaunch(artifacts, projectPath) {
  const projectName = projectPath.replace(/\.ardour\/?$/, "").split("/").pop()
    || projectPath;
  const summary = formatArtifactList(artifacts);

  const title = "Unsaved work from a previous crash";
  const body =
    `"${projectName}" has uncommitted changes from a previous Ardour run:\n\n`
    + `${summary}\n\n`
    + "Recover replays them into the session (Ardour's own crash-recovery "
    + "flow, dispatched programmatically by the Foyer shim). Discard "
    + "throws them away and opens the project clean. The session's "
    + "undo history is preserved either way. "
    + "If you want to recover offline instead, cancel and download the "
    + "project from the welcome screen.";

  const choice = await confirmChoice({
    title,
    message: body,
    confirmLabel: "Recover",
    altLabel: "Discard",
    altTone: "danger",
    cancelLabel: "Cancel",
    tone: "warning",
  });
  if (choice === "confirm") return true;
  if (choice === "alt") return false;
  return null;
}

export async function launchProjectGuarded({
  backend_id,
  project_path,
  sample_rate,
  ws = window.__foyer?.ws,
  store = window.__foyer?.store,
} = {}) {
  if (!ws || !project_path) return false;
  const ok = await confirmUnsavedBeforeLaunch(store, ws);
  if (!ok) return false;

  let recoverCrash = null;
  const artifacts = await probeSessionRecovery(ws, project_path);
  if (artifacts.length > 0) {
    recoverCrash = await confirmCrashDataBeforeLaunch(artifacts, project_path);
    if (recoverCrash === null) return false; // cancelled
  }

  const payload = {
    type: "launch_project",
    backend_id,
    project_path,
  };
  if (sample_rate != null && Number.isFinite(Number(sample_rate))) {
    payload.sample_rate = Math.round(Number(sample_rate));
  }
  if (recoverCrash !== null) {
    payload.recover_crash = recoverCrash;
  }
  ws.send(payload);
  return true;
}

