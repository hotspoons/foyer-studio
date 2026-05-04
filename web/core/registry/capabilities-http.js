/**
 * Engine capability HTTP helpers — pairs with `foyer-capabilities` + `/capabilities` routes.
 *
 * Use after boot: fetch snapshot, compare `registry_version` to a bundled constant,
 * POST `/capabilities/diff` with `{ registry_version, known_ids }` where `known_ids`
 * is the sorted list of wire strings your UI references (see `FoyerCapability` in Rust).
 */

/**
 * @param {string} [base=''] - origin prefix (e.g. '' for same-origin)
 * @returns {Promise<{ registry_version: number, capabilities: Array<{id: string, description?: string}>, active_features: Record<string, boolean> }>}
 */
export async function fetchCapabilitiesSnapshot(base = "") {
  const r = await fetch(`${base}/capabilities`);
  if (!r.ok) throw new Error(`GET /capabilities failed: ${r.status}`);
  return r.json();
}

/**
 * @param {{ registry_version?: number, known_ids: string[] }} body
 * @param {string} [base='']
 */
export async function fetchCapabilitiesDiff(body, base = "") {
  const r = await fetch(`${base}/capabilities/diff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST /capabilities/diff failed: ${r.status}`);
  return r.json();
}
