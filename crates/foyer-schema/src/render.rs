//! Session render / mixdown / bounce-to-disk.
//!
//! A "render" reads the session's mixed output (or a sub-range / a
//! single track / a stem set) and writes it to an audio file in a
//! format the operator picks — WAV for archival, FLAC for lossless
//! compression, Ogg Vorbis / Ogg Opus / MP3 for shipping a preview.
//!
//! The backend advertises which formats it can encode via
//! [`RenderCapabilities`] on the session snapshot. The UI shows only
//! the formats the backend offered; the agent tool likewise refuses to
//! request a format outside the advertised set.
//!
//! Wire flow:
//!
//! ```text
//! client → Command::RenderSession { handle, opts }
//! server → Event::RenderStarted { handle }            (echo / ack)
//! server → Event::RenderProgress { handle, percent }  (0..=100, repeated)
//! server → Event::RenderComplete { handle, output }   (final)
//!     OR
//! server → Event::RenderError    { handle, message }  (final on failure)
//! ```
//!
//! The client picks `handle` (a uuid string) so concurrent renders
//! coming back over the broadcast stream can be demultiplexed without
//! a separate subscribe channel.

use serde::{Deserialize, Serialize};

use crate::EntityId;

/// One encoder the backend can target. `id` is the wire token the
/// client sends back on [`RenderOptions::format_id`]; everything else
/// is metadata for the picker UI / tool schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderFormat {
    /// Stable id (e.g. `"wav"`, `"flac"`, `"ogg_vorbis"`, `"mp3"`).
    pub id: String,
    /// Human label for the picker (e.g. `"WAV (PCM)"`, `"FLAC"`).
    pub label: String,
    /// Default file extension, no leading dot (`"wav"`, `"flac"`,
    /// `"ogg"`, `"mp3"`). Used to name the output when the caller
    /// didn't supply one.
    pub extension: String,
    /// MIME type for the encoded bytes (`"audio/wav"`,
    /// `"audio/flac"`, `"audio/ogg"`, `"audio/mpeg"`). Drives the
    /// agent-tool attachment header + browser download Content-Type.
    pub mime: String,
    /// Whether the codec discards bits to shrink the file. The UI
    /// uses this to gate the "quality" slider — lossless formats
    /// just show the bit depth.
    pub lossy: bool,
}

/// Selection of *what* to render. `Master` is the obvious default
/// (final stereo mix); `Tracks` writes a stem set, one file per track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RenderTarget {
    /// Master bus output — the standard "render the song" path.
    #[default]
    Master,
    /// Per-track stems. One audio file per id in `ids`. Empty list
    /// is an error (caller asked for stems but supplied no tracks).
    Tracks { ids: Vec<EntityId> },
}

/// Time range to render. `Session` covers the full session length
/// (start to last region's tail); `Range` is the caller's chosen
/// window; `Loop` honors the session's current loop range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RenderRange {
    /// Start (sample 0) to the end of the last region on the timeline.
    /// The DAW figures out the end-of-session position; the caller
    /// doesn't have to compute it.
    #[default]
    Session,
    /// Caller-supplied window.
    Range {
        start_samples: u64,
        end_samples: u64,
    },
    /// Use the session's currently-active loop range. Errors when no
    /// loop is set.
    Loop,
}

/// All the knobs the renderer accepts. Defaults aim at "what most
/// users want for a quick mixdown" — stereo WAV at session rate,
/// 24-bit, master bus, full session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderOptions {
    /// Encoder id from [`RenderCapabilities::formats`]. Default
    /// `"wav"` — every backend that supports render at all supports
    /// uncompressed WAV.
    #[serde(default = "default_format_id")]
    pub format_id: String,
    /// Sample rate of the output file in Hz. `None` = use the
    /// session's native sample rate (no resample). The backend may
    /// reject unsupported rates with `RenderError`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
    /// Quantization width of each PCM sample. Honored by lossless
    /// formats (WAV / FLAC); ignored by lossy formats which use
    /// `quality` instead. `None` = backend default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<RenderBitDepth>,
    /// Number of output channels. `None` = backend default (usually
    /// 2 for stereo). Pass `1` for a forced mono mixdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channels: Option<u8>,
    /// Quality factor for lossy encoders, 0..=10 in Vorbis/Opus
    /// convention. `None` = backend default. Ignored by lossless
    /// formats.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<u8>,
    #[serde(default)]
    pub target: RenderTarget,
    #[serde(default)]
    pub range: RenderRange,
    /// Apply the session's master fades / dither to the output.
    /// Default `true` — matches the "Render to file" expectation
    /// users have from Ardour / Logic / Reaper.
    #[serde(default = "default_true")]
    pub normalize_to_master: bool,
    /// When set, write the output to this jail-relative path. When
    /// `None`, the backend chooses a sibling of the project file
    /// (e.g. `<session>/exports/<timestamp>.<ext>`) and reports the
    /// path on `RenderComplete`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    /// When `true`, the server attaches the rendered audio bytes to
    /// `RenderComplete` as base64 in addition to the file path. The
    /// agent tool sets this so it can hand the bytes back as a
    /// message attachment without an extra fetch round-trip. The UI
    /// dialog leaves it `false` and downloads the file through the
    /// existing artifact endpoint.
    #[serde(default)]
    pub inline_bytes: bool,
}

fn default_format_id() -> String {
    "wav".to_string()
}
fn default_true() -> bool {
    true
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            format_id: default_format_id(),
            sample_rate: None,
            bit_depth: None,
            channels: None,
            quality: None,
            target: RenderTarget::default(),
            range: RenderRange::default(),
            normalize_to_master: true,
            target_path: None,
            inline_bytes: false,
        }
    }
}

/// PCM sample width. Mirrors what every DAW exposes — 32-bit float
/// is the "no quantization error" archival choice; 24-bit PCM is the
/// release-master default; 16-bit is CD-style / size-conscious.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderBitDepth {
    Int16,
    Int24,
    Int32,
    Float32,
}

/// What the backend can do. Empty `formats` means "render is not
/// supported at all" — UI hides the menu entry, agent tool refuses
/// to dispatch. Surface this on the session snapshot so the FE can
/// gate the entry point without a probe round-trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderCapabilities {
    /// Encoders the backend can produce, in preferred display order.
    /// First entry is the "obvious default" the UI pre-selects.
    pub formats: Vec<RenderFormat>,
    /// Sample rates the backend will accept on
    /// [`RenderOptions::sample_rate`]. Empty = caller must pass
    /// `None` (use session rate); a non-empty list is the closed
    /// set of valid choices.
    #[serde(default)]
    pub sample_rates: Vec<u32>,
    /// Bit depths the backend honors. Empty = backend default only.
    #[serde(default)]
    pub bit_depths: Vec<RenderBitDepth>,
    /// Max channel count the backend will write. `2` for the common
    /// stereo case; higher for surround-capable backends.
    pub max_channels: u8,
    /// `true` when the backend can render arbitrary sub-ranges /
    /// loop ranges. `false` = caller must use `RenderRange::Session`.
    pub supports_range: bool,
    /// `true` when the backend can render per-track stems
    /// ([`RenderTarget::Tracks`]). `false` = caller must use
    /// `RenderTarget::Master`.
    pub supports_stems: bool,
}

impl Default for RenderCapabilities {
    fn default() -> Self {
        Self {
            formats: Vec::new(),
            sample_rates: Vec::new(),
            bit_depths: Vec::new(),
            max_channels: 2,
            supports_range: false,
            supports_stems: false,
        }
    }
}

/// One output file produced by a render run. `Master` renders emit
/// exactly one of these on `RenderComplete`; stem renders emit one
/// per track in `RenderTarget::Tracks::ids`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderOutput {
    /// Jail-relative path the backend wrote. UI offers a download
    /// link; the agent tool reads the bytes back through this path.
    pub path: String,
    /// Encoded size on disk. Lets the UI show a "12.4 MB" hint and
    /// the agent tool decide whether to inline the bytes.
    pub size_bytes: u64,
    /// Format id this file was written in. Matches the `format_id`
    /// the caller asked for unless the backend transcoded (rare).
    pub format_id: String,
    /// MIME type so the FE / agent tool doesn't have to lookup
    /// extension → MIME on its own.
    pub mime: String,
    /// For stem renders, the track this output belongs to. `None`
    /// on master-bus renders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_id: Option<EntityId>,
    /// Base64-encoded audio bytes, populated only when the caller
    /// set [`RenderOptions::inline_bytes`]. Lets the agent tool
    /// attach the file to a message without a follow-up fetch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_b64: Option<String>,
}
