// This file was code-generated using an experimental CDDL to rust tool:
// https://github.com/dcSpark/cddl-codegen

// Compiled self-check for the dep-side extern-interface export
// (`extern-interface/<dep>/**`). Machine-generated from the SAME projection as that
// export, so the two cannot drift. Every exported name is asserted to be a real,
// correctly-typed surface in THIS crate: opaque rows implement `Serialize` (and
// `Deserialize` where the dep generates one), raw-bytes rows `RawBytesEncoding`, and
// transparent rows (aliases, c-style enums, named collections) must simply exist. A
// hand-edited or stale export — or a projection bug — therefore fails THIS crate's own
// build, naming the type. Do not edit.
// Rows carry NO per-row comments by design: a spec change can delete any row, and a
// comment stranded on a deleted row is what the edit-preservation overlay turns into a
// build-breaking sentinel on the next regen. All commentary lives in this fixed banner;
// each row's type path is its own traceability.
#[allow(dead_code)]
fn _assert_serialize<T: cbor_event::se::Serialize>() {}
#[allow(dead_code)]
fn _assert_deserialize<T: crate::generated::serialization::Deserialize>() {}
#[allow(unused_imports)]
use crate::generated::ListTransfersRequest as _;
#[allow(dead_code)]
fn _extern_interface_self_check() {
    _assert_serialize::<crate::generated::CancelRequest>();
    _assert_deserialize::<crate::generated::CancelRequest>();
    _assert_serialize::<crate::generated::DeviceFoundArgs>();
    _assert_deserialize::<crate::generated::DeviceFoundArgs>();
    _assert_serialize::<crate::generated::DeviceFoundEvent>();
    _assert_deserialize::<crate::generated::DeviceFoundEvent>();
    _assert_serialize::<crate::generated::DeviceStateArgs>();
    _assert_deserialize::<crate::generated::DeviceStateArgs>();
    _assert_serialize::<crate::generated::DeviceStateEvent>();
    _assert_deserialize::<crate::generated::DeviceStateEvent>();
    _assert_serialize::<crate::generated::DevicesRequest>();
    _assert_deserialize::<crate::generated::DevicesRequest>();
    _assert_serialize::<crate::generated::DisplayNameArgs>();
    _assert_deserialize::<crate::generated::DisplayNameArgs>();
    _assert_serialize::<crate::generated::ErrorArgs>();
    _assert_deserialize::<crate::generated::ErrorArgs>();
    _assert_serialize::<crate::generated::ErrorResponse>();
    _assert_deserialize::<crate::generated::ErrorResponse>();
    _assert_serialize::<crate::generated::EventArm>();
    _assert_deserialize::<crate::generated::EventArm>();
    _assert_serialize::<crate::generated::ExportDebugBundleArgs>();
    _assert_deserialize::<crate::generated::ExportDebugBundleArgs>();
    _assert_serialize::<crate::generated::ExportDebugBundleRequest>();
    _assert_deserialize::<crate::generated::ExportDebugBundleRequest>();
    _assert_serialize::<crate::generated::InboxReceivedArgs>();
    _assert_deserialize::<crate::generated::InboxReceivedArgs>();
    _assert_serialize::<crate::generated::InboxReceivedEvent>();
    _assert_deserialize::<crate::generated::InboxReceivedEvent>();
    _assert_serialize::<crate::generated::IpcEvent>();
    _assert_deserialize::<crate::generated::IpcEvent>();
    _assert_serialize::<crate::generated::IpcFrame>();
    _assert_deserialize::<crate::generated::IpcFrame>();
    _assert_serialize::<crate::generated::IpcMessage>();
    _assert_deserialize::<crate::generated::IpcMessage>();
    _assert_serialize::<crate::generated::IpcRequest>();
    _assert_deserialize::<crate::generated::IpcRequest>();
    _assert_serialize::<crate::generated::IpcResponse>();
    _assert_deserialize::<crate::generated::IpcResponse>();
    _assert_serialize::<crate::generated::JsonArgs>();
    _assert_deserialize::<crate::generated::JsonArgs>();
    _assert_serialize::<crate::generated::JsonResponse>();
    _assert_deserialize::<crate::generated::JsonResponse>();
    _assert_serialize::<crate::generated::ListInboxRequest>();
    _assert_deserialize::<crate::generated::ListInboxRequest>();
    _assert_serialize::<crate::generated::ListTransfersArgs>();
    _assert_deserialize::<crate::generated::ListTransfersArgs>();
    _assert_serialize::<crate::generated::OkResponse>();
    _assert_deserialize::<crate::generated::OkResponse>();
    _assert_serialize::<crate::generated::PairArgs>();
    _assert_deserialize::<crate::generated::PairArgs>();
    _assert_serialize::<crate::generated::PairRequest>();
    _assert_deserialize::<crate::generated::PairRequest>();
    _assert_serialize::<crate::generated::PairingSasArgs>();
    _assert_deserialize::<crate::generated::PairingSasArgs>();
    _assert_serialize::<crate::generated::PairingSasEvent>();
    _assert_deserialize::<crate::generated::PairingSasEvent>();
    _assert_serialize::<crate::generated::PortArgs>();
    _assert_deserialize::<crate::generated::PortArgs>();
    _assert_serialize::<crate::generated::PortResponse>();
    _assert_deserialize::<crate::generated::PortResponse>();
    _assert_serialize::<crate::generated::RequestArm>();
    _assert_deserialize::<crate::generated::RequestArm>();
    _assert_serialize::<crate::generated::ResponseArm>();
    _assert_deserialize::<crate::generated::ResponseArm>();
    _assert_serialize::<crate::generated::RetryRequest>();
    _assert_deserialize::<crate::generated::RetryRequest>();
    _assert_serialize::<crate::generated::SendArgs>();
    _assert_deserialize::<crate::generated::SendArgs>();
    _assert_serialize::<crate::generated::SendRequest>();
    _assert_deserialize::<crate::generated::SendRequest>();
    _assert_serialize::<crate::generated::SetDisplayNameRequest>();
    _assert_deserialize::<crate::generated::SetDisplayNameRequest>();
    _assert_serialize::<crate::generated::SetPresenceArgs>();
    _assert_deserialize::<crate::generated::SetPresenceArgs>();
    _assert_serialize::<crate::generated::SetPresenceRequest>();
    _assert_deserialize::<crate::generated::SetPresenceRequest>();
    _assert_serialize::<crate::generated::ShutdownRequest>();
    _assert_deserialize::<crate::generated::ShutdownRequest>();
    _assert_serialize::<crate::generated::StartArgs>();
    _assert_deserialize::<crate::generated::StartArgs>();
    _assert_serialize::<crate::generated::StartRequest>();
    _assert_deserialize::<crate::generated::StartRequest>();
    _assert_serialize::<crate::generated::SubscribeRequest>();
    _assert_deserialize::<crate::generated::SubscribeRequest>();
    _assert_serialize::<crate::generated::TransferDoneEvent>();
    _assert_deserialize::<crate::generated::TransferDoneEvent>();
    _assert_serialize::<crate::generated::TransferFailedArgs>();
    _assert_deserialize::<crate::generated::TransferFailedArgs>();
    _assert_serialize::<crate::generated::TransferFailedEvent>();
    _assert_deserialize::<crate::generated::TransferFailedEvent>();
    _assert_serialize::<crate::generated::TransferFilter>();
    _assert_deserialize::<crate::generated::TransferFilter>();
    _assert_serialize::<crate::generated::TransferItemArgs>();
    _assert_deserialize::<crate::generated::TransferItemArgs>();
    _assert_serialize::<crate::generated::TransferItemEvent>();
    _assert_deserialize::<crate::generated::TransferItemEvent>();
    _assert_serialize::<crate::generated::TransferProgressArgs>();
    _assert_deserialize::<crate::generated::TransferProgressArgs>();
    _assert_serialize::<crate::generated::TransferProgressEvent>();
    _assert_deserialize::<crate::generated::TransferProgressEvent>();
    _assert_serialize::<crate::generated::TransferRef>();
    _assert_deserialize::<crate::generated::TransferRef>();
    _assert_serialize::<crate::generated::UpdateRequiredArgs>();
    _assert_deserialize::<crate::generated::UpdateRequiredArgs>();
    _assert_serialize::<crate::generated::UpdateRequiredResponse>();
    _assert_deserialize::<crate::generated::UpdateRequiredResponse>();
}
