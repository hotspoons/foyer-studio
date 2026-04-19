//! Low-level framing types.

use thiserror::Error;

/// Byte-tag that precedes every frame payload.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    /// MessagePack-encoded [`Envelope<Control>`].
    Control = 0x01,
    /// Interleaved PCM audio frame carrying `[stream_id u32 LE][pcm bytes]`.
    Audio = 0x02,
}

impl FrameKind {
    pub fn from_u8(b: u8) -> Option<Self> {
        match b {
            0x01 => Some(Self::Control),
            0x02 => Some(Self::Audio),
            _ => None,
        }
    }
}

/// Sanity ceiling on a single payload length. Frames larger than this are rejected —
/// prevents a malformed `len` from triggering gigabyte allocations.
pub const MAX_PAYLOAD: u32 = 16 * 1024 * 1024;

/// A raw framed payload as it appears on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: FrameKind,
    pub payload: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("unknown frame kind byte 0x{0:02x}")]
    UnknownKind(u8),
    #[error("frame payload length {0} exceeds MAX_PAYLOAD ({1})")]
    TooLarge(u32, u32),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}
