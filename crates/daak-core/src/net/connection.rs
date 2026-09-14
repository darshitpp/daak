use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::codec::Framed;

use crate::error::Result;
use crate::framing::{Frame, FrameCodec, RecordType};

pub const CONTROL_STREAM: u32 = 0;

pub struct Connection<S> {
    framed: Framed<S, FrameCodec>,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Connection<S> {
    pub fn new(stream: S, max_frame: u32) -> Self {
        Self {
            framed: Framed::new(stream, FrameCodec { max_frame }),
        }
    }

    pub async fn send(&mut self, stream_id: u32, kind: RecordType, body: Bytes) -> Result<()> {
        self.framed.send(Frame::new(stream_id, kind, body)).await
    }

    pub async fn recv(&mut self) -> Result<Option<Frame>> {
        self.framed.next().await.transpose()
    }

    pub async fn close(mut self) -> Result<()> {
        self.framed.close().await
    }
}
