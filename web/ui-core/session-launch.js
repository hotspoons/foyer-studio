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
//      `Command::ProbeSessionRecovery` whether the project has
//      `.history` / `.pending` files (or legacy `.bak.<stamp>`
//      clutter) lying around. If yes, ask the user to either
//      ABORT and download the project (so they can recover the
//      data offline however they want) or OPEN and let foyer
//      sweep everything into a hidden `.foyer-crash-archive/`
//      subfolder. Ardour can't recover crash data without
//      popping its native modal — which we can't dismiss from the
//      web shell — so foyer's policy is to never let Ardour see
//      those files in the first place.

import { confirmChoice } from "./widgets/confirm-modal.js";
import { toast } from "./widgets/toast.js";

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
      const tag = a.archived
        ? " (already archived)"
        : a.kind === "pending" ? " (uncommitted)" : "";
      return age ? `  • ${a.name} — modified ${age}${tag}` : `  • ${a.name}${tag}`;
    })
    .join("\n");
}

/**
 * Hit `/sessions/export?path=…` and stream the resulting tarball
 * to disk via a transient blob URL. Uses `fetch` rather than the
 * cheaper `<a download>` trick because the server tars + gzips the
 * whole project into memory before sending — `fetch().then(r)`
 * resolves at the moment compression finishes, which is exactly
 * when the busy spinner should drop. With a bare anchor click,
 * the user sees nothing for the seconds-of-CPU spent compressing
 * and (rightly) thinks foyer is stuck.
 *
 * Trade-off: the response body is buffered in browser memory
 * before save. For typical foyer sessions (single-digit MB
 * compressed) this is fine; very large sessions (>1 GB) would be
 * a problem. If we ever ship sessions that big, swap in a
 * streaming progress UI against the fetch reader instead.
 */
async function downloadProjectArchive(projectPath) {
  if (!projectPath) return false;
  // Mirror the tunnel-guest token onto the request so the same RBAC
  // gate that protects /ws protects /sessions/export. LAN clients
  // never have a token and the query stays empty.
  let url = `/sessions/export?path=${encodeURIComponent(projectPath)}`;
  if (typeof window !== "undefined") {
    const t = new URLSearchParams(window.location.search).get("token");
    if (t) url += `&token=${encodeURIComponent(t)}`;
  }
  const filename = `${(projectPath.split("/").pop() || "project")}.tar.gz`;
  // Effectively-no-auto-dismiss TTL — we manage the lifetime
  // around fetch + blob save. If something goes catastrophically
  // wrong (network drop with no error fired) the user can click
  // to dismiss; the 60s ceiling stops a permanently-broken
  // request from leaving a stuck banner.
  const dismissBusy = toast(`Compressing ${filename}…`, { ttl: 60_000 });
  try {
    const resp = await fetch(url, { credentials: "same-origin" });
    if (!resp.ok) {
      throw new Error(`server returned ${resp.status}`);
    }
    const blob = await resp.blob();
    dismissBusy();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer the revoke so the browser has time to start the
    // download. Some browsers race revoke against the file save
    // dialog and end up with a "failed: network error" if we
    // revoke synchronously.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5_000);
    toast(`Downloaded ${filename}`, { tone: "info" });
    return true;
  } catch (e) {
    dismissBusy();
    toast(`Download failed: ${e.message || e}`, { tone: "error" });
    return false;
  }
}

/**
 * Prompt for a project that has crash data on disk. Returns:
 *   - "open"    → archive the artifacts and proceed with launch
 *   - "abort"   → user is downloading the project + recovering offline; do not launch
 *   - null      → user cancelled; do not launch
 *
 * Side effect: when "abort" is returned, the function has already
 * triggered the project-archive download. The caller doesn't need
 * to do anything further with that path.
 */
async function confirmCrashDataBeforeLaunch(artifacts, projectPath) {
  const projectName = projectPath.replace(/\.ardour\/?$/, "").split("/").pop()
    || projectPath;
  const hasPending = artifacts.some((a) => a.kind === "pending" && !a.archived);
  const allArchived = artifacts.length > 0 && artifacts.every((a) => a.archived);
  const summary = formatArtifactList(artifacts);

  let title;
  let body;
  if (allArchived) {
    title = "Crash data on disk";
    body =
      `"${projectName}" has crash-recovery data left over from earlier `
      + `foyer runs:\n\n${summary}\n\n`
      + "Foyer can't replay this for you — Ardour's recovery flow needs "
      + "Ardour's own GUI dialog, which isn't reachable from the web shell. "
      + "Either download the project so you can recover offline, or have "
      + "foyer move the files into a hidden archive subfolder and open the "
      + "session fresh.";
  } else if (hasPending) {
    title = "Unsaved work from a previous crash";
    body =
      `"${projectName}" has uncommitted changes from a previous crash:\n\n${summary}\n\n`
      + "Foyer can't have Ardour replay these — its recovery flow requires "
      + "Ardour's own GUI dialog, which isn't reachable from the web shell. "
      + "If you want the data, download the project archive and recover "
      + "offline (open it in a desktop Ardour, accept the recovery prompt, "
      + "save). Otherwise foyer will move the recovery files into a hidden "
      + "archive subfolder and open the session fresh.";
  } else {
    title = "Crash data on disk";
    body =
      `"${projectName}" has crash-recovery data on disk:\n\n${summary}\n\n`
      + "Foyer can't have Ardour replay these — its recovery flow requires "
      + "Ardour's own GUI dialog. Download the project to recover offline, "
      + "or have foyer archive the files and open the session fresh.";
  }

  const choice = await confirmChoice({
    title,
    message: body,
    confirmLabel: "Open (archive crash data)",
    altLabel: "Abort & download project",
    altTone: "warning",
    cancelLabel: "Cancel",
    tone: "warning",
  });
  if (choice === "confirm") return "open";
  if (choice === "alt") {
    downloadProjectArchive(projectPath);
    return "abort";
  }
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

  const artifacts = await probeSessionRecovery(ws, project_path);
  if (artifacts.length > 0) {
    const choice = await confirmCrashDataBeforeLaunch(artifacts, project_path);
    if (choice !== "open") return false; // Cancel or abort+download.
  }

  const payload = {
    type: "launch_project",
    backend_id,
    project_path,
  };
  if (sample_rate != null && Number.isFinite(Number(sample_rate))) {
    payload.sample_rate = Math.round(Number(sample_rate));
  }
  ws.send(payload);
  return true;
}
