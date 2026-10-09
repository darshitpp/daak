use std::fmt::Display;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("store: {0}")]
    Store(#[from] rusqlite::Error),
    #[error("codec: {0}")]
    Codec(String),
    #[error("frame too large: {0}")]
    FrameTooLarge(u32),
    #[error("cbor: {0}")]
    Cbor(String),
    #[error("protocol: {0}")]
    Protocol(String),
    /// The peer sent an unpair notice. The inbound path revokes its own pairing.
    #[error("peer unpaired this device")]
    PeerUnpaired,
    #[error("transfer: {0}")]
    Transfer(String),
    /// B4: the receiver received every chunk, verified the hashes, and HELD an
    /// item in quarantine. Distinct from `Transfer` because it is a permanent
    /// verdict on these exact bytes, not a transport failure: the caller must
    /// settle the row instead of retrying, and `item_index` is the one item the
    /// ack named. Carries the transfer id so the caller never has to infer it.
    #[error(
        "receiver quarantined item {item_index} of transfer {}: hash mismatch",
        hex::encode(transfer_id)
    )]
    Quarantined {
        transfer_id: [u8; 16],
        item_index: u32,
    },
    #[error("transfer interrupted; resume state persisted")]
    TransferInterrupted,
    #[error("discovery: {0}")]
    Discovery(String),
    #[error("naming: {0}")]
    Naming(String),
    #[error("unsupported schema; update required")]
    UnsupportedSchema,
}

pub type Result<T> = std::result::Result<T, CoreError>;

pub fn io_err<E: Display>(ctx: &str, e: E) -> CoreError {
    CoreError::Io(std::io::Error::other(format!("{ctx}: {e}")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCategory {
    Network,
    Crypto,
    Disk,
    PeerRejected,
    UnsupportedSchema,
}

impl CoreError {
    pub fn category(&self) -> ErrorCategory {
        match self {
            CoreError::Io(_) | CoreError::Store(_) => ErrorCategory::Disk,
            CoreError::FrameTooLarge(_) => ErrorCategory::Network,
            CoreError::Protocol(m) if m.contains("aead") || m.contains("noise") => {
                ErrorCategory::Crypto
            }
            CoreError::Protocol(_) => ErrorCategory::PeerRejected,
            CoreError::Codec(_) | CoreError::Cbor(_) => ErrorCategory::PeerRejected,
            CoreError::Transfer(_) => ErrorCategory::PeerRejected,
            // Same class as Transfer: the peer made a decision about the data.
            // It stays OUT of Network so nothing upstream reads a quarantine as
            // a flaky link worth retrying.
            CoreError::Quarantined { .. } => ErrorCategory::PeerRejected,
            CoreError::TransferInterrupted => ErrorCategory::Network,
            CoreError::Discovery(_) => ErrorCategory::Network,
            CoreError::UnsupportedSchema => ErrorCategory::UnsupportedSchema,
            _ => ErrorCategory::PeerRejected,
        }
    }
}

/// Refuse a manifest whose major version (version / 100) differs from ours.
pub fn ensure_compatible(manifest_version: u16) -> Result<()> {
    if manifest_version / 100 == crate::manifest::MANIFEST_VERSION / 100 {
        Ok(())
    } else {
        Err(CoreError::UnsupportedSchema)
    }
}

/// Refuse peers whose wire protocol major version (version / 100) differs from ours.
pub fn ensure_proto_compatible(peer_proto_version: u16) -> Result<()> {
    if peer_proto_version / 100 == crate::discovery::mdns::PROTO_VERSION / 100 {
        Ok(())
    } else {
        Err(CoreError::UnsupportedSchema)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_too_large_displays_size() {
        let e = CoreError::FrameTooLarge(9_999_999);
        assert!(e.to_string().contains("9999999"));
    }

    #[test]
    fn categories_cover_representative_errors() {
        assert_eq!(
            CoreError::Io(std::io::Error::other("x")).category(),
            ErrorCategory::Disk
        );
        assert_eq!(
            CoreError::Store(rusqlite::Error::QueryReturnedNoRows).category(),
            ErrorCategory::Disk
        );
        assert_eq!(
            CoreError::Protocol("aead open failed".into()).category(),
            ErrorCategory::Crypto
        );
        assert_eq!(
            CoreError::FrameTooLarge(1).category(),
            ErrorCategory::Network
        );
        assert_eq!(
            CoreError::UnsupportedSchema.category(),
            ErrorCategory::UnsupportedSchema
        );
    }

    #[test]
    fn version_mismatch_is_refused() {
        use crate::discovery::mdns::PROTO_VERSION;
        assert!(ensure_proto_compatible(PROTO_VERSION).is_ok());
        // /100 grouping: +100 steps to the next incompatible major version.
        assert!(matches!(
            ensure_proto_compatible(PROTO_VERSION + 100),
            Err(CoreError::UnsupportedSchema)
        ));
    }

    #[test]
    fn build_with_the_old_session_key_schedule_is_refused() {
        // Proto 1 derived the session keys from the public handshake hash.
        assert!(matches!(
            ensure_proto_compatible(1),
            Err(CoreError::UnsupportedSchema)
        ));
    }
}
