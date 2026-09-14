use std::path::PathBuf;

use bytes::{BufMut, Bytes, BytesMut};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::chunk::ChunkReader;
use crate::control::AckMsg;
use crate::error::{CoreError, Result};
use crate::framing::RecordType;
use crate::manifest::{ItemType, Manifest, CHUNK_SIZE_DEFAULT};
use crate::net::{Connection, CONTROL_STREAM};

pub fn encode_chunk_body(item_index: u32, chunk_index: u64, data: &[u8]) -> Vec<u8> {
    let mut out = BytesMut::with_capacity(16 + data.len());
    out.put_u32(item_index);
    out.put_u64(chunk_index);
    out.put_u32(data.len() as u32);
    out.put_slice(data);
    out.to_vec()
}

pub fn decode_chunk_body(body: &[u8]) -> Result<(u32, u64, Bytes)> {
    if body.len() < 16 {
        return Err(CoreError::Protocol("chunk body shorter than header".into()));
    }
    let item_index = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
    let chunk_index = u64::from_be_bytes([
        body[4], body[5], body[6], body[7], body[8], body[9], body[10], body[11],
    ]);
    let data_len = u32::from_be_bytes([body[12], body[13], body[14], body[15]]) as usize;
    if body.len() != 16 + data_len {
        return Err(CoreError::Protocol("chunk body length mismatch".into()));
    }
    Ok((item_index, chunk_index, Bytes::copy_from_slice(&body[16..])))
}

pub async fn send_transfer<S>(
    conn: &mut Connection<S>,
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
    mut on_progress: impl FnMut(u64),
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    conn.send(
        CONTROL_STREAM,
        RecordType::Manifest,
        Bytes::from(manifest.to_cbor()?),
    )
    .await?;

    for item in &manifest.items {
        if item.item_type == ItemType::Text {
            continue;
        }
        let path = paths
            .get(item.index as usize)
            .and_then(|p| p.clone())
            .ok_or_else(|| CoreError::Transfer(format!("missing path for item {}", item.index)))?;
        let chunk_size = item.chunk_size.unwrap_or(CHUNK_SIZE_DEFAULT);
        let mut reader = ChunkReader::open(&path, chunk_size).await?;
        let stream_id = 100 + item.index;
        while let Some(chunk) = reader.next_chunk().await? {
            let body = encode_chunk_body(item.index, chunk.index, &chunk.data);
            on_progress(chunk.data.len() as u64);
            conn.send(stream_id, RecordType::Chunk, Bytes::from(body))
                .await?;
        }
    }

    loop {
        match conn.recv().await? {
            Some(f) if f.kind == RecordType::Ack => {
                let ack = AckMsg::from_cbor(&f.body)?;
                if ack.complete {
                    if !ack.hash_ok {
                        return Err(CoreError::Transfer(format!(
                            "receiver rejected item {}: hash mismatch",
                            ack.item_index
                        )));
                    }
                    return Ok(());
                }
            }
            Some(_) => continue,
            None => {
                return Err(CoreError::Protocol(
                    "connection closed before transfer ack".into(),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::RecordType;
    use crate::manifest::{DeviceRef, Item, PayloadKind};
    use crate::net::tcp;

    fn sender() -> DeviceRef {
        DeviceRef {
            device_id: [1u8; 16],
            name: "sender".into(),
        }
    }

    #[tokio::test]
    async fn sends_manifest_then_chunks_then_awaits_ack() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        std::fs::write(&p, vec![5u8; 150_000]).unwrap();

        let item = Item::from_file(0, &p, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, sender(), vec![item]);

        let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let expected_len = std::fs::metadata(&p).unwrap().len();
        let send_manifest = manifest.clone();

        let server = tokio::spawn(async move {
            let (mut conn, _) = tcp::accept(&listener).await.unwrap();
            let mf = conn.recv().await.unwrap().unwrap();
            assert_eq!(mf.kind, RecordType::Manifest);
            let received = Manifest::from_cbor(&mf.body).unwrap();
            assert_eq!(received.items[0].size, Some(expected_len));

            let expected_chunks = received.items[0].chunk_count.unwrap();
            let mut total = 0u64;
            for _ in 0..expected_chunks {
                let f = conn.recv().await.unwrap().unwrap();
                assert_eq!(f.kind, RecordType::Chunk);
                let (idx, _ci, data) = decode_chunk_body(&f.body).unwrap();
                assert_eq!(idx, 0);
                total += data.len() as u64;
            }
            assert_eq!(total, expected_len);
            assert_eq!(expected_chunks, 3);
            let ack = AckMsg {
                transfer_id: send_manifest.payload_id,
                item_index: 0,
                complete: true,
                hash_ok: true,
            };
            conn.send(
                crate::net::CONTROL_STREAM,
                RecordType::Ack,
                bytes::Bytes::from(ack.to_cbor().unwrap()),
            )
            .await
            .unwrap();
        });

        let mut conn = tcp::dial(addr).await.unwrap();
        let paths = vec![Some(p.clone())];
        send_transfer(&mut conn, &manifest, &paths, |_| {})
            .await
            .unwrap();
        server.await.unwrap();
    }
}
