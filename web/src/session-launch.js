import { confirmChoice } from "./components/confirm-modal.js";

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

export async function launchProjectGuarded({
  backend_id,
  project_path,
  ws = window.__foyer?.ws,
  store = window.__foyer?.store,
} = {}) {
  if (!ws || !project_path) return false;
  const ok = await confirmUnsavedBeforeLaunch(store, ws);
  if (!ok) return false;
  ws.send({
    type: "launch_project",
    backend_id,
    project_path,
  });
  return true;
}
