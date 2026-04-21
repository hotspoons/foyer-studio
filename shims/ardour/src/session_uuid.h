/*
 * Foyer Studio — Ardour shim: session UUID persistence + registry file.
 *
 * Each Ardour session Foyer has opened gets a UUID stored inside the
 * `.ardour` file's top-level extra_xml under `<Foyer><Session id="…"/>`.
 * The UUID is generated the first time Foyer opens the session and
 * persists across saves — reopening the same project from any Foyer
 * install resolves to the same UUID, which the sidecar uses for
 * "is this already open" detection and switcher identity.
 *
 * On startup the shim also writes a registry entry at
 * `~/.local/share/foyer/sessions/<uuid>.json` describing its running
 * state (pid, socket path, project path). The sidecar scans that
 * directory for orphans — shim processes still running after Foyer
 * crashed, or crashed shims with leftover registry data that should
 * prompt a "reopen session?" dialog.
 *
 * The registry entry is removed on clean shutdown; anything that
 * survives across Foyer's lifetime is, by definition, an orphan.
 */
#ifndef foyer_shim_session_uuid_h
#define foyer_shim_session_uuid_h

#include <string>

namespace ARDOUR { class Session; }

namespace ArdourSurface::session_uuid {

/// Read the session UUID from the session's extra_xml. Generates +
/// writes a fresh v4 UUID if the `<Foyer><Session>` node is missing.
/// The first-write marks the session dirty so the next save persists
/// the UUID — without this the UUID would be regenerated on every
/// reopen until the user saves, losing switcher identity across
/// restarts.
std::string ensure_uuid (ARDOUR::Session& session);

/// Write (or refresh) the sidecar registry entry for this running
/// shim. Safe to call repeatedly — it just overwrites. Best-effort:
/// a failure here is logged but non-fatal, since the shim itself
/// works fine without a registry entry; only orphan recovery needs it.
void write_registry_entry (const std::string& session_uuid,
                           const std::string& project_path,
                           const std::string& project_name,
                           const std::string& socket_path,
                           const std::string& backend_id);

/// Remove the registry entry. Called on clean shim shutdown so the
/// sidecar doesn't misclassify us as an orphan on next Foyer start.
void remove_registry_entry (const std::string& session_uuid);

} // namespace ArdourSurface::session_uuid

#endif
