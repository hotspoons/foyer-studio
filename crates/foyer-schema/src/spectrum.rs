//! Real-time spectrogram + FFT analysis.
//!
//! The shim runs FFTs on the audio buffers it can tap (master, monitor,
//! any track or bus, individual ports). Foyer subscribes to a *channel*
//! and receives a stream of [`SpectrumFrame`]s — one per analysis hop —
//! that clients render either as an instantaneous bar plot (most recent
//! frame) or as a scrolling waterfall (the temporal stack of recent
//! frames).
//!
//! Wire shape is intentionally compact: we ship pre-binned magnitude
//! values in dBFS rather than full complex FFT output. Browser-side viz
//! never needs phase, and dB-binned data compresses well over Opus-less
//! control plane transport. Per-channel magnitudes (stereo / 5.1 / etc.)
//! ride alongside in `channels` so a stereo source can render L/R as two
//! overlaid traces without a second subscription.
//!
//! Bin layout: linear in Hz from 0 to Nyquist (sample_rate/2). The
//! caller can re-bin to log for display — keep the wire layout
//! straightforward so future scopes (cross-correlation, coherence
//! plots) can reuse the same numbers.

use serde::{Deserialize, Serialize};

use crate::EntityId;

/// One scope of analysis. Mirrors `AudioSource` in spirit but tighter —
/// we only support the surfaces a DAW actually exposes as analysable
/// audio buses. (Ports are deliberately omitted: per-port FFT is rare
/// and the per-track variant already covers the "this track only" case
/// via the track's outputs.)
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpectrumTarget {
    /// Final stereo mix at the master bus output. Most-common "what does
    /// my master sound like" view.
    Master,
    /// Monitor / control-room bus. Identical taps to `Master` on hosts
    /// without a separate monitor section — Ardour follows the
    /// monitor's outputs.
    Monitor,
    /// A specific track or bus by id. The shim taps the track's
    /// post-fader output (post-plugin, post-trim) so the spectrum
    /// reflects what the listener actually hears, not the raw input.
    Track { id: EntityId },
}

impl SpectrumTarget {
    /// Stable text id for logging / WS routing. Doesn't replace serde
    /// — this is for human-facing breadcrumbs.
    pub fn slug(&self) -> String {
        match self {
            SpectrumTarget::Master => "master".to_string(),
            SpectrumTarget::Monitor => "monitor".to_string(),
            SpectrumTarget::Track { id } => format!("track.{}", id.as_str()),
        }
    }
}

/// Window function applied before the FFT. Affects bin leakage; the
/// browser can request a specific one when it cares (most users let
/// the shim pick the default).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SpectrumWindow {
    /// Hann window — good general-purpose default. Smooth roll-off,
    /// reasonable sidelobe suppression. (What the shim picks when the
    /// caller doesn't specify.)
    #[default]
    Hann,
    /// Hamming window — slightly higher frequency resolution than Hann
    /// at the cost of poorer sidelobe rejection. Some users prefer it
    /// for tonal content.
    Hamming,
    /// Blackman-Harris 4-term — much lower sidelobes, useful for
    /// dynamic-range-critical work (e.g. spotting a low-level tone
    /// next to a loud one).
    BlackmanHarris,
    /// Rectangular window (i.e. no window). Maximum frequency
    /// resolution but heavy leakage. Mostly here for didactic purposes
    /// — users rarely want this.
    Rectangular,
}

/// Subscription options the client passes to `subscribe_spectrum`.
/// All fields have safe server-side defaults so an empty
/// `SpectrumOpts::default()` is a usable request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpectrumOpts {
    /// FFT size in samples. Power of two; sane range 256..=16384. The
    /// shim clamps if out of range. Larger = better frequency
    /// resolution + slower update rate.
    #[serde(default = "default_fft_size")]
    pub fft_size: u32,
    /// Hop size in samples between successive FFT frames. Defaults to
    /// `fft_size / 2` (50% overlap) — a good balance of latency and
    /// time resolution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hop_size: Option<u32>,
    /// Window function.
    #[serde(default)]
    pub window: SpectrumWindow,
    /// Floor of the magnitude scale, in dBFS. Values below this are
    /// clamped to it. Useful when the client wants to compress the
    /// dynamic range for display (e.g. -80 instead of -120).
    #[serde(default = "default_min_db")]
    pub min_db: f32,
    /// Maximum number of bins to emit, evenly spaced from 0..Nyquist.
    /// `None` → `fft_size / 2`. Setting this lower trades resolution
    /// for bandwidth; common pick is 256 for a slim bar plot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bins: Option<u32>,
    /// Whether to deliver per-channel magnitudes (`true`, default) or
    /// fold to mono before FFT (`false`, cheaper to transmit).
    #[serde(default = "default_true")]
    pub per_channel: bool,
}

impl Default for SpectrumOpts {
    fn default() -> Self {
        Self {
            fft_size: default_fft_size(),
            hop_size: None,
            window: SpectrumWindow::default(),
            min_db: default_min_db(),
            max_bins: None,
            per_channel: true,
        }
    }
}

fn default_fft_size() -> u32 {
    2048
}
fn default_min_db() -> f32 {
    -100.0
}
fn default_true() -> bool {
    true
}

/// One channel's magnitude bins for the current analysis frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpectrumChannel {
    /// 0 = left / mono, 1 = right, etc. Matches the source's channel
    /// layout (the shim doesn't reorder).
    pub channel: u16,
    /// Per-bin magnitude in dBFS. `min_db..0.0`. Length equals
    /// `SpectrumFrame::bins`.
    pub magnitudes_db: Vec<f32>,
}

/// One FFT frame ready for display.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpectrumFrame {
    /// Echo of the subscription's target so a single client can
    /// multiplex multiple subscriptions on one WS connection.
    pub target: SpectrumTarget,
    /// Bin count. Equal across every `SpectrumChannel.magnitudes_db`.
    pub bins: u32,
    /// Source sample rate. Combined with `bins` lets the renderer
    /// compute Hz per bin: `(sample_rate/2) / bins`.
    pub sample_rate: u32,
    /// Window the shim actually used (echoed back; the request may
    /// have been clamped).
    pub window: SpectrumWindow,
    /// Floor used by the magnitudes. Echoed so the client doesn't
    /// have to remember its own subscription opts.
    pub min_db: f32,
    /// Per-channel magnitudes. At least one entry.
    pub channels: Vec<SpectrumChannel>,
    /// Shim's monotonic-ns timestamp at frame end. Lets clients
    /// compute the frame's age + correlate with transport position.
    pub server_mono_ns: u64,
}

/// Sidecar capability advertisement (returned in `ClientGreeting.features`
/// or queried via `Session.spectrum_capabilities`). Lets the FE know
/// whether the host can stream spectra and what FFT sizes are honoured.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpectrumCapabilities {
    /// True when the backend can deliver real spectrum frames. False on
    /// hosts where the shim hasn't shipped the FFT pipeline yet — the
    /// FE then hides the spectrogram UI.
    pub available: bool,
    /// Allowed FFT sizes, sorted ascending. `[]` when `available=false`.
    pub fft_sizes: Vec<u32>,
    /// Allowed window functions.
    pub windows: Vec<SpectrumWindow>,
    /// Max frame rate the shim will deliver (frames per second). The
    /// FE can sanity-check its display interval against this.
    pub max_frame_rate_hz: u32,
}

impl SpectrumCapabilities {
    /// Best-effort default for stub backends + hosts that haven't
    /// shipped the FFT pipeline. `available=true` because the stub
    /// synthesises convincing fake spectra for demos.
    pub fn stub() -> Self {
        Self {
            available: true,
            fft_sizes: vec![512, 1024, 2048, 4096, 8192],
            windows: vec![
                SpectrumWindow::Hann,
                SpectrumWindow::Hamming,
                SpectrumWindow::BlackmanHarris,
                SpectrumWindow::Rectangular,
            ],
            max_frame_rate_hz: 60,
        }
    }

    /// Marker for backends with no FFT pipeline. The FE hides the
    /// spectrogram surfaces when it sees this.
    pub fn unavailable() -> Self {
        Self {
            available: false,
            fft_sizes: vec![],
            windows: vec![],
            max_frame_rate_hz: 0,
        }
    }
}
