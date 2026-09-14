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

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct CancelRequest {
    pub cancel: TransferRef,
}

impl CancelRequest {
    pub fn new(cancel: TransferRef) -> Self {
        Self { cancel }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct DeviceFoundArgs {
    pub device_id: String,
    pub name: String,
    pub addr: String,
}

impl DeviceFoundArgs {
    pub fn new(device_id: String, name: String, addr: String) -> Self {
        Self {
            device_id,
            name,
            addr,
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct DeviceFoundEvent {
    pub device_found: DeviceFoundArgs,
}

impl DeviceFoundEvent {
    pub fn new(device_found: DeviceFoundArgs) -> Self {
        Self { device_found }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct DeviceStateArgs {
    pub device_id: String,
    pub online: bool,
}

impl DeviceStateArgs {
    pub fn new(device_id: String, online: bool) -> Self {
        Self { device_id, online }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct DeviceStateEvent {
    pub device_state: DeviceStateArgs,
}

impl DeviceStateEvent {
    pub fn new(device_state: DeviceStateArgs) -> Self {
        Self { device_state }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub enum DevicesRequest {
    ValueText44657669636573,
}

impl DevicesRequest {
    pub fn new_value_text44657669636573() -> Self {
        Self::ValueText44657669636573
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct DisplayNameArgs {
    pub name: String,
}

impl DisplayNameArgs {
    pub fn new(name: String) -> Self {
        Self { name }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ErrorArgs {
    pub message: String,
}

impl ErrorArgs {
    pub fn new(message: String) -> Self {
        Self { message }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ErrorResponse {
    pub error: ErrorArgs,
}

impl ErrorResponse {
    pub fn new(error: ErrorArgs) -> Self {
        Self { error }
    }
}

pub type Extensions = BTreeMap<String, crate::generated::any_cbor::AnyCbor>;

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct InboxReceivedArgs {
    pub payload: String,
}

impl InboxReceivedArgs {
    pub fn new(payload: String) -> Self {
        Self { payload }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct InboxReceivedEvent {
    pub inbox_received: InboxReceivedArgs,
}

impl InboxReceivedEvent {
    pub fn new(inbox_received: InboxReceivedArgs) -> Self {
        Self { inbox_received }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub enum IpcEvent {
    DeviceFoundEvent(DeviceFoundEvent),
    DeviceStateEvent(DeviceStateEvent),
    PairingSasEvent(PairingSasEvent),
    TransferProgressEvent(TransferProgressEvent),
    TransferDoneEvent(TransferDoneEvent),
    TransferFailedEvent(TransferFailedEvent),
    InboxReceivedEvent(InboxReceivedEvent),
}

impl IpcEvent {
    pub fn new_device_found_event(device_found_event: DeviceFoundEvent) -> Self {
        Self::DeviceFoundEvent(device_found_event)
    }

    pub fn new_device_state_event(device_state_event: DeviceStateEvent) -> Self {
        Self::DeviceStateEvent(device_state_event)
    }

    pub fn new_pairing_sas_event(pairing_sas_event: PairingSasEvent) -> Self {
        Self::PairingSasEvent(pairing_sas_event)
    }

    pub fn new_transfer_progress_event(transfer_progress_event: TransferProgressEvent) -> Self {
        Self::TransferProgressEvent(transfer_progress_event)
    }

    pub fn new_transfer_done_event(transfer_done_event: TransferDoneEvent) -> Self {
        Self::TransferDoneEvent(transfer_done_event)
    }

    pub fn new_transfer_failed_event(transfer_failed_event: TransferFailedEvent) -> Self {
        Self::TransferFailedEvent(transfer_failed_event)
    }

    pub fn new_inbox_received_event(inbox_received_event: InboxReceivedEvent) -> Self {
        Self::InboxReceivedEvent(inbox_received_event)
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct IpcMessage {
    pub v: u64,
    pub msg: IpcRequestOrIpcResponseOrIpcEvent,
    #[serde(with = "crate::generated::any_cbor::natural_any_cbor_opt_btreemap")]
    #[serde(default)]
    #[schemars(schema_with = "crate::generated::any_cbor::natural_any_cbor_map_schema")]
    pub extensions: Option<Extensions>,
}

impl IpcMessage {
    pub fn new(v: u64, msg: IpcRequestOrIpcResponseOrIpcEvent) -> Self {
        Self {
            v,
            msg,
            extensions: None,
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub enum IpcRequest {
    StartRequest(StartRequest),
    SubscribeRequest(SubscribeRequest),
    DevicesRequest(DevicesRequest),
    PairRequest(PairRequest),
    SendRequest(SendRequest),
    CancelRequest(CancelRequest),
    RetryRequest(RetryRequest),
    ListTransfersRequest(ListTransfersRequest),
    ListInboxRequest(ListInboxRequest),
    SetDisplayNameRequest(SetDisplayNameRequest),
    SetPresenceRequest(SetPresenceRequest),
    ShutdownRequest(ShutdownRequest),
}

impl IpcRequest {
    pub fn new_start_request(start_request: StartRequest) -> Self {
        Self::StartRequest(start_request)
    }

    pub fn new_subscribe_request(subscribe_request: SubscribeRequest) -> Self {
        Self::SubscribeRequest(subscribe_request)
    }

    pub fn new_devices_request(devices_request: DevicesRequest) -> Self {
        Self::DevicesRequest(devices_request)
    }

    pub fn new_pair_request(pair_request: PairRequest) -> Self {
        Self::PairRequest(pair_request)
    }

    pub fn new_send_request(send_request: SendRequest) -> Self {
        Self::SendRequest(send_request)
    }

    pub fn new_cancel_request(cancel_request: CancelRequest) -> Self {
        Self::CancelRequest(cancel_request)
    }

    pub fn new_retry_request(retry_request: RetryRequest) -> Self {
        Self::RetryRequest(retry_request)
    }

    pub fn new_list_transfers_request(list_transfers_request: ListTransfersRequest) -> Self {
        Self::ListTransfersRequest(list_transfers_request)
    }

    pub fn new_list_inbox_request(list_inbox_request: ListInboxRequest) -> Self {
        Self::ListInboxRequest(list_inbox_request)
    }

    pub fn new_set_display_name_request(set_display_name_request: SetDisplayNameRequest) -> Self {
        Self::SetDisplayNameRequest(set_display_name_request)
    }

    pub fn new_set_presence_request(set_presence_request: SetPresenceRequest) -> Self {
        Self::SetPresenceRequest(set_presence_request)
    }

    pub fn new_shutdown_request(shutdown_request: ShutdownRequest) -> Self {
        Self::ShutdownRequest(shutdown_request)
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub enum IpcRequestOrIpcResponseOrIpcEvent {
    IpcRequest(IpcRequest),
    IpcResponse(IpcResponse),
    IpcEvent(IpcEvent),
}

impl IpcRequestOrIpcResponseOrIpcEvent {
    pub fn new_ipc_request(ipc_request: IpcRequest) -> Self {
        Self::IpcRequest(ipc_request)
    }

    pub fn new_ipc_response(ipc_response: IpcResponse) -> Self {
        Self::IpcResponse(ipc_response)
    }

    pub fn new_ipc_event(ipc_event: IpcEvent) -> Self {
        Self::IpcEvent(ipc_event)
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub enum IpcResponse {
    OkResponse(OkResponse),
    ErrorResponse(ErrorResponse),
    JsonResponse(JsonResponse),
    PortResponse(PortResponse),
}

impl IpcResponse {
    pub fn new_ok_response(ok_response: OkResponse) -> Self {
        Self::OkResponse(ok_response)
    }

    pub fn new_error_response(error_response: ErrorResponse) -> Self {
        Self::ErrorResponse(error_response)
    }

    pub fn new_json_response(json_response: JsonResponse) -> Self {
        Self::JsonResponse(json_response)
    }

    pub fn new_port_response(port_response: PortResponse) -> Self {
        Self::PortResponse(port_response)
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct JsonArgs {
    pub value: String,
}

impl JsonArgs {
    pub fn new(value: String) -> Self {
        Self { value }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct JsonResponse {
    pub json: JsonArgs,
}

impl JsonResponse {
    pub fn new(json: JsonArgs) -> Self {
        Self { json }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub enum ListInboxRequest {
    ValueText4C697374496E626F78,
}

impl ListInboxRequest {
    pub fn new_value_text4_c697374496_e626_f78() -> Self {
        Self::ValueText4C697374496E626F78
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub enum ListTransfersRequest {
    ValueText4C6973745472616E7366657273,
}

impl ListTransfersRequest {
    pub fn new_value_text4_c6973745472616_e7366657273() -> Self {
        Self::ValueText4C6973745472616E7366657273
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub enum OkResponse {
    ValueText4F6B,
}

impl OkResponse {
    pub fn new_value_text4_f6_b() -> Self {
        Self::ValueText4F6B
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct PairArgs {
    pub addr: String,
    pub bundle_cbor: Vec<u8>,
}

impl PairArgs {
    pub fn new(addr: String, bundle_cbor: Vec<u8>) -> Self {
        Self { addr, bundle_cbor }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct PairRequest {
    pub pair: PairArgs,
}

impl PairRequest {
    pub fn new(pair: PairArgs) -> Self {
        Self { pair }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct PairingSasArgs {
    pub peer_device_id: String,
    pub sas: String,
}

impl PairingSasArgs {
    pub fn new(peer_device_id: String, sas: String) -> Self {
        Self {
            peer_device_id,
            sas,
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct PairingSasEvent {
    pub pairing_sas: PairingSasArgs,
}

impl PairingSasEvent {
    pub fn new(pairing_sas: PairingSasArgs) -> Self {
        Self { pairing_sas }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct PortArgs {
    pub port: u64,
}

impl PortArgs {
    pub fn new(port: u64) -> Self {
        Self { port }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct PortResponse {
    pub port: PortArgs,
}

impl PortResponse {
    pub fn new(port: PortArgs) -> Self {
        Self { port }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct RetryRequest {
    pub retry: TransferRef,
}

impl RetryRequest {
    pub fn new(retry: TransferRef) -> Self {
        Self { retry }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct SendArgs {
    pub peer_device_id: String,
    pub text: Option<String>,
    pub files: Vec<String>,
}

impl SendArgs {
    pub fn new(peer_device_id: String, text: Option<String>, files: Vec<String>) -> Self {
        Self {
            peer_device_id,
            text,
            files,
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct SendRequest {
    pub send: SendArgs,
}

impl SendRequest {
    pub fn new(send: SendArgs) -> Self {
        Self { send }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct SetDisplayNameRequest {
    pub set_display_name: DisplayNameArgs,
}

impl SetDisplayNameRequest {
    pub fn new(set_display_name: DisplayNameArgs) -> Self {
        Self { set_display_name }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct SetPresenceArgs {
    pub state: String,
}

impl SetPresenceArgs {
    pub fn new(state: String) -> Self {
        Self { state }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct SetPresenceRequest {
    pub set_presence: SetPresenceArgs,
}

impl SetPresenceRequest {
    pub fn new(set_presence: SetPresenceArgs) -> Self {
        Self { set_presence }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub enum ShutdownRequest {
    ValueText53687574646F776E,
}

impl ShutdownRequest {
    pub fn new_value_text53687574646_f776_e() -> Self {
        Self::ValueText53687574646F776E
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct StartArgs {
    pub data_dir: String,
    pub display_name: String,
    pub listen_port: u64,
}

impl StartArgs {
    pub fn new(data_dir: String, display_name: String, listen_port: u64) -> Self {
        Self {
            data_dir,
            display_name,
            listen_port,
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct StartRequest {
    pub start: StartArgs,
}

impl StartRequest {
    pub fn new(start: StartArgs) -> Self {
        Self { start }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub enum SubscribeRequest {
    ValueText537562736372696265,
}

impl SubscribeRequest {
    pub fn new_value_text537562736372696265() -> Self {
        Self::ValueText537562736372696265
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct TransferDoneEvent {
    pub transfer_done: TransferRef,
}

impl TransferDoneEvent {
    pub fn new(transfer_done: TransferRef) -> Self {
        Self { transfer_done }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct TransferFailedArgs {
    pub transfer_id: String,
    pub error: String,
}

impl TransferFailedArgs {
    pub fn new(transfer_id: String, error: String) -> Self {
        Self { transfer_id, error }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct TransferFailedEvent {
    pub transfer_failed: TransferFailedArgs,
}

impl TransferFailedEvent {
    pub fn new(transfer_failed: TransferFailedArgs) -> Self {
        Self { transfer_failed }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct TransferProgressArgs {
    pub transfer_id: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

impl TransferProgressArgs {
    pub fn new(transfer_id: String, bytes_done: u64, bytes_total: u64) -> Self {
        Self {
            transfer_id,
            bytes_done,
            bytes_total,
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct TransferProgressEvent {
    pub transfer_progress: TransferProgressArgs,
}

impl TransferProgressEvent {
    pub fn new(transfer_progress: TransferProgressArgs) -> Self {
        Self { transfer_progress }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct TransferRef {
    pub transfer_id: String,
}

impl TransferRef {
    pub fn new(transfer_id: String) -> Self {
        Self { transfer_id }
    }
}
