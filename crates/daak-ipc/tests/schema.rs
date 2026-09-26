// proto/ipc.cddl is the schema source of truth. cddl-codegen cannot produce
// the Rust types from it (its output re-tags the externally-tagged serde enums
// as {"StartRequest": {"start": ..}} and stringifies unit variants as
// "ValueText44657669636573", which is not the byte-verified wire), so the enums
// are hand-written serde derives and this test is what keeps them honest:
// real emitted bytes must validate against the CDDL.

use daak_ipc::{IpcEvent, IpcFrame, IpcMessage, IpcRequest, IpcResponse, IPC_VERSION};

fn cddl_src() -> String {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto/ipc.cddl"),
    )
    .unwrap()
}

fn frame_body(msg: &IpcMessage) -> Vec<u8> {
    let mut body = Vec::new();
    ciborium::ser::into_writer(
        &IpcFrame {
            v: IPC_VERSION,
            msg: msg.clone(),
        },
        &mut body,
    )
    .unwrap();
    body
}

fn assert_valid(msg: &IpcMessage) {
    let body = frame_body(msg);
    cddl::validate_cbor_from_slice(&cddl_src(), &body, None)
        .unwrap_or_else(|e| panic!("{msg:?} does not match proto/ipc.cddl: {e:?}"));
}

#[test]
fn every_request_validates_against_the_cddl() {
    let msgs = [
        IpcMessage::Request(IpcRequest::Start {
            data_dir: "/tmp/d".into(),
            display_name: "daak".into(),
            listen_port: 9000,
        }),
        IpcMessage::Request(IpcRequest::Subscribe),
        IpcMessage::Request(IpcRequest::Devices),
        IpcMessage::Request(IpcRequest::Pair {
            addr: "10.0.0.2:9000".into(),
            bundle_cbor: vec![1, 2, 3],
        }),
        IpcMessage::Request(IpcRequest::Send {
            peer_device_id: "00".repeat(16),
            text: Some("hi".into()),
            files: vec!["/tmp/a".into()],
        }),
        IpcMessage::Request(IpcRequest::Send {
            peer_device_id: "00".repeat(16),
            text: None,
            files: vec![],
        }),
        IpcMessage::Request(IpcRequest::Cancel {
            transfer_id: "t1".into(),
        }),
        IpcMessage::Request(IpcRequest::Retry {
            transfer_id: "t1".into(),
        }),
        IpcMessage::Request(IpcRequest::ListTransfers),
        IpcMessage::Request(IpcRequest::ListInbox),
        IpcMessage::Request(IpcRequest::SetDisplayName {
            name: "renamed".into(),
        }),
        IpcMessage::Request(IpcRequest::SetPresence {
            state: "away".into(),
        }),
        IpcMessage::Request(IpcRequest::Shutdown),
    ];
    for m in &msgs {
        assert_valid(m);
    }
}

#[test]
fn every_response_validates_against_the_cddl() {
    for m in [
        IpcMessage::Response(IpcResponse::Ok),
        IpcMessage::Response(IpcResponse::Error {
            message: "boom".into(),
        }),
        IpcMessage::Response(IpcResponse::Json { value: "[]".into() }),
        IpcMessage::Response(IpcResponse::Port { port: 9000 }),
        IpcMessage::Response(IpcResponse::UpdateRequired { min_major: 1 }),
    ] {
        assert_valid(&m);
    }
}

#[test]
fn every_event_validates_against_the_cddl() {
    for m in [
        IpcMessage::Event(IpcEvent::DeviceFound {
            device_id: "d1".into(),
            name: "peer".into(),
            addr: "10.0.0.2:9000".into(),
        }),
        IpcMessage::Event(IpcEvent::DeviceState {
            device_id: "d1".into(),
            online: true,
        }),
        IpcMessage::Event(IpcEvent::PairingSas {
            peer_device_id: "d1".into(),
            sas: "1-2-3".into(),
        }),
        IpcMessage::Event(IpcEvent::TransferProgress {
            transfer_id: "t1".into(),
            bytes_done: 5,
            bytes_total: 10,
        }),
        IpcMessage::Event(IpcEvent::TransferItem {
            transfer_id: "t1".into(),
            item_index: 1,
            state: "receiving".into(),
            dest_path: "/tmp/a".into(),
        }),
        IpcMessage::Event(IpcEvent::TransferDone {
            transfer_id: "t1".into(),
        }),
        IpcMessage::Event(IpcEvent::TransferFailed {
            transfer_id: "t1".into(),
            error: "boom".into(),
        }),
        IpcMessage::Event(IpcEvent::InboxReceived {
            payload_json: "{\"a\":1}".into(),
        }),
    ] {
        assert_valid(&m);
    }
}
