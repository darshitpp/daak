// This file was code-generated using an experimental CDDL to rust tool:
// https://github.com/dcSpark/cddl-codegen

#![allow(
    clippy::too_many_arguments,
    clippy::large_enum_variant,
    clippy::result_large_err
)]

extern crate alloc;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
pub mod any_cbor;
pub mod error;
mod extern_interface_check;
pub mod json_schema_gen;
pub mod json_value_ser;
pub mod serialization;

use crate::generated::error::*;

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct DeviceRef {
    pub device_id: [u8; 16],
    pub name: String,
}

impl DeviceRef {
    pub fn new(device_id: Vec<u8>, name: String) -> Result<Self, DeserializeError> {
        let device_id: [u8; 16] =
            device_id
                .try_into()
                .map_err(|bytes: Vec<u8>| DeserializeFailure::RangeCheck {
                    found: bytes.len() as i128,
                    min: Some(16),
                    max: Some(16),
                })?;
        Ok(Self { device_id, name })
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct Item {
    pub index: u64,
    pub item_type: String,
    pub name: Option<String>,
    pub mime: Option<String>,
    pub size: Option<u64>,
    pub hash: Option<[u8; 32]>,
    pub text: Option<String>,
    pub chunk_size: Option<u64>,
    pub chunk_count: Option<u64>,
    pub children: Option<Vec<Item>>,
    pub reply_to: Option<[u8; 16]>,
    #[serde(with = "crate::generated::any_cbor::natural_any_cbor_opt_btreemap")]
    #[serde(default)]
    #[schemars(schema_with = "crate::generated::any_cbor::natural_any_cbor_map_schema")]
    pub attrs: Option<BTreeMap<String, crate::generated::any_cbor::AnyCbor>>,
}

impl Item {
    pub fn new(index: u64, item_type: String) -> Self {
        Self {
            index,
            item_type,
            name: None,
            mime: None,
            size: None,
            hash: None,
            text: None,
            chunk_size: None,
            chunk_count: None,
            children: None,
            reply_to: None,
            attrs: None,
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct PayloadManifest {
    pub v: u64,
    pub payload_id: [u8; 16],
    pub kind: String,
    pub created_at: u64,
    pub sender: DeviceRef,
    pub items: Vec<Item>,
    #[serde(with = "crate::generated::any_cbor::natural_any_cbor_opt_btreemap")]
    #[serde(default)]
    #[schemars(schema_with = "crate::generated::any_cbor::natural_any_cbor_map_schema")]
    pub meta: Option<BTreeMap<String, crate::generated::any_cbor::AnyCbor>>,
    #[serde(with = "crate::generated::any_cbor::natural_any_cbor_opt_btreemap")]
    #[serde(default)]
    #[schemars(schema_with = "crate::generated::any_cbor::natural_any_cbor_map_schema")]
    pub extensions: Option<BTreeMap<String, crate::generated::any_cbor::AnyCbor>>,
    pub reply_to: Option<[u8; 16]>,
}

impl PayloadManifest {
    pub fn new(
        v: u64,
        payload_id: Vec<u8>,
        kind: String,
        created_at: u64,
        sender: DeviceRef,
        items: Vec<Item>,
    ) -> Result<Self, DeserializeError> {
        let payload_id: [u8; 16] =
            payload_id
                .try_into()
                .map_err(|bytes: Vec<u8>| DeserializeFailure::RangeCheck {
                    found: bytes.len() as i128,
                    min: Some(16),
                    max: Some(16),
                })?;
        Ok(Self {
            v,
            payload_id,
            kind,
            created_at,
            sender,
            items,
            meta: None,
            extensions: None,
            reply_to: None,
        })
    }
}
