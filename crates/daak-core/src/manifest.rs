use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::hash::blake2b256_reader;

pub const MANIFEST_VERSION: u16 = 1;
pub const CHUNK_SIZE_DEFAULT: u32 = 1024 * 1024;
pub const CHUNK_SIZE_MIN: u32 = 64 * 1024;
pub const CHUNK_SIZE_MAX: u32 = 4 * 1024 * 1024;

pub fn clamp_chunk_size(requested: u32) -> u32 {
    requested.clamp(CHUNK_SIZE_MIN, CHUNK_SIZE_MAX)
}

mod byte_array {
    use std::fmt;

    use serde::de::{Error, Visitor};
    use serde::{Deserializer, Serializer};

    pub fn serialize<const N: usize, S: Serializer>(
        bytes: &[u8; N],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(bytes)
    }

    pub fn deserialize<'de, const N: usize, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<[u8; N], D::Error> {
        struct ByteArrayVisitor<const N: usize>;

        impl<'de, const N: usize> Visitor<'de> for ByteArrayVisitor<N> {
            type Value = [u8; N];

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "a {N}-byte CBOR byte string")
            }

            fn visit_bytes<E: Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                v.try_into().map_err(|_| E::invalid_length(v.len(), &self))
            }
        }

        deserializer.deserialize_bytes(ByteArrayVisitor)
    }

    pub mod option {
        use std::fmt;

        use serde::de::{Error, Visitor};
        use serde::{Deserializer, Serializer};

        pub fn serialize<const N: usize, S: Serializer>(
            value: &Option<[u8; N]>,
            serializer: S,
        ) -> Result<S::Ok, S::Error> {
            match value {
                Some(bytes) => serializer.serialize_bytes(bytes),
                None => serializer.serialize_none(),
            }
        }

        pub fn deserialize<'de, const N: usize, D: Deserializer<'de>>(
            deserializer: D,
        ) -> Result<Option<[u8; N]>, D::Error> {
            struct OptionalVisitor<const N: usize>;

            impl<'de, const N: usize> Visitor<'de> for OptionalVisitor<N> {
                type Value = Option<[u8; N]>;

                fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    write!(f, "an optional {N}-byte CBOR byte string")
                }

                fn visit_none<E: Error>(self) -> Result<Self::Value, E> {
                    Ok(None)
                }

                fn visit_unit<E: Error>(self) -> Result<Self::Value, E> {
                    Ok(None)
                }

                fn visit_some<D2: Deserializer<'de>>(
                    self,
                    d: D2,
                ) -> Result<Self::Value, D2::Error> {
                    super::deserialize(d).map(Some)
                }

                fn visit_bytes<E: Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                    v.try_into()
                        .map(Some)
                        .map_err(|_| E::invalid_length(v.len(), &self))
                }
            }

            deserializer.deserialize_option(OptionalVisitor)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceRef {
    #[serde(with = "byte_array")]
    pub device_id: [u8; 16],
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayloadKind {
    Text,
    Media,
    Batch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemType {
    Text,
    Image,
    Video,
    Document,
    Folder,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub index: u32,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub size: Option<u64>,
    #[serde(
        with = "byte_array::option",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub hash: Option<[u8; 32]>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub chunk_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub chunk_count: Option<u64>,
    #[serde(default)]
    pub attrs: BTreeMap<String, ciborium::value::Value>,
}

impl Item {
    pub fn text(index: u32, text: impl Into<String>) -> Self {
        Self {
            index,
            item_type: ItemType::Text,
            text: Some(text.into()),
            ..Default::default()
        }
    }

    pub fn from_file(index: u32, path: &Path, chunk_size: u32) -> Result<Self> {
        let meta = std::fs::metadata(path)?;
        let size = meta.len();
        let f = std::fs::File::open(path)?;
        let hash = blake2b256_reader(f)?;
        let chunk_size = clamp_chunk_size(chunk_size);
        let chunk_count = size.div_ceil(chunk_size as u64);
        Ok(Self {
            index,
            item_type: ItemType::Document,
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()),
            mime: None,
            size: Some(size),
            hash: Some(hash),
            text: None,
            chunk_size: Some(chunk_size),
            chunk_count: Some(chunk_count),
            attrs: BTreeMap::new(),
        })
    }
}

impl Default for Item {
    fn default() -> Self {
        Self {
            index: 0,
            item_type: ItemType::Custom,
            name: None,
            mime: None,
            size: None,
            hash: None,
            text: None,
            chunk_size: None,
            chunk_count: None,
            attrs: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub v: u16,
    #[serde(with = "byte_array")]
    pub payload_id: [u8; 16],
    pub kind: PayloadKind,
    pub created_at: u64,
    pub sender: DeviceRef,
    pub items: Vec<Item>,
    #[serde(default)]
    pub meta: BTreeMap<String, ciborium::value::Value>,
    #[serde(default)]
    pub extensions: BTreeMap<String, ciborium::value::Value>,
}

impl Manifest {
    pub fn new(kind: PayloadKind, sender: DeviceRef, items: Vec<Item>) -> Self {
        let mut payload_id = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut payload_id);
        Self {
            v: MANIFEST_VERSION,
            payload_id,
            kind,
            created_at: now_ms(),
            sender,
            items,
            meta: BTreeMap::new(),
            extensions: BTreeMap::new(),
        }
    }

    pub fn text(text: &str) -> Self {
        let sender = DeviceRef {
            device_id: [0u8; 16],
            name: "local".into(),
        };
        Self::new(PayloadKind::Text, sender, vec![Item::text(0, text)])
    }

    pub fn to_cbor(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        ciborium::ser::into_writer(self, &mut out).map_err(|e| CoreError::Cbor(e.to_string()))?;
        Ok(out)
    }

    pub fn from_cbor(bytes: &[u8]) -> Result<Self> {
        ciborium::de::from_reader(bytes).map_err(|e| CoreError::Cbor(e.to_string()))
    }

    pub fn binary_items(&self) -> impl Iterator<Item = &Item> {
        self.items.iter().filter(|i| i.item_type != ItemType::Text)
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::blake2b256;

    #[test]
    fn cbor_roundtrip_preserves_fields() {
        let m = Manifest::text("hello daak");
        let bytes = m.to_cbor().unwrap();
        let back = Manifest::from_cbor(&bytes).unwrap();
        assert_eq!(m, back);
        assert_eq!(back.kind, PayloadKind::Text);
        assert_eq!(back.items[0].text.as_deref(), Some("hello daak"));
    }

    #[test]
    fn unknown_extension_fields_survive_roundtrip() {
        let mut m = Manifest::text("x");
        m.extensions.insert(
            "future_field".into(),
            ciborium::value::Value::Integer(42.into()),
        );
        let back = Manifest::from_cbor(&m.to_cbor().unwrap()).unwrap();
        assert!(back.extensions.contains_key("future_field"));
    }

    #[test]
    fn from_file_hashes_and_counts_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin");
        std::fs::write(&path, vec![7u8; CHUNK_SIZE_DEFAULT as usize + 5]).unwrap();
        let item = Item::from_file(0, &path, CHUNK_SIZE_DEFAULT).unwrap();
        assert_eq!(item.size, Some(CHUNK_SIZE_DEFAULT as u64 + 5));
        assert_eq!(item.chunk_count, Some(2));
        assert_eq!(item.item_type, ItemType::Document);
        assert_eq!(item.hash, Some(blake2b256(&std::fs::read(&path).unwrap())));
    }

    #[test]
    fn clamp_chunk_size_bounds() {
        assert_eq!(clamp_chunk_size(0), CHUNK_SIZE_MIN);
        assert_eq!(clamp_chunk_size(u32::MAX), CHUNK_SIZE_MAX);
        assert_eq!(clamp_chunk_size(CHUNK_SIZE_DEFAULT), CHUNK_SIZE_DEFAULT);
    }

    fn map_get<'a>(value: &'a ciborium::value::Value, key: &str) -> &'a ciborium::value::Value {
        match value {
            ciborium::value::Value::Map(entries) => entries
                .iter()
                .find(|(k, _)| matches!(k, ciborium::value::Value::Text(t) if t == key))
                .map(|(_, v)| v)
                .unwrap_or_else(|| panic!("missing key {key}")),
            other => panic!("expected map, got {other:?}"),
        }
    }

    #[test]
    fn binary_fields_encode_as_cbor_byte_strings() {
        use ciborium::value::Value;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin");
        std::fs::write(&path, [1u8, 2, 3, 4]).unwrap();

        let mut m = Manifest::text("hi");
        m.items
            .push(Item::from_file(1, &path, CHUNK_SIZE_DEFAULT).unwrap());
        let bytes = m.to_cbor().unwrap();

        let value: Value = ciborium::de::from_reader(bytes.as_slice()).unwrap();

        let payload_id = map_get(&value, "payload_id");
        assert!(
            matches!(payload_id, Value::Bytes(b) if b.len() == 16),
            "payload_id must be a 16-byte CBOR bstr, got {payload_id:?}"
        );

        let device_id = map_get(map_get(&value, "sender"), "device_id");
        assert!(
            matches!(device_id, Value::Bytes(b) if b.len() == 16),
            "device_id must be a 16-byte CBOR bstr, got {device_id:?}"
        );

        let items = match map_get(&value, "items") {
            Value::Array(a) => a,
            other => panic!("expected items array, got {other:?}"),
        };
        let hash = map_get(&items[1], "hash");
        assert!(
            matches!(hash, Value::Bytes(b) if b.len() == 32),
            "hash must be a 32-byte CBOR bstr, got {hash:?}"
        );
    }
}
