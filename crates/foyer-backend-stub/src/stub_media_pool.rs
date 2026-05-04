//! Per-session disk pool for the stub backend: HTTP import lands files under
//! `<jail>/.foyer-stub-media/<session_id>/` so `list_audio_pool` can enumerate
//! them without a DAW.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use foyer_schema::{AudioPoolSource, EntityId};

const STUB_MEDIA_SUBDIR: &str = ".foyer-stub-media";

pub(crate) fn pool_dir_abs(jail_root: &Path, session_id: &EntityId) -> PathBuf {
    jail_root
        .join(STUB_MEDIA_SUBDIR)
        .join(sanitize_session_dir(session_id.as_str()))
}

fn sanitize_session_dir(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' | '\\' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect()
}

fn source_id_for_path(path: &Path) -> EntityId {
    let mut h = DefaultHasher::new();
    path.to_string_lossy().hash(&mut h);
    EntityId::new(format!("stub.pool.{:016x}", h.finish()))
}

fn is_pool_audio_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let ext = Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    matches!(
        ext,
        "wav" | "wave" | "flac" | "aif" | "aiff" | "ogg" | "oga"
    )
}

/// Build wire paths relative to `jail_root` (forward slashes, no leading slash).
pub(crate) fn list_stub_pool_entries(
    pool_dir: &Path,
    jail_root: &Path,
    fallback_sample_rate: u32,
) -> Result<Vec<AudioPoolSource>, String> {
    if !pool_dir.is_dir() {
        return Ok(Vec::new());
    }

    let rd = fs::read_dir(pool_dir).map_err(|e| e.to_string())?;

    let jail_root = jail_root
        .canonicalize()
        .map_err(|e| format!("jail root: {e}"))?;

    let mut out = Vec::new();
    for dent in rd.flatten() {
        if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = dent.file_name().to_string_lossy().into_owned();
        if !is_pool_audio_name(&name) {
            continue;
        }
        let abs = dent.path();
        let (sample_rate, length_samples) = probe_audio_meta(&abs, fallback_sample_rate);
        let wire_rel = abs
            .canonicalize()
            .ok()
            .and_then(|c| c.strip_prefix(&jail_root).ok().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| abs.clone());
        let path_str = wire_rel.to_string_lossy().replace('\\', "/");
        out.push(AudioPoolSource {
            id: source_id_for_path(&abs),
            name: Path::new(&name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&name)
                .to_string(),
            path: path_str,
            channel: 0,
            length_samples,
            sample_rate,
        });
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn probe_audio_meta(path: &Path, fallback_sr: u32) -> (u32, u64) {
    if let Some((sr, len)) = probe_wav(path) {
        return (sr, len);
    }
    if let Some((sr, len)) = probe_aiff(path) {
        let sr = if sr == 0 { fallback_sr } else { sr };
        return (sr, len);
    }
    (fallback_sr, 0)
}

fn probe_wav(path: &Path) -> Option<(u32, u64)> {
    let mut f = fs::File::open(path).ok()?;
    let mut h = [0u8; 12];
    f.read_exact(&mut h).ok()?;
    if &h[0..4] != b"RIFF" || &h[8..12] != b"WAVE" {
        return None;
    }

    let mut sample_rate = None;
    let mut channels = None;
    let mut bits = None;
    let mut data_size = None;

    loop {
        let mut id = [0u8; 4];
        if f.read_exact(&mut id).is_err() {
            break;
        }
        let mut sz_buf = [0u8; 4];
        f.read_exact(&mut sz_buf).ok()?;
        let size = i64::from(u32::from_le_bytes(sz_buf));
        if size < 0 {
            break;
        }
        let id_s = std::str::from_utf8(&id).ok()?;

        if id_s == "fmt " {
            let to_read = (size as usize).min(256);
            if to_read < 16 {
                f.seek(SeekFrom::Current(size)).ok()?;
                continue;
            }
            let mut buf = vec![0u8; to_read];
            f.read_exact(&mut buf).ok()?;
            let ch = u16::from_le_bytes([buf[2], buf[3]]);
            let sr = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
            let bps = u16::from_le_bytes([buf[14], buf[15]]);
            channels = Some(ch.max(1));
            sample_rate = Some(sr);
            bits = Some(bps);
            if size > to_read as i64 {
                f.seek(SeekFrom::Current(size - to_read as i64)).ok()?;
            }
        } else if id_s == "data" {
            data_size = Some(size as u64);
            break;
        } else {
            let pad = size & 1;
            f.seek(SeekFrom::Current(size + pad)).ok()?;
        }

        if sample_rate.is_some() && data_size.is_some() {
            break;
        }
    }

    let sr = sample_rate?;
    let ch = channels?.max(1) as u64;
    let bps = u64::from(bits?.max(8));
    let ds = data_size?;
    let frame_bytes = ch * (bps / 8);
    if frame_bytes == 0 {
        return None;
    }
    let frames = ds / frame_bytes;
    Some((sr, frames))
}

fn probe_aiff(path: &Path) -> Option<(u32, u64)> {
    let mut f = fs::File::open(path).ok()?;
    let mut hhead = [0u8; 12];
    f.read_exact(&mut hhead).ok()?;
    if &hhead[0..4] != b"FORM" {
        return None;
    }
    if &hhead[8..12] != b"AIFF" && &hhead[8..12] != b"AIFC" {
        return None;
    }

    let mut num_frames: Option<u64> = None;
    let mut sample_rate: Option<u32> = None;

    loop {
        let mut id = [0u8; 4];
        if f.read_exact(&mut id).is_err() {
            break;
        }
        let mut sz_buf = [0u8; 4];
        f.read_exact(&mut sz_buf).ok()?;
        let size = i64::from(u32::from_be_bytes(sz_buf));
        if size < 0 {
            break;
        }
        let id_s = std::str::from_utf8(&id).ok()?;

        if id_s == "COMM" {
            let need = 18usize;
            let to_read = (size as usize).min(256).max(need);
            let mut buf = vec![0u8; to_read];
            f.read_exact(&mut buf).ok()?;
            if buf.len() < need {
                return None;
            }
            let frames = u32::from_be_bytes([buf[2], buf[3], buf[4], buf[5]]);
            let sr = ieee_extended_to_f64(&buf[8..18]).max(0.0) as u32;
            num_frames = Some(u64::from(frames));
            sample_rate = Some(sr);
            if size > to_read as i64 {
                f.seek(SeekFrom::Current(size - to_read as i64)).ok()?;
            }
        } else {
            let pad = size & 1;
            f.seek(SeekFrom::Current(size + pad)).ok()?;
        }

        if num_frames.is_some() {
            break;
        }
    }

    let frames = num_frames?;
    let sr = sample_rate.unwrap_or(0);
    Some((sr, frames))
}

/// AIFF 80-bit SANE extended (libsndfile-style).
fn ieee_extended_to_f64(s: &[u8]) -> f64 {
    if s.len() < 10 {
        return 0.0;
    }
    let expon = ((s[0] as u32) << 8) | (s[1] as u32);
    let hi = u32::from_be_bytes([s[2], s[3], s[4], s[5]]);
    let lo = u32::from_be_bytes([s[6], s[7], s[8], s[9]]);

    if expon == 0 && hi == 0 && lo == 0 {
        return 0.0;
    }

    let sign = expon & 0x8000;
    let mut exp = ((expon & 0x7fff) as i32) - 16383 - 31;
    let fhi = hi | 0x8000_0000u32;

    let mut f = fhi as f64 * 2_f64.powi(exp);
    exp -= 32;
    f += lo as f64 * 2_f64.powi(exp);

    if sign != 0 {
        -f
    } else {
        f
    }
}
