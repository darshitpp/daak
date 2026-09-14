use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AckMsg {
    pub transfer_id: [u8; 16],
    pub item_index: u32,
    pub complete: bool,
    pub hash_ok: bool,
}

impl AckMsg {
    pub fn to_cbor(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        ciborium::ser::into_writer(self, &mut out).map_err(|e| CoreError::Cbor(e.to_string()))?;
        Ok(out)
    }

    pub fn from_cbor(bytes: &[u8]) -> Result<Self> {
        ciborium::de::from_reader(bytes).map_err(|e| CoreError::Cbor(e.to_string()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NackMsg {
    pub transfer_id: [u8; 16],
    pub item_index: u32,
    pub ranges: Vec<(u64, u64)>,
}

impl NackMsg {
    pub fn to_cbor(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        ciborium::ser::into_writer(self, &mut out).map_err(|e| CoreError::Cbor(e.to_string()))?;
        Ok(out)
    }

    pub fn from_cbor(bytes: &[u8]) -> Result<Self> {
        ciborium::de::from_reader(bytes).map_err(|e| CoreError::Cbor(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ack_cbor_roundtrip() {
        let a = AckMsg {
            transfer_id: [3u8; 16],
            item_index: 2,
            complete: true,
            hash_ok: true,
        };
        assert_eq!(AckMsg::from_cbor(&a.to_cbor().unwrap()).unwrap(), a);
    }
}
