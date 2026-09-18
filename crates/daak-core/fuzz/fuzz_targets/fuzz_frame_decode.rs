#![no_main]

use bytes::BytesMut;
use daak_core::framing::{decode_frame, DEFAULT_MAX_FRAME};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let mut buf = BytesMut::from(data);
    let _ = decode_frame(&mut buf, DEFAULT_MAX_FRAME);
});
