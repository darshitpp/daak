use std::fmt::Display;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("codec: {0}")]
    Codec(String),
    #[error("frame too large: {0}")]
    FrameTooLarge(u32),
    #[error("cbor: {0}")]
    Cbor(String),
    #[error("protocol: {0}")]
    Protocol(String),
    #[error("transfer: {0}")]
    Transfer(String),
    #[error("discovery: {0}")]
    Discovery(String),
    #[error("naming: {0}")]
    Naming(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;

pub fn io_err<E: Display>(ctx: &str, e: E) -> CoreError {
    CoreError::Io(std::io::Error::other(format!("{ctx}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_too_large_displays_size() {
        let e = CoreError::FrameTooLarge(9_999_999);
        assert!(e.to_string().contains("9999999"));
    }
}
