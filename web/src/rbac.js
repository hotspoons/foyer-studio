// Client-side RBAC helpers.
//
// The server is the enforcement point (see DECISION 38) — these
// helpers just mirror server decisions so the UI can hide or disable
// controls that'd hit a gated command, giving non-admin guests a
// clean view instead of a maze of failing clicks.
//
// `isAllowed(tag)` is the thin wrapper around `store.isAllowed` so
// components don't have to null-check `window.__foyer?.store` at
// every call site.
//
// `isActionAllowed(actionId)` handles the `invoke_action` catalog:
// the backend surfaces transport/session/track actions with ids like
// "session.save" or "edit.undo", and the UI routes them via the
// `invoke_action` command (or a command-specific shortcut like
// `save_session`). This helper maps each id to the command tag that
// actually runs on its behalf, so we can gate per-action rather than
// hiding the whole action catalog.

/** Return `window.__foyer?.store`, or a no-op shim if the store isn't mounted. */
function store() {
  return window.__foyer?.store || null;
}

/** True when the current connection's role permits `cmdTag`. LAN = always true. */
export function isAllowed(cmdTag) {
  const s = store();
  if (!s || typeof s.isAllowed !== "function") return true;
  return s.isAllowed(cmdTag);
}

/// Some action ids are handled entirely in the browser (zoom, toggle
/// a localStorage preference, open a client-side modal) — they never
/// hit the backend, so RBAC doesn't apply to them. These ids always
/// stay visible regardless of role.
const CLIENT_ONLY_ACTIONS = new Set([
  "transport.return_on_stop",
  "view.zoom_selection",
  "view.zoom_previous",
  "settings.preferences",
]);

/// Specific action ids that take a different server command than
/// the generic `invoke_action` dispatch — either because they need
/// extra parameters (a path, a session id) or because they're
/// client-orchestrated: the menu handler lives in the browser but
/// the selection-walk it performs dispatches a backend command per
/// affected target. Gate on the specific command so a role can have
/// "invoke generic actions" but not "delete regions."
const ACTION_SPECIFIC_COMMAND = {
  "session.save":    "save_session",
  "session.save_as": "save_session",
  "session.close":   "close_session",
  "session.new":     "launch_project",
  "session.open":    "launch_project",
  // Client-orchestrated selection ops — handler iterates the timeline
  // selection and fires one command per hit. Gate on the underlying
  // write command so viewers don't see a menu entry that'd fail with
  // `forbidden_for_role` the instant they click it.
  "edit.delete_selection": "delete_region",
  "edit.mute_selection":   "update_region",
};

/// Decide whether a given action catalog entry (id) should be shown.
/// Client-only ids are always shown; otherwise we check the specific
/// command the entry will dispatch, or fall back to `invoke_action`
/// for the generic case.
export function isActionAllowed(actionId) {
  if (!actionId) return true;
  if (CLIENT_ONLY_ACTIONS.has(actionId)) return true;
  const specific = ACTION_SPECIFIC_COMMAND[actionId];
  if (specific) return isAllowed(specific);
  return isAllowed("invoke_action");
}

/// Helper for components to re-render when the role snapshot changes.
/// Usage:
///   const offRbac = onRbacChange(() => this.requestUpdate());
///   // later...
///   offRbac();
export function onRbacChange(cb) {
  const s = store();
  if (!s?.addEventListener) return () => {};
  s.addEventListener("rbac", cb);
  return () => s.removeEventListener("rbac", cb);
}
