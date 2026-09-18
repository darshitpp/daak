# daak-core fuzz targets

LibFuzzer targets that feed raw bytes to the two parser surfaces most exposed
to untrusted LAN peers: the wire-frame decoder and the CBOR manifest decoder.
Neither target asserts anything; a crash (panic, OOM, etc.) is the finding.

## Targets

- fuzz_frame_decode: raw bytes into daak_core::framing::decode_frame.
- fuzz_manifest_decode: raw bytes into daak_core::manifest::Manifest::from_cbor.

## Running

    cargo +nightly fuzz run fuzz_frame_decode
    cargo +nightly fuzz run fuzz_manifest_decode

## Requirements

- A nightly Rust toolchain with cargo-fuzz installed (cargo install cargo-fuzz).
- A C/C++ toolchain with the libc++/libstdc++ standard-library headers.
  libfuzzer-sys will not compile without them (for example, bare macOS
  Command Line Tools fail on #include <cassert>).

## CI-runnable equivalent

The fuzzers are excluded from the workspace, so they do not run under
cargo test. The property-test suite covering the same invariants is
CI-runnable with:

    cargo test -p daak-core --test props
