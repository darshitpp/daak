use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    #[serde(with = "crate::manifest::byte_array")]
    pub device_id: [u8; 16],
}

impl Hello {
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
pub struct AckMsg {
    #[serde(with = "crate::manifest::byte_array")]
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
    #[serde(with = "crate::manifest::byte_array")]
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

    #[test]
    fn transfer_id_encodes_as_cbor_bytes() {
        use ciborium::value::Value;

        let a = AckMsg {
            transfer_id: [3u8; 16],
            item_index: 2,
            complete: true,
            hash_ok: true,
        };
        let n = NackMsg {
            transfer_id: [5u8; 16],
            item_index: 1,
            ranges: vec![(0, 1)],
        };
        for bytes in [a.to_cbor().unwrap(), n.to_cbor().unwrap()] {
            let value: Value = ciborium::de::from_reader(bytes.as_slice()).unwrap();
            let Value::Map(entries) = &value else {
                panic!("expected map, got {value:?}");
            };
            let transfer_id = entries
                .iter()
                .find(|(k, _)| matches!(k, Value::Text(t) if t == "transfer_id"))
                .map(|(_, v)| v)
                .expect("missing transfer_id");
            assert!(
                matches!(transfer_id, Value::Bytes(b) if b.len() == 16),
                "transfer_id must be a 16-byte CBOR bstr, got {transfer_id:?}"
            );
        }
    }

    #[test]
    fn hello_device_id_encodes_as_cbor_bytes() {
        use ciborium::value::Value;

        let h = Hello {
            device_id: [3u8; 16],
        };
        assert_eq!(Hello::from_cbor(&h.to_cbor().unwrap()).unwrap(), h);

        let value: Value = ciborium::de::from_reader(h.to_cbor().unwrap().as_slice()).unwrap();
        let Value::Map(entries) = &value else {
            panic!("expected map, got {value:?}");
        };
        let device_id = entries
            .iter()
            .find(|(k, _)| matches!(k, Value::Text(t) if t == "device_id"))
            .map(|(_, v)| v)
            .expect("missing device_id");
        assert!(
            matches!(device_id, Value::Bytes(b) if b.len() == 16),
            "device_id must be a 16-byte CBOR bstr, got {device_id:?}"
        );
    }
}
