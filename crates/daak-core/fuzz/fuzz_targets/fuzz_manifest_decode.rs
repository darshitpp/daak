#![no_main]

use daak_core::manifest::Manifest;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = Manifest::from_cbor(data);
});
