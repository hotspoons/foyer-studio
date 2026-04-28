// SPDX-License-Identifier: Apache-2.0
//! Wire protocol between a Foyer shim (running inside the host DAW) and the Rust
//! sidecar process.
//!
//! Transport is a byte-stream (typically a Unix domain socket) carrying length-prefixed
//! MessagePack-encoded [`Frame`]s. Binary audio payloads are first-class frames rather
//! than being squeezed through the MessagePack envelope, so the hot path stays tight
//! and the audio thread can produce frames without encode overhead.
//!
//! Framing:
//! ```text
//!   ┌──────────┬──────────┬──────────┐
//!   │ kind: u8 │ len: u32 │ payload  │
//!   └──────────┴──────────┴──────────┘
//! ```
//! - `kind = 0x01` — MessagePack-encoded [`Envelope<Control>`] (schema events/commands).
//! - `kind = 0x02` — audio frame: `[stream_id: u32 LE][payload bytes]` where the
//!   payload is raw interleaved PCM in the format established via `AudioEgressOffer`
//!   / `AudioIngressOpen`.
//! - `len` is the payload byte length, big-endian u32.
//! - Max frame length is enforced at [`MAX_PAYLOAD`] to avoid memory blowups on bad
//!   peers.
//!
//! Higher-level wrappers (shim server, sidecar client) live in their respective
//! crates and use [`FrameCodec`] for framing and [`codec::encode_control`] /
//! [`codec::decode_control`] for the MessagePack side.

#![forbid(unsafe_code)]

pub mod codec;
pub mod frame;

pub use codec::{decode_control, encode_control, read_frame, write_frame};
pub use frame::{Frame, FrameKind, MAX_PAYLOAD};

/// Re-export of the schema types used on the wire, for convenience.
pub use foyer_schema::{Command, Envelope, Event};

/// Shim-to-sidecar and sidecar-to-shim messages share a single control envelope with
/// the two polymorphic payloads collapsed into one enum. Keeping a single wire type
/// simplifies framing: both directions look identical to the codec.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "dir", rename_all = "snake_case")]
pub enum Control {
    /// From sidecar to shim — a request that should be acted upon.
    Command(Command),
    /// From shim to sidecar — an observation about host state.
    Event(Event),
}
