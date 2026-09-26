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
