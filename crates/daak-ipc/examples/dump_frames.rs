// Prints the exact bytes daak_ipc::write_message emits, so the hex fixtures in
// packages/core/test/transport.spec.ts are copied from the real encoder rather
// than hand-computed. Run: cargo run -p daak-ipc --example dump_frames
use daak_ipc::{IpcEvent, IpcMessage, IpcRequest, IpcResponse};
use std::io::Write;

fn main() {
    let msgs = [
        IpcMessage::Request(IpcRequest::Subscribe),
        IpcMessage::Response(IpcResponse::Ok),
        IpcMessage::Response(IpcResponse::Error {
            message: "unimplemented".into(),
        }),
        IpcMessage::Event(IpcEvent::InboxReceived {
            payload_json: "{\"a\":1}".into(),
        }),
        // Pair is the only frame carrying raw bytes: bundle_cbor must land on
        // the wire as a CBOR bstr, which serde will NOT do for a bare Vec<u8>.
        IpcMessage::Request(IpcRequest::Pair {
            addr: "10.0.0.2:9000".into(),
            bundle_cbor: vec![1, 2, 3],
        }),
    ];
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let mut out = std::io::stdout();
    for m in msgs {
        let mut buf = Vec::new();
        rt.block_on(daak_ipc::write_message(&mut buf, &m)).unwrap();
        let hex: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        writeln!(out, "{hex}").unwrap();
    }
}
