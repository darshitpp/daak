use std::path::Path;

use bytes::Bytes;
use tokio::io::AsyncReadExt;

use crate::error::Result;
use crate::manifest::clamp_chunk_size;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub index: u64,
    pub data: Bytes,
}

pub struct ChunkReader {
    file: tokio::fs::File,
    buf: Vec<u8>,
    chunk_size: u32,
    next_index: u64,
}

impl ChunkReader {
    pub async fn open(path: &Path, chunk_size: u32) -> Result<Self> {
        let chunk_size = clamp_chunk_size(chunk_size);
        Ok(Self {
            file: tokio::fs::File::open(path).await?,
            buf: vec![0u8; chunk_size as usize],
            chunk_size,
            next_index: 0,
        })
    }

    pub fn chunk_size(&self) -> u32 {
        self.chunk_size
    }

    pub fn buffer_capacity(&self) -> usize {
        self.buf.capacity()
    }

    pub async fn next_chunk(&mut self) -> Result<Option<Chunk>> {
        let mut filled = 0usize;
        let target = self.chunk_size as usize;
        while filled < target {
            let n = self.file.read(&mut self.buf[filled..target]).await?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        if filled == 0 {
            return Ok(None);
        }
        let index = self.next_index;
        self.next_index += 1;
        Ok(Some(Chunk {
            index,
            data: Bytes::copy_from_slice(&self.buf[..filled]),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[tokio::test]
    async fn reads_sizes_including_short_final_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(&vec![1u8; 100_000]).unwrap();
        drop(f);

        let mut r = ChunkReader::open(&path, 64 * 1024).await.unwrap();
        let c0 = r.next_chunk().await.unwrap().unwrap();
        let c1 = r.next_chunk().await.unwrap().unwrap();
        assert_eq!(c0.index, 0);
        assert_eq!(c0.data.len(), 64 * 1024);
        assert_eq!(c1.index, 1);
        assert_eq!(c1.data.len(), 100_000 - 64 * 1024);
        assert!(r.next_chunk().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn empty_file_yields_no_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.bin");
        std::fs::File::create(&path).unwrap();
        let mut r = ChunkReader::open(&path, 64 * 1024).await.unwrap();
        assert!(r.next_chunk().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn buffer_never_exceeds_chunk_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        std::fs::write(&path, vec![9u8; 500_000]).unwrap();
        let chunk = 64 * 1024;
        let mut r = ChunkReader::open(&path, chunk).await.unwrap();
        while let Some(c) = r.next_chunk().await.unwrap() {
            assert!(
                c.data.len() <= chunk as usize,
                "chunk exceeded configured size"
            );
        }
        assert!(
            r.buffer_capacity() <= chunk as usize,
            "reader retained more than one chunk"
        );
    }
}
