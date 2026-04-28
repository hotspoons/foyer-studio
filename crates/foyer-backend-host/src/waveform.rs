//! Symphonia-backed peak decoder.
//!
//! Reads the source file at `path`, skips forward by `start_samples`, then
//! folds the next `length_samples` source samples into `(min, max)` pairs per
//! bucket at `samples_per_peak` resolution. Output shape matches the wire
//! schema exactly — interleaved min/max per-bucket in f32 units clipped to
//! [-1.0, 1.0].
//!
//! Down-mix strategy: sum all channels to mono, divide by channel count.
//! It's the simplest thing that produces a readable waveform; a stereo-aware
//! renderer can come later if the single-track view grows teeth.
//!
//! EOF handling: symphonia surfaces "out of data" as
//! `SymphError::IoError(UnexpectedEof)`. We stop the loop cleanly instead
//! of propagating, since partial reads are expected at the tail of a region
//! whose source is shorter than declared.

use std::fs::File;
use std::path::Path;

use foyer_backend::BackendError;
use foyer_schema::{EntityId, WaveformPeaks};
use symphonia::core::audio::{AudioBufferRef, SampleBuffer};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Cap the number of buckets we emit. Very long regions at tight zoom can
/// produce absurd bucket counts; this bound keeps memory reasonable while
/// still letting a 30-second region decode down to ~4 samples/peak. A
/// 1-hour region at samples_per_peak=8 would exceed this — the extra
/// clamping below falls back to a slightly coarser effective_spp.
///
/// Payload size: `MAX_BUCKETS * 2 * 4` bytes ≈ 2 MB of f32 min/max pairs
/// at the cap. The browser gets that over WS binary/JSON once per
/// (region, tier), then draws from its own canvas-sized buffer.
const MAX_BUCKETS: u32 = 262_144;

pub fn decode_peaks(
    path: &Path,
    region_id: EntityId,
    samples_per_peak: u32,
    start_samples: u64,
    length_samples: u64,
) -> Result<WaveformPeaks, BackendError> {
    if samples_per_peak == 0 || length_samples == 0 {
        return Err(BackendError::Other(
            "decode_peaks: zero samples_per_peak or length_samples".into(),
        ));
    }

    let file = File::open(path).map_err(|e| BackendError::Other(format!("open {path:?}: {e}")))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    // `Hint` accelerates format detection when the extension is known —
    // otherwise symphonia has to fingerprint the stream by reading bytes.
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| BackendError::Other(format!("probe: {e}")))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| BackendError::Other("no decodable audio track".into()))?;

    let track_id = track.id;
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(1)
        .max(1) as u32;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| BackendError::Other(format!("decoder init: {e}")))?;

    // Plan the output shape.
    let raw_buckets = length_samples.div_ceil(samples_per_peak as u64);
    let bucket_count = raw_buckets.min(MAX_BUCKETS as u64) as u32;
    // If we clamped, scale the bucket window so we still cover the whole
    // region rather than just the first MAX_BUCKETS * samples_per_peak.
    let effective_spp: u64 = if raw_buckets > MAX_BUCKETS as u64 {
        length_samples.div_ceil(bucket_count as u64)
    } else {
        samples_per_peak as u64
    };

    let mut peaks = vec![0.0f32; (bucket_count as usize) * 2];
    // Per-bucket running min/max. Initialized lazily below so we don't
    // produce false "silence at start" buckets when the region begins past
    // the 0th source sample.
    let mut bucket_min: Vec<f32> = vec![f32::INFINITY; bucket_count as usize];
    let mut bucket_max: Vec<f32> = vec![f32::NEG_INFINITY; bucket_count as usize];

    // State machine: advance a running "source-sample index" as we decode.
    // Samples before `start_samples` are skipped entirely; samples past
    // `start_samples + length_samples` break the loop.
    let skip_end = start_samples.saturating_add(length_samples);
    let mut source_idx: u64 = 0; // in source frames (not samples-per-channel)

    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    'decode_loop: loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(BackendError::Other(format!("next_packet: {e}"))),
        };
        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphError::DecodeError(_)) => continue, // skip corrupt packet
            Err(SymphError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(BackendError::Other(format!("decode: {e}"))),
        };

        // Lazily allocate an interleaved f32 sample buffer sized to the
        // first packet — symphonia's capacity is the max frames per packet.
        if sample_buf.is_none() {
            let spec = *decoded.spec();
            let duration = audio_buffer_capacity(&decoded);
            sample_buf = Some(SampleBuffer::<f32>::new(duration, spec));
        }
        let buf = sample_buf.as_mut().unwrap();
        buf.copy_interleaved_ref(decoded);
        let samples = buf.samples();
        let frames = samples.len() / channels as usize;

        for f in 0..frames {
            let abs_idx = source_idx + f as u64;
            if abs_idx < start_samples {
                continue;
            }
            if abs_idx >= skip_end {
                break 'decode_loop;
            }
            // Down-mix to mono by averaging channels.
            let mut sum = 0.0f32;
            for c in 0..channels as usize {
                sum += samples[f * channels as usize + c];
            }
            let v = (sum / channels as f32).clamp(-1.0, 1.0);

            let rel = abs_idx - start_samples;
            let bucket = (rel / effective_spp).min(bucket_count as u64 - 1) as usize;
            let lo = &mut bucket_min[bucket];
            let hi = &mut bucket_max[bucket];
            if v < *lo {
                *lo = v;
            }
            if v > *hi {
                *hi = v;
            }
        }
        source_idx += frames as u64;
    }

    // Flatten to interleaved min/max; replace never-visited buckets with
    // plain zeros (rather than ±inf) so the client draws a flat line.
    for i in 0..bucket_count as usize {
        let (lo, hi) = if bucket_min[i].is_finite() && bucket_max[i].is_finite() {
            (bucket_min[i], bucket_max[i])
        } else {
            (0.0, 0.0)
        };
        peaks[i * 2] = lo;
        peaks[i * 2 + 1] = hi;
    }

    Ok(WaveformPeaks {
        region_id,
        channels: 1,
        samples_per_peak,
        peaks,
        bucket_count,
    })
}

// AudioBufferRef doesn't expose a single `capacity()` method — we have to
// match on the variant to get it. Every variant wraps an `AudioBuffer<T>`
// that does expose `capacity()`.
fn audio_buffer_capacity(buf: &AudioBufferRef<'_>) -> u64 {
    match buf {
        AudioBufferRef::U8(b) => b.capacity() as u64,
        AudioBufferRef::U16(b) => b.capacity() as u64,
        AudioBufferRef::U24(b) => b.capacity() as u64,
        AudioBufferRef::U32(b) => b.capacity() as u64,
        AudioBufferRef::S8(b) => b.capacity() as u64,
        AudioBufferRef::S16(b) => b.capacity() as u64,
        AudioBufferRef::S24(b) => b.capacity() as u64,
        AudioBufferRef::S32(b) => b.capacity() as u64,
        AudioBufferRef::F32(b) => b.capacity() as u64,
        AudioBufferRef::F64(b) => b.capacity() as u64,
    }
}
