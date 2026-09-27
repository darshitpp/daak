// This file was code-generated using an experimental CDDL to rust tool:
// https://github.com/dcSpark/cddl-codegen

#![allow(
    clippy::too_many_arguments,
    clippy::large_enum_variant,
    clippy::result_large_err
)]

extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;
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

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct EventArm {
    pub event: IpcEvent,
}

impl EventArm {
    pub fn new(event: IpcEvent) -> Self {
        Self { event }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ExportDebugBundleArgs {
    pub path: String,
}

impl ExportDebugBundleArgs {
    pub fn new(path: String) -> Self {
        Self { path }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ExportDebugBundleRequest {
    pub export_debug_bundle: ExportDebugBundleArgs,
}

impl ExportDebugBundleRequest {
    pub fn new(export_debug_bundle: ExportDebugBundleArgs) -> Self {
        Self {
            export_debug_bundle,
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct InboxReceivedArgs {
    pub payload_json: String,
}

impl InboxReceivedArgs {
    pub fn new(payload_json: String) -> Self {
        Self { payload_json }
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
    TransferItemEvent(TransferItemEvent),
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

    pub fn new_transfer_item_event(transfer_item_event: TransferItemEvent) -> Self {
        Self::TransferItemEvent(transfer_item_event)
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
pub struct IpcFrame {
    pub v: u64,
    pub msg: IpcMessage,
}

impl IpcFrame {
    pub fn new(v: u64, msg: IpcMessage) -> Self {
        Self { v, msg }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub enum IpcMessage {
    RequestArm(RequestArm),
    ResponseArm(ResponseArm),
    EventArm(EventArm),
}

impl IpcMessage {
    pub fn new_request_arm(request_arm: RequestArm) -> Self {
        Self::RequestArm(request_arm)
    }

    pub fn new_response_arm(response_arm: ResponseArm) -> Self {
        Self::ResponseArm(response_arm)
    }

    pub fn new_event_arm(event_arm: EventArm) -> Self {
        Self::EventArm(event_arm)
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
    ExportDebugBundleRequest(ExportDebugBundleRequest),
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

    pub fn new_export_debug_bundle_request(
        export_debug_bundle_request: ExportDebugBundleRequest,
    ) -> Self {
        Self::ExportDebugBundleRequest(export_debug_bundle_request)
    }

    pub fn new_shutdown_request(shutdown_request: ShutdownRequest) -> Self {
        Self::ShutdownRequest(shutdown_request)
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub enum IpcResponse {
    OkResponse(OkResponse),
    ErrorResponse(ErrorResponse),
    JsonResponse(JsonResponse),
    PortResponse(PortResponse),
    UpdateRequiredResponse(UpdateRequiredResponse),
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

    pub fn new_update_required_response(update_required_response: UpdateRequiredResponse) -> Self {
        Self::UpdateRequiredResponse(update_required_response)
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
pub struct ListTransfersArgs {
    pub filter: Option<TransferFilter>,
}

impl ListTransfersArgs {
    pub fn new() -> Self {
        Self { filter: None }
    }
}

impl Default for ListTransfersArgs {
    fn default() -> Self {
        Self::new()
    }
}

pub type ListTransfersRequest = ListTransfersArgs;

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
pub struct RequestArm {
    pub request: IpcRequest,
}

impl RequestArm {
    pub fn new(request: IpcRequest) -> Self {
        Self { request }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ResponseArm {
    pub response: IpcResponse,
}

impl ResponseArm {
    pub fn new(response: IpcResponse) -> Self {
        Self { response }
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
pub struct TransferFilter {
    pub state: Option<String>,
    pub peer_device_id: Option<String>,
}

impl TransferFilter {
    pub fn new() -> Self {
        Self {
            state: None,
            peer_device_id: None,
        }
    }
}

impl Default for TransferFilter {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct TransferItemArgs {
    pub transfer_id: String,
    pub item_index: u64,
    pub state: String,
    pub dest_path: String,
}

impl TransferItemArgs {
    pub fn new(transfer_id: String, item_index: u64, state: String, dest_path: String) -> Self {
        Self {
            transfer_id,
            item_index,
            state,
            dest_path,
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct TransferItemEvent {
    pub transfer_item: TransferItemArgs,
}

impl TransferItemEvent {
    pub fn new(transfer_item: TransferItemArgs) -> Self {
        Self { transfer_item }
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

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct UpdateRequiredArgs {
    pub min_major: u64,
}

impl UpdateRequiredArgs {
    pub fn new(min_major: u64) -> Self {
        Self { min_major }
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct UpdateRequiredResponse {
    pub update_required: UpdateRequiredArgs,
}

impl UpdateRequiredResponse {
    pub fn new(update_required: UpdateRequiredArgs) -> Self {
        Self { update_required }
    }
}
