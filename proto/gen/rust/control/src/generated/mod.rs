// This file was code-generated using an experimental CDDL to rust tool:
// https://github.com/dcSpark/cddl-codegen

#![allow(
    clippy::too_many_arguments,
    clippy::large_enum_variant,
    clippy::result_large_err
)]

extern crate alloc;
use alloc::vec::Vec;
pub mod error;
mod extern_interface_check;
pub mod json_schema_gen;
pub mod json_value_ser;
pub mod serialization;

use crate::generated::error::*;

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct Ack {
    pub transfer_id: [u8; 16],
    pub item_index: u64,
    pub complete: bool,
    pub hash_ok: bool,
}

impl Ack {
    pub fn new(
        transfer_id: Vec<u8>,
        item_index: u64,
        complete: bool,
        hash_ok: bool,
    ) -> Result<Self, DeserializeError> {
        let transfer_id: [u8; 16] =
            transfer_id
                .try_into()
                .map_err(|bytes: Vec<u8>| DeserializeFailure::RangeCheck {
                    found: bytes.len() as i128,
                    min: Some(16),
                    max: Some(16),
                })?;
        Ok(Self {
            transfer_id,
            item_index,
            complete,
            hash_ok,
        })
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct Hello {
    pub device_id: [u8; 16],
}

impl Hello {
    pub fn new(device_id: Vec<u8>) -> Result<Self, DeserializeError> {
        let device_id: [u8; 16] =
            device_id
                .try_into()
                .map_err(|bytes: Vec<u8>| DeserializeFailure::RangeCheck {
                    found: bytes.len() as i128,
                    min: Some(16),
                    max: Some(16),
                })?;
        Ok(Self { device_id })
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct Nack {
    pub transfer_id: [u8; 16],
    pub item_index: u64,
    pub ranges: Vec<Range>,
}

impl Nack {
    pub fn new(
        transfer_id: Vec<u8>,
        item_index: u64,
        ranges: Vec<Range>,
    ) -> Result<Self, DeserializeError> {
        let transfer_id: [u8; 16] =
            transfer_id
                .try_into()
                .map_err(|bytes: Vec<u8>| DeserializeFailure::RangeCheck {
                    found: bytes.len() as i128,
                    min: Some(16),
                    max: Some(16),
                })?;
        Ok(Self {
            transfer_id,
            item_index,
            ranges,
        })
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct Range {
    pub index_0: u64,
    pub index_1: u64,
}

impl Range {
    pub fn new(index_0: u64, index_1: u64) -> Self {
        Self { index_0, index_1 }
    }
}
