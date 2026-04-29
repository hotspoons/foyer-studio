//! Post-extraction sanitizer for uploaded Ardour projects.
//!
//! Ardour's session loader does two things that turn an uploaded
//! `.ardour` XML into a remote-code-execution surface:
//!
//! 1. Embedded `<Script>` blocks are base64-decoded and handed
//!    straight to Ardour's Lua VM during `Session::set_state()`.
//!    Lua bindings expose `os.execute` and arbitrary file I/O, so
//!    a 50-line .ardour with one `<Script>` is sufficient to run
//!    arbitrary commands as the Ardour user.
//! 2. Source/region paths in the XML are joined onto the search
//!    path without normalization, so a path like
//!    `../../../etc/foo` becomes a write target when Ardour saves.
//!
//! This module runs against a freshly-extracted project tree before
//! we move it into the jail. It walks every `*.ardour` and
//! `*.ardour.bak` file, parses it with `quick-xml` (no entity
//! expansion → billion-laughs is a non-issue), and:
//!
//! - **Quarantines** `<Script>`, `<LuaScripts>`, `<Videotimeline>`,
//!   `<Videomonitor>`, `<XJSettings>` subtrees by capturing them,
//!   base64-encoding, and emitting an inert `<!-- foyer:scrubbed:... -->`
//!   comment in their place. Ardour ignores comments. The original
//!   data round-trips through `restore_quarantined_xml` (exposed via
//!   `foyer scrub-restore` for desktop opt-in).
//! - Rejects the upload outright if any path-bearing attribute on a
//!   Source/Region element, or a known path-typed `<Option>`, is
//!   absolute or contains `..` segments.
//! - Deletes `*.history`, `*.history.bak`, `instant.xml`, and
//!   `instant.xml.bak` from the project tree — Ardour reads them
//!   with `XML_PARSE_HUGE`, and they have no legitimate role in a
//!   fresh upload from another machine.
//!
//! "Reject the whole upload" is the right call over "silently
//! sanitize the path" — a malicious path is almost always a sign of
//! an attacker, not a power user, and silently rewriting it leaves
//! the rest of the XML in a half-coherent state. The few legitimate
//! sessions that fail this check (someone using `audio-search-path`
//! with an absolute external sample dir) can be re-saved through a
//! fresh Ardour instance and re-uploaded.
//!
//! Quarantine, not delete, for `<Script>` etc. — the original data
//! may be legitimate Lua the author wants back on a trusted desktop.
//! Base64 inside the comment preserves every byte; the HTTP path
//! never restores (re-introducing scripts from untrusted input
//! would defeat the scrubber).
//!
//! We do NOT touch:
//!  - `peakfiles`, MIDI, or audio binaries — they're not executable
//!    by Ardour. We assume libsndfile / libsmf parse mature byte
//!    formats safely; running Ardour as an unprivileged user keeps
//!    the blast radius bounded.
//!  - The plugin allowlist. Plugin loading goes through Ardour's
//!    pre-scanned `PluginManager` list, not paths in session XML, so
//!    a plugin can't smuggle itself in via a `.ardour` reference. If
//!    we ever support packaging a plugin with a session, we'd
//!    reintroduce that gate here.

use std::path::{Component, Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use quick_xml::events::attributes::Attribute;
use quick_xml::events::{BytesStart, BytesText, Event};
use quick_xml::reader::Reader;
use quick_xml::writer::Writer;

/// Prefix every quarantined comment carries so the restore helper
/// can locate them deterministically. Single-dash form: XML 1.0
/// forbids `--` *anywhere* inside a comment body, so we keep the
/// marker free of double-hyphens. The format is:
/// `foyer:scrubbed:<tag-name>:<base64-of-original-subtree>`.
pub const SCRUB_MARKER: &str = "foyer:scrubbed:";

/// Hard ceiling on the size of a `.ardour` file we'll consider
/// scrubbing. Real sessions are sub-megabyte in practice; anything
/// past this is either pathological or an attempted DoS.
pub const MAX_SESSION_XML_BYTES: u64 = 64 * 1024 * 1024;

/// Tags whose entire subtree gets quarantined.
///
/// - `Script` / `LuaScripts` — the RCE class. `Session::set_state`
///   base64-decodes and runs these through Ardour's Lua VM.
/// - `Videotimeline` / `Videomonitor` / `XJSettings` — write
///   attacker-controlled bytes into xjadeo's stdin via
///   `SystemExec::write_to_stdin`. Newlines in the `Filename`
///   attribute let an attacker inject extra remote-control commands.
///   Not host RCE (xjadeo is a display tool, not a shell), but still
///   a privilege smuggling channel we don't owe an attacker.
const KILL_SUBTREES: &[&[u8]] = &[
    b"Script",
    b"LuaScripts",
    b"Videotimeline",
    b"Videomonitor",
    b"XJSettings",
];

/// Files in the project tree we **delete** on upload rather than
/// scrub. These carry XML or binary state that:
/// - Ardour reads with `XML_PARSE_HUGE` (no entity-expansion cap →
///   billion-laughs DoS surface).
/// - Has no legitimate role in a fresh upload from a different
///   machine — undo history, UI layout for a different display, etc.
/// - Would re-introduce the same risks the scrubber catches in the
///   `.ardour` file if we tried to clean them in place.
///
/// File-name globs are tested suffix-style against the basename
/// (case-sensitive). Operator can opt out by re-saving the project
/// in Ardour after upload, which regenerates these files cleanly.
const DELETE_FILE_SUFFIXES: &[&str] = &[".history", ".history.bak"];

/// Exact basenames we always delete. `instant.xml` is a per-session
/// UI state file (`Editor`/`Mixer`/`Main`/`Preferences` chunks)
/// parsed with `XML_PARSE_HUGE`. Useless in a fresh upload anyway.
const DELETE_FILE_BASENAMES: &[&str] = &["instant.xml", "instant.xml.bak"];

/// `<Config>` `<Option>` names whose `value=` attribute is a
/// filesystem path. Validated against `is_clean_relative` (or empty,
/// which Ardour treats as "use defaults").
const PATH_OPTION_NAMES: &[&str] = &[
    "audio-search-path",
    "midi-search-path",
    "raid-path",
    "video-server-url",
    "video-server-docroot",
];

/// Attribute names whose values, when present on a path-bearing
/// element, must point inside the project root. Applied on every
/// element — see `PATH_ELEMENT_NAME_BLOCK` for the per-element
/// `name=` rule.
const PATH_ATTR_NAMES: &[&[u8]] = &[b"file", b"path", b"origin", b"location"];

/// Element-name list for which the `name=` attribute is *also* a
/// filesystem path that must be jail-relative. Source-flavored
/// elements seed `_path = _name` in `FileSource::FileSource`, then
/// `find()` joins it onto `source_search_path()` without
/// normalization — so a `name="../../../../etc/passwd"` is the
/// same arbitrary-write vector as a malicious `origin=`.
///
/// Region, Track, Plugin etc. names are display strings only —
/// don't apply this gate to them or we'd break legitimate sessions.
const PATH_NAME_ELEMENTS: &[&[u8]] = &[
    b"Source",
    b"AudioSource",
    b"MidiSource",
    b"FileSource",
    b"AudioFileSource",
    b"SilentFileSource",
    b"SMFSource",
];

#[derive(Debug, thiserror::Error)]
pub enum ScrubError {
    #[error("session XML at {path} is {size} bytes — refusing (limit {limit})")]
    TooLarge {
        path: PathBuf,
        size: u64,
        limit: u64,
    },
    #[error("session XML at {path} is malformed: {detail}")]
    Malformed { path: PathBuf, detail: String },
    #[error(
        "session XML at {path} references unsafe path: {context} (this looks like an exploit)"
    )]
    UnsafePath { path: PathBuf, context: String },
    #[error("io {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug, Default, Clone)]
pub struct ScrubReport {
    /// `<Script>` / `<LuaScripts>` blocks dropped from this file.
    pub scripts_removed: usize,
    /// Files we walked. Useful for log output ("scrubbed 3 files").
    pub files_scrubbed: usize,
    /// Files we deleted because they're in `DELETE_FILE_*` lists
    /// (history files, instant.xml). Surfaces as "removed N
    /// risk-prone state files" in the upload reply.
    pub files_deleted: usize,
}

impl ScrubReport {
    pub fn merge(&mut self, other: ScrubReport) {
        self.scripts_removed += other.scripts_removed;
        self.files_scrubbed += other.files_scrubbed;
        self.files_deleted += other.files_deleted;
    }
}

fn should_delete(name: &str) -> bool {
    if DELETE_FILE_BASENAMES.contains(&name) {
        return true;
    }
    DELETE_FILE_SUFFIXES.iter().any(|s| name.ends_with(s))
}

/// Walk `project_root` recursively. For every file we visit:
/// - `*.ardour` / `*.ardour.bak` → scrub in place (quarantine
///   `<Script>` blocks, validate path attributes).
/// - `*.history`, `*.history.bak`, `instant.xml`, `instant.xml.bak`
///   → delete outright. These are stateful files that Ardour reads
///   with `XML_PARSE_HUGE` (no entity-expansion cap) but never need
///   to be present in a fresh upload; Ardour will regenerate them.
///   Keeping them around is a free DoS surface.
///
/// Stops on the first error so the caller can surface a single
/// offender; the caller is expected to throw away the staging dir
/// on failure (the upload tempdir cleans up on Drop).
pub fn scrub_project_dir(project_root: &Path) -> Result<ScrubReport, ScrubError> {
    let mut report = ScrubReport::default();
    walk(project_root, &mut |entry| {
        let name = entry
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if should_delete(name) {
            std::fs::remove_file(entry).map_err(|source| ScrubError::Io {
                path: entry.to_path_buf(),
                source,
            })?;
            report.files_deleted += 1;
            return Ok(());
        }
        if name.ends_with(".ardour") || name.ends_with(".ardour.bak") {
            let one = scrub_session_file(entry)?;
            report.merge(one);
        }
        Ok(())
    })?;
    Ok(report)
}

fn walk<F>(dir: &Path, visit: &mut F) -> Result<(), ScrubError>
where
    F: FnMut(&Path) -> Result<(), ScrubError>,
{
    let rd = std::fs::read_dir(dir).map_err(|source| ScrubError::Io {
        path: dir.to_path_buf(),
        source,
    })?;
    for ent in rd.flatten() {
        let path = ent.path();
        let ft = match ent.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // Don't follow symlinks — the archive extractor refuses them
        // outright, but defense-in-depth: if anything got in via a
        // separate path (a manual file drop, a future codepath that
        // bypasses the extractor), we still don't want to dereference
        // a symlink that could point outside the project tree.
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            walk(&path, visit)?;
        } else if ft.is_file() {
            visit(&path)?;
        }
    }
    Ok(())
}

fn scrub_session_file(path: &Path) -> Result<ScrubReport, ScrubError> {
    let meta = std::fs::metadata(path).map_err(|source| ScrubError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if meta.len() > MAX_SESSION_XML_BYTES {
        return Err(ScrubError::TooLarge {
            path: path.to_path_buf(),
            size: meta.len(),
            limit: MAX_SESSION_XML_BYTES,
        });
    }
    let bytes = std::fs::read(path).map_err(|source| ScrubError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let result = scrub_xml_bytes(&bytes).map_err(|detail| match detail {
        ScrubXmlError::Malformed(d) => ScrubError::Malformed {
            path: path.to_path_buf(),
            detail: d,
        },
        ScrubXmlError::UnsafePath(c) => ScrubError::UnsafePath {
            path: path.to_path_buf(),
            context: c,
        },
    })?;
    std::fs::write(path, &result.bytes).map_err(|source| ScrubError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(ScrubReport {
        scripts_removed: result.scripts_removed,
        files_scrubbed: 1,
        files_deleted: 0,
    })
}

#[derive(Debug, thiserror::Error)]
pub enum ScrubXmlError {
    #[error("malformed xml: {0}")]
    Malformed(String),
    #[error("unsafe path: {0}")]
    UnsafePath(String),
}

struct ScrubXmlOk {
    bytes: Vec<u8>,
    scripts_removed: usize,
}

/// Streaming filter — reads events, *quarantines* kill-subtree
/// elements (captures into a sidecar buffer, base64-encodes, emits as
/// an inert XML comment), validates path attributes, re-emits the
/// rest. Whitespace + non-script comments are preserved.
///
/// The quarantine path captures every nested event (so a `<Script>`
/// containing CDATA, attributes, or whitespace round-trips byte-
/// equivalently after base64-decode + re-parse). We capture into a
/// quick-xml `Writer` rather than slicing the input directly because
/// `Reader::buffer_position()` doesn't always give us the exact
/// byte boundaries we need across `Event` variants — round-tripping
/// is more robust.
fn scrub_xml_bytes(input: &[u8]) -> Result<ScrubXmlOk, ScrubXmlError> {
    let mut reader = Reader::from_reader(input);
    {
        let cfg = reader.config_mut();
        cfg.trim_text(false);
        // Default already; restate for clarity. Ardour sessions don't
        // legitimately use entities, but if any leak in, expansion
        // bytes blow up the parse → DoS surface.
        cfg.expand_empty_elements = false;
    }

    let mut writer = Writer::new(Vec::with_capacity(input.len()));
    let mut buf = Vec::new();
    let mut scripts_removed: usize = 0;

    // Quarantine state. When we enter a kill-subtree we open a
    // sidecar writer + remember the tag name; subsequent events are
    // written into the sidecar until depth returns to zero. At that
    // point we base64-encode the sidecar bytes and emit the comment.
    struct Quarantine {
        sidecar: Writer<Vec<u8>>,
        tag: Vec<u8>,
        depth: u32,
    }
    let mut quarantine: Option<Quarantine> = None;

    loop {
        let ev = reader
            .read_event_into(&mut buf)
            .map_err(|e| ScrubXmlError::Malformed(format!("parse: {e}")))?;

        // Inside a quarantine: tee everything to the sidecar; track
        // depth on Start/End so we know when to close the capture.
        if let Some(q) = quarantine.as_mut() {
            // Don't emit the Eof event into the sidecar — bare Eof
            // inside an unterminated kill-subtree means malformed
            // input. quick-xml propagates the parse error first, so
            // reaching Eof here means we never hit a matching End:
            // the input is broken.
            if matches!(ev, Event::Eof) {
                return Err(ScrubXmlError::Malformed(format!(
                    "input ended inside <{}>",
                    std::str::from_utf8(&q.tag).unwrap_or("?")
                )));
            }
            // Tee with `into_owned` so we don't hold a borrow on `buf`.
            let owned = ev.clone().into_owned();
            q.sidecar
                .write_event(owned)
                .map_err(|err| ScrubXmlError::Malformed(format!("quarantine: {err}")))?;
            match &ev {
                Event::Start(_) => q.depth += 1,
                Event::End(_) => {
                    q.depth -= 1;
                    if q.depth == 0 {
                        let q = quarantine.take().unwrap();
                        emit_quarantine_comment(&mut writer, &q.tag, &q.sidecar.into_inner())?;
                        scripts_removed += 1;
                    }
                }
                _ => {}
            }
            buf.clear();
            continue;
        }

        match ev {
            Event::Start(e) => {
                let raw_name = e.name().as_ref().to_vec();
                if KILL_SUBTREES.contains(&raw_name.as_slice()) {
                    let mut sidecar = Writer::new(Vec::new());
                    let owned = Event::Start(e.into_owned());
                    sidecar.write_event(owned).map_err(|err| {
                        ScrubXmlError::Malformed(format!("quarantine open: {err}"))
                    })?;
                    quarantine = Some(Quarantine {
                        sidecar,
                        tag: raw_name,
                        depth: 1,
                    });
                } else {
                    validate_path_attrs(&raw_name, &e)?;
                    writer
                        .write_event(Event::Start(e.into_owned()))
                        .map_err(|err| ScrubXmlError::Malformed(format!("write start: {err}")))?;
                }
            }
            Event::End(e) => {
                writer
                    .write_event(Event::End(e.into_owned()))
                    .map_err(|err| ScrubXmlError::Malformed(format!("write end: {err}")))?;
            }
            Event::Empty(e) => {
                let raw_name = e.name().as_ref().to_vec();
                if KILL_SUBTREES.contains(&raw_name.as_slice()) {
                    // Self-closing kill — capture the single event
                    // into a one-shot sidecar and emit the comment
                    // immediately.
                    let mut sidecar = Writer::new(Vec::new());
                    sidecar
                        .write_event(Event::Empty(e.into_owned()))
                        .map_err(|err| {
                            ScrubXmlError::Malformed(format!("quarantine empty: {err}"))
                        })?;
                    emit_quarantine_comment(&mut writer, &raw_name, &sidecar.into_inner())?;
                    scripts_removed += 1;
                } else {
                    validate_path_attrs(&raw_name, &e)?;
                    writer
                        .write_event(Event::Empty(e.into_owned()))
                        .map_err(|err| ScrubXmlError::Malformed(format!("write empty: {err}")))?;
                }
            }
            Event::Eof => break,
            other => {
                writer
                    .write_event(other)
                    .map_err(|err| ScrubXmlError::Malformed(format!("write other: {err}")))?;
            }
        }
        buf.clear();
    }

    if quarantine.is_some() {
        return Err(ScrubXmlError::Malformed(
            "input ended mid-quarantine — unbalanced <Script>".into(),
        ));
    }

    Ok(ScrubXmlOk {
        bytes: writer.into_inner(),
        scripts_removed,
    })
}

/// Emit the quarantine comment that replaces a killed subtree. Body
/// is `foyer:scrubbed:<tag>:<base64>`. Base64 standard alphabet is
/// `[A-Za-z0-9+/=]` — no `-`, so we can't accidentally produce a
/// `--` sequence that would break the XML comment rule.
fn emit_quarantine_comment(
    writer: &mut Writer<Vec<u8>>,
    tag: &[u8],
    captured: &[u8],
) -> Result<(), ScrubXmlError> {
    let tag_str = std::str::from_utf8(tag).unwrap_or("Unknown");
    // Sanity-check the tag name has no `-` since we'll concatenate
    // it into the comment body. Our KILL_SUBTREES list is hardcoded
    // and dash-free, but if this list ever grows we want a loud
    // failure before we emit a malformed XML comment.
    if tag_str.contains("--") {
        return Err(ScrubXmlError::Malformed(format!(
            "kill-subtree tag `{tag_str}` contains `--` which would corrupt the comment"
        )));
    }
    let encoded = BASE64_STANDARD.encode(captured);
    let body = format!(" {SCRUB_MARKER}{tag_str}:{encoded} ");
    writer
        .write_event(Event::Comment(BytesText::new(&body)))
        .map_err(|err| ScrubXmlError::Malformed(format!("write comment: {err}")))?;
    Ok(())
}

/// Restore quarantined `<Script>` blocks by replacing every
/// `<!-- foyer:scrubbed:<tag>:<base64> -->` comment with the
/// base64-decoded original subtree. Used by the `foyer scrub-restore`
/// CLI subcommand and by tests; intentionally NOT exposed over the
/// HTTP/WS surface — re-introducing scripts from an untrusted source
/// would defeat the whole point of the scrubber.
///
/// Returns the rewritten bytes. Comments that don't match the marker
/// are passed through untouched. Malformed base64 is treated as a
/// hard error: silently dropping the marker would lose data.
pub fn restore_quarantined_xml(input: &[u8]) -> Result<Vec<u8>, ScrubXmlError> {
    let mut reader = Reader::from_reader(input);
    reader.config_mut().trim_text(false);
    let mut writer = Writer::new(Vec::with_capacity(input.len()));
    let mut buf = Vec::new();
    loop {
        let ev = reader
            .read_event_into(&mut buf)
            .map_err(|e| ScrubXmlError::Malformed(format!("parse: {e}")))?;
        match ev {
            Event::Comment(c) => {
                let body = std::str::from_utf8(c.as_ref()).unwrap_or("").trim();
                if let Some(rest) = body.strip_prefix(SCRUB_MARKER) {
                    // body shape after prefix: "<tag>:<base64>"
                    let mut split = rest.splitn(2, ':');
                    let _tag = split.next().unwrap_or("");
                    let b64 = split.next().unwrap_or("");
                    let decoded = BASE64_STANDARD.decode(b64).map_err(|e| {
                        ScrubXmlError::Malformed(format!("scrub-restore: bad base64: {e}"))
                    })?;
                    writer.get_mut().extend_from_slice(&decoded);
                } else {
                    writer
                        .write_event(Event::Comment(c.into_owned()))
                        .map_err(|err| {
                            ScrubXmlError::Malformed(format!("rewrite comment: {err}"))
                        })?;
                }
            }
            Event::Eof => break,
            other => {
                writer
                    .write_event(other)
                    .map_err(|err| ScrubXmlError::Malformed(format!("write through: {err}")))?;
            }
        }
        buf.clear();
    }
    Ok(writer.into_inner())
}

fn validate_path_attrs(name: &[u8], e: &BytesStart<'_>) -> Result<(), ScrubXmlError> {
    let element_name = std::str::from_utf8(name).unwrap_or("?");

    // `<Option>` carries a name+value pair. The `value` attribute is
    // a path only for the names in PATH_OPTION_NAMES.
    if name == b"Option" {
        let mut option_name: Option<String> = None;
        let mut option_value: Option<String> = None;
        for attr_result in e.attributes() {
            let Ok(Attribute { key, value }) = attr_result else {
                continue;
            };
            let key_str = std::str::from_utf8(key.as_ref()).unwrap_or("");
            let value_str = std::str::from_utf8(value.as_ref())
                .unwrap_or("")
                .to_string();
            match key_str {
                "name" => option_name = Some(value_str),
                "value" => option_value = Some(value_str),
                _ => {}
            }
        }
        if let (Some(n), Some(v)) = (&option_name, &option_value) {
            if PATH_OPTION_NAMES.iter().any(|p| *p == n) && !is_clean_path_value(v) {
                return Err(ScrubXmlError::UnsafePath(format!(
                    "<Option name=\"{}\" value=\"{}\"/>",
                    n, v
                )));
            }
        }
        return Ok(());
    }

    // For elements likely to carry filesystem paths, validate any
    // attribute whose key is in PATH_ATTR_NAMES — plus `name` when
    // the element is in PATH_NAME_ELEMENTS (Source-family). The
    // `name=` attribute on Source-flavored elements seeds the actual
    // filesystem lookup path in `FileSource::FileSource`, so leaving
    // it unchecked would let `<Source name="../../../etc/passwd">`
    // resolve outside the session dir on Ardour-side `find()`.
    let validate_name_too = PATH_NAME_ELEMENTS.contains(&name);
    for attr_result in e.attributes() {
        let Ok(Attribute { key, value }) = attr_result else {
            continue;
        };
        let key_bytes = key.as_ref();
        let is_path_attr =
            PATH_ATTR_NAMES.contains(&key_bytes) || (validate_name_too && key_bytes == b"name");
        if !is_path_attr {
            continue;
        }
        let value_str = std::str::from_utf8(value.as_ref()).unwrap_or("");
        if !is_clean_path_value(value_str) {
            return Err(ScrubXmlError::UnsafePath(format!(
                "<{} {}=\"{}\"/>",
                element_name,
                std::str::from_utf8(key_bytes).unwrap_or("?"),
                value_str,
            )));
        }
    }
    Ok(())
}

/// True when the string is either empty, a clean relative path, or a
/// `:`-separated list of clean relative paths. Relative means: no
/// absolute root, no Windows drive letter, no `..` segments,
/// no embedded NULs.
///
/// `audio-search-path` and `midi-search-path` use ':' as the
/// separator (mirrors $PATH conventions); we split on it and check
/// each component independently. A single trailing colon is fine
/// (Ardour allows empty components).
pub(crate) fn is_clean_path_value(v: &str) -> bool {
    if v.is_empty() {
        return true;
    }
    if v.contains('\0') {
        return false;
    }
    for chunk in v.split(':') {
        if chunk.is_empty() {
            continue;
        }
        if !is_clean_relative(chunk) {
            return false;
        }
    }
    true
}

fn is_clean_relative(v: &str) -> bool {
    if v.is_empty() {
        return true;
    }
    // Reject Unix absolute, UNC, and Windows drive letters.
    if v.starts_with('/') || v.starts_with('\\') {
        return false;
    }
    if v.starts_with("\\\\") {
        return false;
    }
    if v.len() >= 2 {
        let bytes = v.as_bytes();
        if bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            return false;
        }
    }
    // Reject any `..` traversal segment. We deliberately don't try
    // to "resolve" the path — a `..` segment in a session XML is
    // never legitimate.
    let path = Path::new(v);
    for c in path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => continue,
            Component::ParentDir => return false,
            // RootDir / Prefix were already caught by the prefix
            // checks above; treat anything else as suspicious.
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &str) -> Result<(String, usize), ScrubXmlError> {
        let r = scrub_xml_bytes(input.as_bytes())?;
        Ok((String::from_utf8(r.bytes).unwrap(), r.scripts_removed))
    }

    #[test]
    fn quarantines_top_level_script() {
        let xml = "<Session><Script name=\"x\">cGF5bG9hZA==</Script><Other/></Session>";
        let (out, n) = run(xml).unwrap();
        assert_eq!(n, 1);
        // The quarantine comment replaces the live element. Ardour's
        // session loader walks Element children only, so the comment
        // is inert at load time.
        assert!(out.contains("<!--"), "expected a comment marker: {out}");
        assert!(out.contains(SCRUB_MARKER), "expected scrub prefix: {out}");
        assert!(
            out.contains("Script:"),
            "expected tag name in marker: {out}"
        );
        // The original <Script> open tag must NOT survive as live XML.
        // We check `<Script ` + `<Script>` patterns rather than the bare
        // word, which is allowed inside the comment payload.
        assert!(!out.contains("<Script "));
        assert!(!out.contains("<Script>"));
        assert!(out.contains("<Other/>"));
    }

    #[test]
    fn restore_round_trips() {
        let xml = "<Session><Script name=\"x\">payload</Script><Other/></Session>";
        let (scrubbed, _) = run(xml).unwrap();
        let restored = restore_quarantined_xml(scrubbed.as_bytes()).unwrap();
        let restored = String::from_utf8(restored).unwrap();
        assert!(restored.contains("<Script name=\"x\">payload</Script>"));
        assert!(restored.contains("<Other/>"));
    }

    #[test]
    fn quarantines_nested_lua_scripts_block() {
        let xml = r#"<Session>
            <LuaScripts>
                <Script name="a">payload1</Script>
                <Script name="b">payload2</Script>
            </LuaScripts>
            <Routes/>
        </Session>"#;
        let (out, n) = run(xml).unwrap();
        // The whole <LuaScripts> wrapper quarantines as one chunk,
        // NOT the two inner <Script>s individually — once we're inside
        // a captured subtree, nested events feed the sidecar without
        // recounting.
        assert_eq!(n, 1);
        assert!(out.contains(SCRUB_MARKER));
        assert!(out.contains("LuaScripts:"));
        // No live LuaScripts/Script tags remain (they only appear
        // inside the base64 payload).
        assert!(!out.contains("<LuaScripts>"));
        assert!(!out.contains("<Script "));
        assert!(out.contains("<Routes/>"));

        // Restoration brings every nested element back verbatim.
        let restored = restore_quarantined_xml(out.as_bytes()).unwrap();
        let restored = String::from_utf8(restored).unwrap();
        assert!(restored.contains("<LuaScripts>"));
        assert!(restored.contains("<Script name=\"a\">payload1</Script>"));
        assert!(restored.contains("<Script name=\"b\">payload2</Script>"));
    }

    #[test]
    fn empty_self_closing_script_quarantined() {
        let xml = r#"<Session><Script name="x"/><Routes/></Session>"#;
        let (out, n) = run(xml).unwrap();
        assert_eq!(n, 1);
        assert!(out.contains(SCRUB_MARKER));
        assert!(!out.contains("<Script "));
        assert!(out.contains("<Routes/>"));

        let restored = restore_quarantined_xml(out.as_bytes()).unwrap();
        let restored = String::from_utf8(restored).unwrap();
        assert!(restored.contains("<Script name=\"x\"/>"));
    }

    #[test]
    fn comment_marker_has_no_double_dash() {
        // XML 1.0 forbids `--` inside any comment body; double-dash
        // would yield malformed output. Base64 alphabet has no `-`,
        // and our marker uses single-dash separators. Belt + braces:
        // verify a real scrubbed payload doesn't sneak `--` in.
        let xml = "<Session><Script>payload</Script></Session>";
        let (out, _) = run(xml).unwrap();
        let comment_start = out.find("<!--").unwrap();
        let comment_end = out.find("-->").unwrap();
        let body = &out[comment_start + 4..comment_end];
        assert!(!body.contains("--"), "comment body has `--`: {body}");
    }

    #[test]
    fn unrelated_comments_pass_through() {
        let xml = "<Session><!-- normal comment --><Routes/></Session>";
        let (out, _) = run(xml).unwrap();
        assert!(out.contains("<!-- normal comment -->"));
    }

    #[test]
    fn preserves_clean_session() {
        let xml = r#"<Session version="7003">
            <Sources>
                <Source name="Take1.wav" id="1" origin=""/>
            </Sources>
            <Routes/>
        </Session>"#;
        let (_, n) = run(xml).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn rejects_absolute_source_origin() {
        let xml = r#"<Session>
            <Sources>
                <Source name="x.wav" origin="/etc/passwd"/>
            </Sources>
        </Session>"#;
        let err = run(xml).unwrap_err();
        assert!(matches!(err, ScrubXmlError::UnsafePath(_)));
    }

    #[test]
    fn rejects_dotdot_source_path() {
        let xml = r#"<Session>
            <Sources>
                <Source name="x.wav" path="../../../etc/foo"/>
            </Sources>
        </Session>"#;
        let err = run(xml).unwrap_err();
        assert!(matches!(err, ScrubXmlError::UnsafePath(_)));
    }

    #[test]
    fn rejects_dotdot_in_source_name() {
        // The Source `name=` attribute seeds `_path = _name` in
        // FileSource::FileSource; without scrubbing, a session with
        // `<Source name="../../../etc/passwd"/>` lets Ardour write
        // a peakfile next to /etc/passwd. Audit finding #1.
        let xml = r#"<Session>
            <Sources>
                <Source name="../../../etc/passwd" id="1" type="audio"/>
            </Sources>
        </Session>"#;
        let err = run(xml).unwrap_err();
        assert!(matches!(err, ScrubXmlError::UnsafePath(_)), "{:?}", err);
    }

    #[test]
    fn allows_normal_filename_in_source_name() {
        // Real Ardour sessions have names like "Take1_Audio 1-1.wav"
        // — alphanum + space + dash is fine, no `..`/absolute.
        let xml = r#"<Session>
            <Sources>
                <Source name="Take1_Audio 1-1.wav" id="1" type="audio"/>
            </Sources>
        </Session>"#;
        run(xml).unwrap();
    }

    #[test]
    fn region_name_is_not_validated_as_path() {
        // <Region name="..."> is a display label, not a filename.
        // Per the audit, only Source-flavored elements seed paths
        // from the name attribute. Don't break user-friendly region
        // names that happen to look weird.
        let xml = r#"<Session>
            <Regions>
                <Region name="../weird display name (cool!)" id="1"/>
            </Regions>
        </Session>"#;
        run(xml).unwrap();
    }

    #[test]
    fn quarantines_videotimeline_block() {
        // <Videotimeline Filename> flows to xjadeo's stdin via
        // SystemExec::write_to_stdin. A newline in the Filename
        // injects extra remote-control commands. Quarantine the
        // whole element so it never reaches the helper at all.
        let xml = "<Session><Videotimeline Filename=\"/v.mp4\nfullscreen on\n\" LocalFile=\"1\"/></Session>";
        let (out, n) = run(xml).unwrap();
        assert_eq!(n, 1);
        assert!(out.contains(SCRUB_MARKER));
        assert!(!out.contains("<Videotimeline"));
    }

    #[test]
    fn rejects_absolute_search_path_option() {
        let xml = r#"<Session>
            <Config>
                <Option name="audio-search-path" value="/home/foo:/etc"/>
            </Config>
        </Session>"#;
        let err = run(xml).unwrap_err();
        assert!(matches!(err, ScrubXmlError::UnsafePath(_)));
    }

    #[test]
    fn allows_empty_search_path_option() {
        let xml = r#"<Session>
            <Config>
                <Option name="audio-search-path" value=""/>
            </Config>
        </Session>"#;
        run(xml).unwrap();
    }

    #[test]
    fn allows_relative_search_path_option() {
        let xml = r#"<Session>
            <Config>
                <Option name="audio-search-path" value="extra:more/here"/>
            </Config>
        </Session>"#;
        run(xml).unwrap();
    }

    #[test]
    fn ignores_unrelated_option_names() {
        // `take-name`, `record-mode`, etc. are not paths even though
        // they show up as <Option name="..." value="..."/>. Make sure
        // we don't accidentally validate every Option as a path.
        let xml = r#"<Session>
            <Config>
                <Option name="record-mode" value="/RecLayered"/>
            </Config>
        </Session>"#;
        run(xml).unwrap();
    }

    #[test]
    fn rejects_windows_drive_path() {
        assert!(!is_clean_path_value("C:\\Users\\foo"));
        assert!(!is_clean_path_value("C:/Users/foo"));
    }

    #[test]
    fn accepts_normal_relative() {
        assert!(is_clean_path_value("Take1.wav"));
        assert!(is_clean_path_value("interchange/asdf/audiofiles/x.wav"));
        assert!(is_clean_path_value("./local"));
    }

    #[test]
    fn rejects_dotdot() {
        assert!(!is_clean_path_value(".."));
        assert!(!is_clean_path_value("../foo"));
        assert!(!is_clean_path_value("a/../b"));
    }

    #[test]
    fn rejects_null_in_path() {
        assert!(!is_clean_path_value("foo\0bar"));
    }

    #[test]
    fn malformed_xml_returns_error() {
        let xml = "<Session><Source unclosed";
        let err = run(xml).unwrap_err();
        assert!(matches!(err, ScrubXmlError::Malformed(_)));
    }

    #[test]
    fn project_walker_deletes_history_and_instant_files() {
        let dir = tempfile::tempdir().unwrap();
        // Layout mirrors a real Ardour project: a clean .ardour
        // alongside the dangerous state files. The walker must
        // delete the latter and leave the rest alone.
        std::fs::write(
            dir.path().join("proj.ardour"),
            "<Session><Routes/></Session>",
        )
        .unwrap();
        std::fs::write(dir.path().join("proj.history"), b"<History/>").unwrap();
        std::fs::write(dir.path().join("proj.history.bak"), b"<History/>").unwrap();
        std::fs::write(dir.path().join("instant.xml"), b"<Editor/>").unwrap();
        std::fs::write(dir.path().join("instant.xml.bak"), b"<Editor/>").unwrap();

        let report = scrub_project_dir(dir.path()).unwrap();
        assert_eq!(report.files_scrubbed, 1);
        assert_eq!(report.files_deleted, 4);

        assert!(dir.path().join("proj.ardour").exists());
        assert!(!dir.path().join("proj.history").exists());
        assert!(!dir.path().join("proj.history.bak").exists());
        assert!(!dir.path().join("instant.xml").exists());
        assert!(!dir.path().join("instant.xml.bak").exists());
    }
}
