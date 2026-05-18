// SPDX-License-Identifier: Apache-2.0
//! Ardour session XML helpers — Foyer Shim activation, sample-rate
//! patch, session-existence probe, atomic write. Split out of
//! `main.rs` so the pure-string transform (`apply_foyer_shim_edit`,
//! `patch_session_xml_sample_rate_content`) lives next to its unit
//! tests, and the I/O wrappers (`ensure_foyer_shim_active`,
//! `patch_ardour_session_sample_rate`) sit close to their pure
//! cores. None of these touch CLI-level state — pure file I/O and
//! string transforms.
//!
//! `apply_foyer_shim_edit` mirrors the dev-build bash sed patterns
//! at the top of `launch_and_wait_for_shim`. Priority order:
//!   1. Already-active substring present → AlreadyActive.
//!   2. Element listed with canonical `name="…" active="0"` ordering
//!      → flip in place.
//!   3. Listed in some other shape → ListedButUnknownShape (warn,
//!      no edit). This case fires when Ardour writes attrs in a
//!      different order than the bash sed expects; flipping
//!      heuristically risks corrupting the XML.
//!   4. Not listed but `</ControlProtocols>` present → insert.
//!   5. None of the above → NoControlProtocolsBlock.

use std::path::Path;

use anyhow::{Context, Result};

/// True when an Ardour session file matching `snapshot_name`
/// already exists under `session_dir` — either as a flat
/// `<snapshot>.ardour` next to it or as a nested
/// `<snapshot>/<snapshot>.ardour`. Used by the launcher to decide
/// between "open existing" and "create new" paths.
pub(crate) fn ardour_had_existing_session(session_dir: &Path, snapshot_name: &str) -> bool {
    session_dir
        .join(format!("{snapshot_name}.ardour"))
        .is_file()
        || session_dir
            .join(snapshot_name)
            .join(format!("{snapshot_name}.ardour"))
            .is_file()
}

/// Rewrite the first `sample-rate="…"` attribute (Ardour root
/// `<Session>` tag). Returns `Ok(None)` when the attribute is
/// absent or already matches `sr`.
pub(crate) fn patch_session_xml_sample_rate_content(xml: &str, sr: u32) -> Result<Option<String>> {
    const RANGE: std::ops::RangeInclusive<u32> = 8000..=384_000;
    if !RANGE.contains(&sr) {
        anyhow::bail!("sample rate {sr} is outside supported range {RANGE:?}");
    }
    let needle = "sample-rate=\"";
    let Some(pos) = xml.find(needle) else {
        tracing::warn!("foyer: session XML has no sample-rate attribute — leaving file unchanged");
        return Ok(None);
    };
    let start = pos + needle.len();
    let Some(end_rel) = xml[start..].find('"') else {
        anyhow::bail!("session XML sample-rate attribute is malformed");
    };
    let end = start + end_rel;
    let prev = &xml[start..end];
    if prev == sr.to_string() {
        return Ok(None);
    }
    let mut out = xml.to_string();
    out.replace_range(start..end, &sr.to_string());
    Ok(Some(out))
}

pub(crate) fn patch_ardour_session_sample_rate(session_file: &Path, sr: u32) -> Result<()> {
    let meta = std::fs::symlink_metadata(session_file)
        .with_context(|| format!("stat session file {}", session_file.display()))?;
    if !meta.file_type().is_file() {
        anyhow::bail!(
            "session file {} is not a regular file — refusing to patch sample-rate",
            session_file.display(),
        );
    }
    let original = std::fs::read_to_string(session_file)
        .with_context(|| format!("read session file {}", session_file.display()))?;
    let Some(updated) = patch_session_xml_sample_rate_content(&original, sr)? else {
        return Ok(());
    };
    write_atomic(session_file, &updated)
        .with_context(|| format!("write session file {}", session_file.display()))?;
    tracing::info!(
        "foyer: patched session sample-rate to {sr} in {}",
        session_file.display(),
    );
    Ok(())
}

pub(crate) fn ensure_foyer_shim_active(session_file: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(session_file)
        .with_context(|| format!("stat session file {}", session_file.display()))?;
    if !meta.file_type().is_file() {
        anyhow::bail!(
            "session file {} is not a regular file (symlink or special file?) — \
             refusing to follow",
            session_file.display(),
        );
    }
    let original = std::fs::read_to_string(session_file)
        .with_context(|| format!("read session file {}", session_file.display()))?;
    match apply_foyer_shim_edit(&original) {
        FoyerShimEdit::AlreadyActive => {}
        FoyerShimEdit::FlippedToActive { updated } => {
            tracing::info!(
                "foyer: flipping Foyer Studio Shim to active=\"1\" in {}",
                session_file.display(),
            );
            write_atomic(session_file, &updated)
                .with_context(|| format!("write session file {}", session_file.display()))?;
        }
        FoyerShimEdit::Inserted { updated } => {
            tracing::info!(
                "foyer: inserting Foyer Studio Shim into {}",
                session_file.display(),
            );
            write_atomic(session_file, &updated)
                .with_context(|| format!("write session file {}", session_file.display()))?;
        }
        FoyerShimEdit::ListedButUnknownShape => {
            tracing::warn!(
                "foyer: Foyer Studio Shim already listed in {} but in a non-canonical shape — leaving alone",
                session_file.display(),
            );
        }
        FoyerShimEdit::NoControlProtocolsBlock => {
            tracing::warn!(
                "foyer: WARNING no <ControlProtocols> block found in {} — add Foyer Studio Shim by hand",
                session_file.display(),
            );
        }
    }
    Ok(())
}

/// Outcome of one pass of the Foyer Studio Shim activation rule over
/// a session XML blob. Pure value — `apply_foyer_shim_edit` does no
/// I/O, so the rule is unit-testable without an Ardour install.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FoyerShimEdit {
    /// Already listed with `active="1"`. No-op.
    AlreadyActive,
    /// Element was listed with `active="0"` in the canonical attr
    /// order; flipped to `active="1"` in place.
    FlippedToActive { updated: String },
    /// Element wasn't listed at all but `</ControlProtocols>` exists;
    /// inserted a fresh `<Protocol …/>` line just before the closer.
    Inserted { updated: String },
    /// Listed but in an attr ordering / shape we don't recognize.
    /// Don't insert (would duplicate) and don't flip (don't know how
    /// to do it safely). Caller logs a warning and leaves the file
    /// alone.
    ListedButUnknownShape,
    /// No `<ControlProtocols>` block at all — extremely old session
    /// or a manual hand-edit. Caller logs a warning.
    NoControlProtocolsBlock,
}

/// Outcome of one pass of the MCPHttp activation rule.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum McpHttpEdit {
    /// `<Protocol name="MCPHttp" active="1" port="N"/>` already present
    /// with the same port — leave alone.
    AlreadyOnPort,
    /// Was present at a different port (or inactive); rewrote the port
    /// (and active=1) in place.
    Repointed { updated: String },
    /// Wasn't listed at all; inserted a fresh `<Protocol …/>` before
    /// `</ControlProtocols>`.
    Inserted { updated: String },
    /// No `<ControlProtocols>` block at all — same edge case
    /// `apply_foyer_shim_edit` warns on.
    NoControlProtocolsBlock,
}

/// Rewrite an Ardour session XML so the MCPHttp control surface is
/// enabled on `port`. Idempotent on the same port; rewrites in place
/// when the port differs or the surface was inactive.
///
/// Why per-session XML and not the user-level Ardour config? Each
/// Foyer-spawned Ardour shares one user config dir, so a per-user
/// global port would collide when two sessions are open at once.
/// MCPHttp's XML reader prefers the session value over the global
/// (see `mcp_http.cc`: `node.get_property("port", …)` runs before
/// `read_global_protocol_property`).
pub(crate) fn apply_mcp_http_edit(input: &str, port: u16) -> McpHttpEdit {
    // Quick exact match — same port + active. Avoids a redundant
    // rewrite (and a fresh file mtime that would surprise the
    // bootstrap helper's "needs save?" check).
    let happy = format!(r#"<Protocol name="MCPHttp" active="1" port="{port}"/>"#);
    if input.contains(&happy) {
        return McpHttpEdit::AlreadyOnPort;
    }
    // Find any prior `<Protocol name="MCPHttp" …/>` entry and swap
    // it for a canonical one. Bounded by the matching `/>` so we
    // never reach into the next protocol.
    let needle = r#"<Protocol name="MCPHttp""#;
    if let Some(start) = input.find(needle) {
        if let Some(rel_end) = input[start..].find("/>") {
            let end = start + rel_end + 2;
            let mut new = String::with_capacity(input.len());
            new.push_str(&input[..start]);
            new.push_str(&format!(
                r#"<Protocol name="MCPHttp" active="1" port="{port}"/>"#
            ));
            new.push_str(&input[end..]);
            return McpHttpEdit::Repointed { updated: new };
        }
    }
    if let Some(idx) = input.find("</ControlProtocols>") {
        let insertion =
            format!("    <Protocol name=\"MCPHttp\" active=\"1\" port=\"{port}\"/>\n  ");
        let mut new = String::with_capacity(input.len() + insertion.len());
        new.push_str(&input[..idx]);
        new.push_str(&insertion);
        new.push_str(&input[idx..]);
        return McpHttpEdit::Inserted { updated: new };
    }
    McpHttpEdit::NoControlProtocolsBlock
}

/// I/O wrapper around [`apply_mcp_http_edit`]. Reads the session
/// file, applies the edit, writes atomically. Returns `Ok(())` for
/// any outcome that didn't require a write (already-on-port, no
/// `<ControlProtocols>` block).
pub(crate) fn ensure_mcp_http_on_port(session_file: &Path, port: u16) -> Result<()> {
    let meta = std::fs::symlink_metadata(session_file)
        .with_context(|| format!("stat session file {}", session_file.display()))?;
    if !meta.file_type().is_file() {
        anyhow::bail!(
            "session file {} is not a regular file — refusing to follow",
            session_file.display(),
        );
    }
    let original = std::fs::read_to_string(session_file)
        .with_context(|| format!("read session file {}", session_file.display()))?;
    match apply_mcp_http_edit(&original, port) {
        McpHttpEdit::AlreadyOnPort => Ok(()),
        McpHttpEdit::Repointed { updated } | McpHttpEdit::Inserted { updated } => {
            write_atomic(session_file, &updated).with_context(|| {
                format!("write MCPHttp port edit to {}", session_file.display())
            })?;
            tracing::info!(
                "foyer: pinned MCPHttp to port {port} in {}",
                session_file.display(),
            );
            Ok(())
        }
        McpHttpEdit::NoControlProtocolsBlock => {
            tracing::warn!(
                "foyer: no <ControlProtocols> block in {} — MCPHttp NOT enabled \
                 (Ardour likely too old for this surface)",
                session_file.display(),
            );
            Ok(())
        }
    }
}

/// Parse the configured MCPHttp port out of a session XML body.
/// Returns `None` when MCPHttp isn't listed, is inactive, or the
/// port= attribute is missing / malformed.
///
/// The reported value is the *configured* port (what the session
/// tells Ardour to bind), not the actually-bound port. The bound
/// port is normally the same, but a port collision at the OS layer
/// would diverge them; callers that need certainty should probe the
/// endpoint after this returns.
pub(crate) fn parse_mcp_http_port(input: &str) -> Option<u16> {
    // Find the MCPHttp protocol entry. The element is a void XML
    // element so the whole record fits between the opening `<` and
    // the next `/>`. We scan that range for `active="1"` and a
    // `port="N"` attribute.
    let needle = r#"<Protocol name="MCPHttp""#;
    let start = input.find(needle)?;
    let rel_end = input[start..].find("/>")?;
    let elem = &input[start..start + rel_end + 2];
    if !elem.contains(r#"active="1""#) {
        return None;
    }
    let port_anchor = elem.find(r#"port=""#)?;
    let after = &elem[port_anchor + r#"port=""#.len()..];
    let close = after.find('"')?;
    after[..close].parse::<u16>().ok()
}

/// Disk-side wrapper around [`parse_mcp_http_port`] — read the
/// session's `.ardour` file and look for an MCPHttp port pin.
/// Public to the CLI crate so the reuse-existing-shim path can call
/// it as a fallback when the shim's advert JSON didn't carry the
/// port (older shim builds, 9.2).
pub(crate) fn read_mcp_http_port(session_file: &Path) -> Option<u16> {
    let text = std::fs::read_to_string(session_file).ok()?;
    parse_mcp_http_port(&text)
}

pub(crate) fn apply_foyer_shim_edit(input: &str) -> FoyerShimEdit {
    if input.contains(r#"name="Foyer Studio Shim" active="1""#) {
        return FoyerShimEdit::AlreadyActive;
    }
    if input.contains(r#"name="Foyer Studio Shim""#) {
        let start_anchor = r#"<Protocol name="Foyer Studio Shim" active="0""#;
        if let Some(anchor) = input.find(start_anchor) {
            // Bound the rewrite to the matching void element so we
            // never reach across into another `<Protocol .../>`.
            if let Some(rel_end) = input[anchor..].find("/>") {
                let abs_end = anchor + rel_end + 2;
                let mut new = String::with_capacity(input.len());
                new.push_str(&input[..anchor]);
                new.push_str(r#"<Protocol name="Foyer Studio Shim" active="1""#);
                new.push_str(&input[anchor + start_anchor.len()..abs_end]);
                new.push_str(&input[abs_end..]);
                return FoyerShimEdit::FlippedToActive { updated: new };
            }
        }
        return FoyerShimEdit::ListedButUnknownShape;
    }
    if let Some(idx) = input.find("</ControlProtocols>") {
        // Match the indentation the bash version emits — four spaces
        // for the inserted protocol, two before the closer. Ardour
        // re-indents on save anyway, so absolute fidelity isn't
        // required, but matching makes the diff readable.
        let insertion = "    <Protocol name=\"Foyer Studio Shim\" active=\"1\"/>\n  ";
        let mut new = String::with_capacity(input.len() + insertion.len());
        new.push_str(&input[..idx]);
        new.push_str(insertion);
        new.push_str(&input[idx..]);
        return FoyerShimEdit::Inserted { updated: new };
    }
    FoyerShimEdit::NoControlProtocolsBlock
}

/// Write `contents` to `path` atomically: stage in a sibling temp
/// file, then rename. Avoids leaving a half-written `.ardour` behind
/// if the process is killed mid-write — Ardour treats a truncated
/// session file as unrecoverable.
pub(crate) fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("session");
    let tmp = dir.join(format!(".{stem}.foyer-tmp"));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_already_active_is_noop() {
        let input = r#"<Session>
  <ControlProtocols>
    <Protocol name="Foyer Studio Shim" active="1"/>
    <Protocol name="OSC" active="0"/>
  </ControlProtocols>
</Session>"#;
        assert_eq!(apply_foyer_shim_edit(input), FoyerShimEdit::AlreadyActive);
    }

    #[test]
    fn xml_listed_inactive_gets_flipped() {
        let input = r#"<Session>
  <ControlProtocols>
    <Protocol name="OSC" active="0"/>
    <Protocol name="Foyer Studio Shim" active="0"/>
  </ControlProtocols>
</Session>"#;
        match apply_foyer_shim_edit(input) {
            FoyerShimEdit::FlippedToActive { updated } => {
                assert!(updated.contains(r#"<Protocol name="Foyer Studio Shim" active="1"/>"#));
                // Other elements left intact.
                assert!(updated.contains(r#"<Protocol name="OSC" active="0"/>"#));
                // No stray active="0" remains on the Foyer element.
                assert!(!updated.contains(r#"name="Foyer Studio Shim" active="0""#));
            }
            other => panic!("expected FlippedToActive, got {other:?}"),
        }
    }

    #[test]
    fn xml_listed_inactive_with_extra_attrs_preserved() {
        // Ardour writes additional attrs (feedback, strict-id, etc.) on
        // each Protocol. The flip must preserve them — we only touch
        // active="0" → active="1", nothing else inside the element.
        let input = r#"<Protocol name="Foyer Studio Shim" active="0" feedback="0"/>"#;
        match apply_foyer_shim_edit(input) {
            FoyerShimEdit::FlippedToActive { updated } => {
                assert_eq!(
                    updated,
                    r#"<Protocol name="Foyer Studio Shim" active="1" feedback="0"/>"#
                );
            }
            other => panic!("expected FlippedToActive, got {other:?}"),
        }
    }

    #[test]
    fn xml_not_listed_gets_inserted() {
        let input = r#"<Session>
  <ControlProtocols>
    <Protocol name="OSC" active="0"/>
  </ControlProtocols>
</Session>"#;
        match apply_foyer_shim_edit(input) {
            FoyerShimEdit::Inserted { updated } => {
                assert!(updated.contains(r#"<Protocol name="Foyer Studio Shim" active="1"/>"#));
                assert!(updated.contains(r#"<Protocol name="OSC" active="0"/>"#));
                let shim_idx = updated.find("Foyer Studio Shim").unwrap();
                let close_idx = updated.find("</ControlProtocols>").unwrap();
                assert!(
                    shim_idx < close_idx,
                    "insertion must sit before </ControlProtocols>",
                );
            }
            other => panic!("expected Inserted, got {other:?}"),
        }
    }

    #[test]
    fn xml_listed_in_unknown_shape_is_left_alone() {
        // Attrs in a non-canonical order — bash sed wouldn't flip this
        // either. We refuse rather than risk a duplicate-insert.
        let input = r#"<Protocol active="0" name="Foyer Studio Shim"/>"#;
        assert_eq!(
            apply_foyer_shim_edit(input),
            FoyerShimEdit::ListedButUnknownShape,
        );
    }

    #[test]
    fn patch_sample_rate_rewrites_first_hit() {
        let xml = r#"<Session version="9" sample-rate="48000" name="x">"#;
        let out = patch_session_xml_sample_rate_content(xml, 96_000)
            .unwrap()
            .unwrap();
        assert!(out.contains(r#"sample-rate="96000""#));
        assert!(!out.contains(r#"sample-rate="48000""#));
    }

    #[test]
    fn patch_sample_rate_noop_when_missing_attr() {
        let xml = "<Session>";
        assert!(patch_session_xml_sample_rate_content(xml, 48_000)
            .unwrap()
            .is_none());
    }

    #[test]
    fn patch_sample_rate_noop_when_already_matches() {
        let xml = r#"<Session sample-rate="48000">"#;
        assert!(patch_session_xml_sample_rate_content(xml, 48_000)
            .unwrap()
            .is_none());
    }

    #[test]
    fn ardour_had_session_detects_flat_file() {
        let dir = std::env::temp_dir().join(format!(
            "foyer-test-flat-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("mysession.ardour"), "<Session/>").unwrap();
        assert!(ardour_had_existing_session(&dir, "mysession"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ardour_had_session_detects_nested_file() {
        let dir = std::env::temp_dir().join(format!(
            "foyer-test-nested-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let nested = dir.join("news");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("news.ardour"), "<Session/>").unwrap();
        assert!(ardour_had_existing_session(&dir, "news"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn xml_no_control_protocols_block_is_warn() {
        let input = r#"<Session>
  <Other/>
</Session>"#;
        assert_eq!(
            apply_foyer_shim_edit(input),
            FoyerShimEdit::NoControlProtocolsBlock,
        );
    }
}
