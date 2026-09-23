use daak_core::manifest::{DeviceRef, Item, Manifest, PayloadKind};

#[test]
fn emitted_manifest_validates_against_cddl() {
    let cddl_src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto/payload.cddl"),
    )
    .unwrap();

    let m = Manifest::new(
        PayloadKind::Batch,
        DeviceRef {
            device_id: [1u8; 16],
            name: "a".into(),
        },
        vec![
            Item::text(0, "hi"),
            Item::from_file(1, &write_tmp(), 1024 * 1024).unwrap(),
        ],
    );
    let bytes = m.to_cbor().unwrap();

    // cddl 0.9 has no per-rule validate(rule, &Value); it validates the CBOR
    // slice against the first type rule (payload-manifest) directly.
    cddl::validate_cbor_from_slice(&cddl_src, &bytes, None)
        .unwrap_or_else(|e| panic!("manifest failed CDDL: {e:?}"));
}

fn write_tmp() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("daak-schema-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("blob.bin");
    std::fs::write(&p, b"blob").unwrap();
    p
}
