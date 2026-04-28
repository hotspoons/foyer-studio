//! Codec helpers: async read/write of [`Frame`]s over any `AsyncRead`/`AsyncWrite`,
//! plus MessagePack (de)serialization for the control envelope.

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::frame::{Frame, FrameError, FrameKind, MAX_PAYLOAD};
use crate::Control;
use foyer_schema::Envelope;

/// Read a single frame from `r`. Returns `Ok(None)` on a clean EOF at a frame boundary.
pub async fn read_frame<R>(r: &mut R) -> Result<Option<Frame>, FrameError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut header = [0u8; 5];
    match r.read_exact(&mut header).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let kind = FrameKind::from_u8(header[0]).ok_or(FrameError::UnknownKind(header[0]))?;
    let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);
    if len > MAX_PAYLOAD {
        return Err(FrameError::TooLarge(len, MAX_PAYLOAD));
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload).await?;
    Ok(Some(Frame { kind, payload }))
}

/// Write a single frame to `w`.
pub async fn write_frame<W>(w: &mut W, frame: &Frame) -> Result<(), FrameError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let len = u32::try_from(frame.payload.len())
        .map_err(|_| FrameError::TooLarge(u32::MAX, MAX_PAYLOAD))?;
    if len > MAX_PAYLOAD {
        return Err(FrameError::TooLarge(len, MAX_PAYLOAD));
    }
    let mut header = [0u8; 5];
    header[0] = frame.kind as u8;
    header[1..5].copy_from_slice(&len.to_be_bytes());
    w.write_all(&header).await?;
    w.write_all(&frame.payload).await?;
    Ok(())
}

/// MessagePack-encode a control envelope. Infallible in practice for well-formed types.
pub fn encode_control(env: &Envelope<Control>) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    rmp_serde::to_vec_named(env)
}

pub fn decode_control(buf: &[u8]) -> Result<Envelope<Control>, rmp_serde::decode::Error> {
    rmp_serde::from_slice(buf)
}

/// Pack an audio PCM payload into the inner audio-frame body layout
/// (`[stream_id u32 LE][pcm bytes]`).
pub fn pack_audio(stream_id: u32, pcm: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + pcm.len());
    out.extend_from_slice(&stream_id.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// Unpack an audio-frame body into (stream_id, pcm bytes).
pub fn unpack_audio(body: &[u8]) -> Option<(u32, &[u8])> {
    if body.len() < 4 {
        return None;
    }
    let sid = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
    Some((sid, &body[4..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use foyer_schema::{Command, ControlValue, EntityId, SCHEMA_VERSION};
    use std::io::Cursor;

    fn duplex(buf: Vec<u8>) -> Cursor<Vec<u8>> {
        Cursor::new(buf)
    }

    #[tokio::test]
    async fn control_frame_round_trip() {
        let env = Envelope {
            schema: SCHEMA_VERSION,
            seq: 7,
            origin: Some("test".into()),
            session_id: None,
            body: Control::Command(Command::ControlSet {
                id: EntityId::new("track.abc.gain"),
                value: ControlValue::Float(-6.0),
            }),
        };
        let payload = encode_control(&env).unwrap();
        let frame = Frame {
            kind: FrameKind::Control,
            payload,
        };

        let mut buf = Vec::new();
        write_frame(&mut buf, &frame).await.unwrap();

        let mut rx = duplex(buf);
        let got = read_frame(&mut rx).await.unwrap().expect("one frame");
        assert_eq!(got.kind, FrameKind::Control);
        let decoded: Envelope<Control> = decode_control(&got.payload).unwrap();
        assert_eq!(decoded, env);
    }

    #[tokio::test]
    async fn audio_frame_round_trip() {
        let pcm: Vec<u8> = (0..256).map(|i| (i & 0xff) as u8).collect();
        let body = pack_audio(42, &pcm);
        let frame = Frame {
            kind: FrameKind::Audio,
            payload: body,
        };

        let mut buf = Vec::new();
        write_frame(&mut buf, &frame).await.unwrap();

        let mut rx = duplex(buf);
        let got = read_frame(&mut rx).await.unwrap().unwrap();
        assert_eq!(got.kind, FrameKind::Audio);
        let (sid, pcm_back) = unpack_audio(&got.payload).unwrap();
        assert_eq!(sid, 42);
        assert_eq!(pcm_back, &pcm[..]);
    }

    #[tokio::test]
    async fn clean_eof_yields_none() {
        let mut rx = duplex(vec![]);
        let got = read_frame(&mut rx).await.unwrap();
        assert!(got.is_none());
    }

    #[tokio::test]
    async fn oversize_is_rejected() {
        // header: kind=Control, len = MAX_PAYLOAD + 1
        let len = MAX_PAYLOAD + 1;
        let mut buf = vec![FrameKind::Control as u8];
        buf.extend_from_slice(&len.to_be_bytes());
        let mut rx = duplex(buf);
        let err = read_frame(&mut rx).await.unwrap_err();
        matches!(err, FrameError::TooLarge(_, _));
    }
}
