use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest};

pub type Blake2b256 = Blake2b<U32>;

pub fn blake2b256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2b256::new();
    hasher.update(data);
    hasher.finalize().into()
}

pub fn blake2b256_reader<R: std::io::Read>(mut r: R) -> std::io::Result<[u8; 32]> {
    let mut hasher = Blake2b256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}
