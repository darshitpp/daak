use bytes::{Buf, BufMut, Bytes, BytesMut};
use tokio_util::codec::{Decoder, Encoder};

use crate::error::{CoreError, Result};

pub const DEFAULT_MAX_FRAME: u32 = 4 * 1024 * 1024;
pub const HEADER_LEN: usize = 9; // u32 length + u8 type + u32 stream_id

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RecordType {
    Handshake = 1,
    Control = 2,
    Manifest = 3,
    Chunk = 4,
    Ack = 5,
    Nack = 6,
    Rekey = 7,
    Keepalive = 8,
    Error = 9,
}

impl RecordType {
    pub fn from_u8(b: u8) -> Result<Self> {
        use RecordType::*;
        Ok(match b {
            1 => Handshake,
            2 => Control,
            3 => Manifest,
            4 => Chunk,
            5 => Ack,
            6 => Nack,
            7 => Rekey,
            8 => Keepalive,
            9 => Error,
            other => return Err(CoreError::Protocol(format!("unknown record type {other}"))),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub stream_id: u32,
    pub kind: RecordType,
    pub body: Bytes,
}

impl Frame {
    pub fn new(stream_id: u32, kind: RecordType, body: Bytes) -> Self {
        Self {
            stream_id,
            kind,
            body,
        }
    }
}

pub fn encode_frame(frame: &Frame, max_frame: u32) -> Result<BytesMut> {
    let body_len = frame.body.len();
    let len = 5usize + body_len;
    if len as u64 > max_frame as u64 {
        return Err(CoreError::FrameTooLarge(len as u32));
    }
    let mut out = BytesMut::with_capacity(4 + len);
    out.put_u32(len as u32);
    out.put_u8(frame.kind as u8);
    out.put_u32(frame.stream_id);
    out.put_slice(&frame.body);
    Ok(out)
}

pub fn decode_frame(buf: &mut BytesMut, max_frame: u32) -> Result<Option<Frame>> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len < 5 {
        return Err(CoreError::Protocol(format!("frame length {len} too small")));
    }
    if len as u64 > max_frame as u64 {
        return Err(CoreError::FrameTooLarge(len as u32));
    }
    if buf.len() < 4 + len {
        return Ok(None);
    }
    buf.advance(4);
    let kind = RecordType::from_u8(buf[0])?;
    let stream_id = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);
    buf.advance(5);
    let body = buf.split_to(len - 5).freeze();
    Ok(Some(Frame::new(stream_id, kind, body)))
}

#[derive(Debug, Clone)]
pub struct FrameCodec {
    pub max_frame: u32,
}

impl Default for FrameCodec {
    fn default() -> Self {
        Self {
            max_frame: DEFAULT_MAX_FRAME,
        }
    }
}

impl Decoder for FrameCodec {
    type Item = Frame;
    type Error = CoreError;

    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Frame>> {
        decode_frame(src, self.max_frame)
    }
}

impl Encoder<Frame> for FrameCodec {
    type Error = CoreError;

    fn encode(&mut self, item: Frame, dst: &mut BytesMut) -> Result<()> {
        let encoded = encode_frame(&item, self.max_frame)?;
        dst.extend_from_slice(&encoded);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::BytesMut;

    #[test]
    fn roundtrip_preserves_kind_stream_and_body() {
        let f = Frame::new(100, RecordType::Chunk, bytes::Bytes::from_static(b"hello"));
        let mut buf = encode_frame(&f, DEFAULT_MAX_FRAME).unwrap();
        let got = decode_frame(&mut buf, DEFAULT_MAX_FRAME).unwrap().unwrap();
        assert_eq!(got, f);
        assert!(buf.is_empty(), "decoder must consume exactly one frame");
    }

    #[test]
    fn partial_input_returns_none() {
        let f = Frame::new(0, RecordType::Control, bytes::Bytes::from_static(b"abc"));
        let buf = encode_frame(&f, DEFAULT_MAX_FRAME).unwrap();
        let mut partial = BytesMut::from(&buf[..buf.len() - 1]);
        assert!(decode_frame(&mut partial, DEFAULT_MAX_FRAME)
            .unwrap()
            .is_none());
        assert_eq!(
            partial.len(),
            buf.len() - 1,
            "partial frame must not be consumed"
        );
    }

    #[test]
    fn oversize_frame_is_rejected_on_encode_and_decode() {
        let big = Frame::new(0, RecordType::Chunk, bytes::Bytes::from(vec![0u8; 32]));
        assert!(matches!(
            encode_frame(&big, 8),
            Err(CoreError::FrameTooLarge(_))
        ));

        let mut raw = BytesMut::new();
        raw.extend_from_slice(&100u32.to_be_bytes());
        raw.extend_from_slice(&[0u8; 100]);
        assert!(matches!(
            decode_frame(&mut raw, 16),
            Err(CoreError::FrameTooLarge(_))
        ));
    }

    #[test]
    fn unknown_record_type_is_rejected() {
        let mut raw = BytesMut::new();
        raw.extend_from_slice(&5u32.to_be_bytes());
        raw.extend_from_slice(&[255, 0, 0, 0, 0]);
        assert!(matches!(
            decode_frame(&mut raw, DEFAULT_MAX_FRAME),
            Err(CoreError::Protocol(_))
        ));
    }

    #[test]
    fn trailing_bytes_are_left_for_next_frame() {
        let a = Frame::new(0, RecordType::Ack, bytes::Bytes::from_static(b"a"));
        let b = Frame::new(0, RecordType::Ack, bytes::Bytes::from_static(b"b"));
        let mut buf = encode_frame(&a, DEFAULT_MAX_FRAME).unwrap();
        buf.extend_from_slice(&encode_frame(&b, DEFAULT_MAX_FRAME).unwrap());
        assert_eq!(
            decode_frame(&mut buf, DEFAULT_MAX_FRAME).unwrap().unwrap(),
            a
        );
        assert_eq!(
            decode_frame(&mut buf, DEFAULT_MAX_FRAME).unwrap().unwrap(),
            b
        );
    }
}
