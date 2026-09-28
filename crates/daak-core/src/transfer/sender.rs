use std::collections::HashMap;
use std::path::PathBuf;

use bytes::{BufMut, Bytes, BytesMut};

use crate::chunk::ChunkReader;
use crate::control::AckMsg;
use crate::error::{CoreError, Result};
use crate::framing::RecordType;
use crate::manifest::{Manifest, CHUNK_SIZE_DEFAULT};
use crate::net::{FrameTransport, CONTROL_STREAM};
use crate::transfer::scheduler::{interleave, ScheduledItem};

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

pub async fn send_transfer<T: FrameTransport>(
    conn: &mut T,
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
    // Per-item half-open chunk ranges; &[] or a missing entry = all chunks, a
    // present-but-empty entry = none (R-T7-4).
    ranges: &[Vec<(u64, u64)>],
    mut on_progress: impl FnMut(u64),
) -> Result<()> {
    conn.send(
        CONTROL_STREAM,
        RecordType::Manifest,
        Bytes::from(manifest.to_cbor()?),
    )
    .await?;

    let mut scheduled = Vec::with_capacity(manifest.items.len());
    // ponytail: one open reader per binary item for the whole transfer (mirrors the
    // receiver's all-files-open pattern). A folder of many hundreds of items can
    // hit the per-process fd limit; switch to lazy open/close per item if batches grow.
    let mut readers: HashMap<u32, ChunkReader> = HashMap::new();
    for item in &manifest.items {
        if !item.is_binary() {
            continue;
        }
        let path = paths
            .get(item.index as usize)
            .and_then(|p| p.clone())
            .ok_or_else(|| CoreError::Transfer(format!("missing path for item {}", item.index)))?;
        let chunk_size = item.chunk_size.unwrap_or(CHUNK_SIZE_DEFAULT);
        let chunk_count = item.chunk_count.ok_or_else(|| {
            CoreError::Transfer(format!("item {} missing chunk_count", item.index))
        })?;
        readers.insert(item.index, ChunkReader::open(&path, chunk_size).await?);
        scheduled.push(ScheduledItem {
            index: item.index,
            path,
            chunk_size,
            chunk_count,
        });
    }

    for (item_index, chunk_index) in interleave(scheduled, 1) {
        if !chunk_in_ranges(ranges, item_index, chunk_index) {
            continue;
        }
        let reader = readers
            .get_mut(&item_index)
            .ok_or_else(|| CoreError::Transfer(format!("no reader for item {item_index}")))?;
        let chunk = reader.read_chunk_at(chunk_index).await?.ok_or_else(|| {
            CoreError::Transfer(format!("chunk {chunk_index} missing for item {item_index}"))
        })?;
        let body = encode_chunk_body(item_index, chunk_index, &chunk.data);
        on_progress(chunk.data.len() as u64);
        conn.send(
            crate::session::item_stream(item_index),
            RecordType::Chunk,
            Bytes::from(body),
        )
        .await?;
    }

    loop {
        match conn.recv().await? {
            Some(f) if f.kind == RecordType::Ack => {
                let ack = AckMsg::from_cbor(&f.body)?;
                // Never trust the caller-side convention that only one transfer
                // is in flight per connection: an Ack for another transfer is a
                // protocol violation, and skipping it would hang on an Ack that
                // is never coming.
                if ack.transfer_id != manifest.payload_id {
                    return Err(CoreError::Protocol("ack for a different transfer".into()));
                }
                if ack.complete {
                    if !ack.hash_ok {
                        // B4: a quarantine, not a transfer failure. The
                        // receiver got every byte and hashed it; the verdict is
                        // about THESE bytes, so it can never be re-sent into a
                        // different answer. Naming the item keeps the caller
                        // from having to parse the message to find it.
                        return Err(CoreError::Quarantined {
                            transfer_id: manifest.payload_id,
                            item_index: ack.item_index,
                        });
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

/// True when the chunk is in scope for this transfer. An empty top-level
/// 'ranges' slice, or a MISSING per-item entry, means "send all chunks". A
/// PRESENT-BUT-EMPTY per-item list means "send nothing" (R-T7-4): that item was
/// already fully received, so it never appears in a NACK -- re-sending it is
/// exactly the duplicate the resume path must avoid. Otherwise a chunk is sent
/// iff it falls inside a half-open [start, end) range.
fn chunk_in_ranges(ranges: &[Vec<(u64, u64)>], item_index: u32, chunk_index: u64) -> bool {
    let Some(item_ranges) = ranges.get(item_index as usize) else {
        return true;
    };
    item_ranges
        .iter()
        .any(|&(start, end)| chunk_index >= start && chunk_index < end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::RecordType;
    use crate::manifest::{DeviceRef, Item, PayloadKind};
    use crate::net::secure::{MemConn, SecureConnection};
    use crate::net::tcp;

    fn sender() -> DeviceRef {
        DeviceRef {
            device_id: [1u8; 16],
            name: "sender".into(),
        }
    }

    /// Drives `send_transfer` over a real (socket-free) peer that answers with
    /// ONE ack, so the ack loop's verdict is observable without a port.
    async fn send_to_ack(
        ack: impl FnOnce([u8; 16]) -> AckMsg + Send + 'static,
    ) -> (Result<()>, Manifest) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        std::fs::write(&p, vec![5u8; 2_000]).unwrap();
        let item = Item::from_file(0, &p, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, sender(), vec![item]);

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let path = p.clone();
        let peer = tokio::spawn(async move {
            // Drain the manifest + every chunk, then answer with the ack the
            // test asked for. No socket, so this runs in any sandbox.
            let mut chunks = 0usize;
            loop {
                match theirs.recv().await {
                    Ok(Some(f)) if f.kind == RecordType::Chunk => chunks += 1,
                    Ok(Some(_)) => {}
                    Ok(None) => return,
                    Err(_) => return,
                }
                if chunks == 1 {
                    let a = ack(m.payload_id);
                    theirs
                        .send(
                            crate::net::CONTROL_STREAM,
                            RecordType::Ack,
                            bytes::Bytes::from(a.to_cbor().unwrap()),
                        )
                        .await
                        .unwrap();
                    return;
                }
            }
        });
        let r = send_transfer(&mut mine, &manifest, &[Some(path)], &[], |_| {}).await;
        peer.await.unwrap();
        (r, manifest)
    }

    #[test]
    fn chunk_in_ranges_sends_all_when_empty_or_matches() {
        // Empty top-level ranges => every chunk in scope.
        assert!(chunk_in_ranges(&[], 0, 999));
        // Present-but-empty per-item list => send NOTHING (R-T7-4): a fully
        // received item is absent from the NACK, and re-sending is a duplicate.
        assert!(!chunk_in_ranges(&[vec![]], 0, 999));
        // A non-empty list filters to half-open [start, end).
        assert!(chunk_in_ranges(&[vec![(2, 5)]], 0, 2));
        assert!(chunk_in_ranges(&[vec![(2, 5)]], 0, 4));
        assert!(!chunk_in_ranges(&[vec![(2, 5)]], 0, 5));
        assert!(!chunk_in_ranges(&[vec![(2, 5)]], 0, 1));
        // Item without an entry => send all.
        assert!(chunk_in_ranges(&[vec![(2, 5)]], 1, 7));
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
        send_transfer(&mut conn, &manifest, &paths, &[], |_| {})
            .await
            .unwrap();
        server.await.unwrap();
    }

    /// B4: a hash-mismatch ack is NOT a transport failure. The receiver holds
    /// the item in quarantine and says so; the sender must be able to tell the
    /// two apart without parsing an error STRING, because `drain_outbox_row`
    /// routes on exactly that distinction (retry vs. record a quarantine).
    #[tokio::test]
    async fn a_hash_mismatch_ack_is_a_quarantine_naming_the_item() {
        let (r, manifest) = send_to_ack(move |id| AckMsg {
            transfer_id: id,
            item_index: 0,
            complete: true,
            hash_ok: false,
        })
        .await;
        match r {
            Err(CoreError::Quarantined {
                transfer_id,
                item_index,
            }) => {
                assert_eq!(transfer_id, manifest.payload_id);
                assert_eq!(item_index, 0, "the ack names the failed item");
            }
            other => panic!("a hash mismatch must be a Quarantined error, got {other:?}"),
        }
    }

    /// ...and a clean ack is still Ok. Guards the fail-closed direction: the
    /// new error must not swallow a good delivery.
    #[tokio::test]
    async fn a_good_ack_is_still_ok() {
        let (r, _manifest) = send_to_ack(move |id| AckMsg {
            transfer_id: id,
            item_index: 0,
            complete: true,
            hash_ok: true,
        })
        .await;
        r.unwrap_or_else(|e| panic!("a clean ack must not fail, got {e:?}"));
    }

    /// B4 fail-closed: a connection that closes BEFORE the ack is a genuine
    /// transport failure and must keep its existing error, so the retry path
    /// still sees something it is allowed to retry.
    #[tokio::test]
    async fn a_close_before_ack_is_still_a_protocol_error_not_a_quarantine() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        std::fs::write(&p, vec![5u8; 2_000]).unwrap();
        let item = Item::from_file(0, &p, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, sender(), vec![item]);

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let peer = tokio::spawn(async move {
            // Read the manifest, then hang up without an ack.
            let _ = theirs.recv().await;
        });
        let r = send_transfer(&mut mine, &manifest, &[Some(p)], &[], |_| {}).await;
        peer.await.unwrap();
        assert!(
            matches!(r, Err(CoreError::Protocol(_))),
            "a close before the ack is a retryable transport error, got {r:?}"
        );
    }
}
