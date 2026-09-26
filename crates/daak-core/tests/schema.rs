use ciborium::value::Value as V;
use daak_core::manifest::{DeviceRef, Item, ItemType, Manifest, PayloadKind};

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

#[test]
fn unknown_item_type_is_preserved_not_rejected() {
    let item = V::Map(vec![
        (V::Text("index".into()), V::Integer(0.into())),
        (V::Text("type".into()), V::Text("hologram".into())),
    ]);
    let sender = V::Map(vec![
        (V::Text("device_id".into()), V::Bytes(vec![0u8; 16])),
        (V::Text("name".into()), V::Text("a".into())),
    ]);
    let manifest = V::Map(vec![
        (V::Text("v".into()), V::Integer(1.into())),
        (V::Text("payload_id".into()), V::Bytes(vec![0u8; 16])),
        (V::Text("kind".into()), V::Text("batch".into())),
        (V::Text("created_at".into()), V::Integer(0.into())),
        (V::Text("sender".into()), sender),
        (V::Text("items".into()), V::Array(vec![item])),
    ]);
    let mut buf = Vec::new();
    ciborium::ser::into_writer(&manifest, &mut buf).unwrap();

    let m = Manifest::from_cbor(&buf).unwrap();
    assert_eq!(m.items[0].item_type, ItemType::Custom("hologram".into()));
    assert_eq!(m.unsupported_items().len(), 1);
    assert!(Manifest::text("x").unsupported_items().is_empty());

    let back = Manifest::from_cbor(&m.to_cbor().unwrap()).unwrap();
    assert_eq!(back.items[0].item_type, ItemType::Custom("hologram".into()));
}

#[test]
fn nested_children_folder_round_trips() {
    let mut folder = Item::folder(0, "album");
    let mut sub = Item::folder(0, "sub");
    sub.children.push(Item::text(0, "note"));
    folder.children.push(sub);
    let m = Manifest::new(
        PayloadKind::Batch,
        DeviceRef {
            device_id: [2u8; 16],
            name: "b".into(),
        },
        vec![folder],
    );
    let back = Manifest::from_cbor(&m.to_cbor().unwrap()).unwrap();
    assert_eq!(back, m);
}

#[test]
fn children_and_reply_to_validate_against_cddl() {
    let cddl_src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto/payload.cddl"),
    )
    .unwrap();

    let mut folder = Item::folder(0, "album");
    folder.children.push(Item::text(0, "note"));
    let mut m = Manifest::new(
        PayloadKind::Batch,
        DeviceRef {
            device_id: [3u8; 16],
            name: "c".into(),
        },
        vec![folder],
    );
    m.reply_to = Some([4u8; 16]);
    m.items[0].reply_to = Some([5u8; 16]);

    cddl::validate_cbor_from_slice(&cddl_src, &m.to_cbor().unwrap(), None)
        .unwrap_or_else(|e| panic!("folder + reply_to failed CDDL: {e:?}"));

    let bytes = m.to_cbor().unwrap();
    let value: V = ciborium::de::from_reader(bytes.as_slice()).unwrap();
    let items = match map_get(&value, "items") {
        V::Array(a) => a,
        other => panic!("expected items array, got {other:?}"),
    };
    let item_reply_to = map_get(&items[0], "reply_to");
    assert!(
        matches!(item_reply_to, V::Bytes(b) if b.len() == 16),
        "item reply_to must be a 16-byte CBOR bstr, got {item_reply_to:?}"
    );
}

fn map_get<'a>(value: &'a V, key: &str) -> &'a V {
    match value {
        V::Map(entries) => entries
            .iter()
            .find(|(k, _)| matches!(k, V::Text(t) if t == key))
            .map(|(_, v)| v)
            .unwrap_or_else(|| panic!("missing key {key}")),
        other => panic!("expected map, got {other:?}"),
    }
}

#[test]
fn item_missing_required_type_field_is_rejected() {
    let item = V::Map(vec![(V::Text("index".into()), V::Integer(0.into()))]);
    let sender = V::Map(vec![
        (V::Text("device_id".into()), V::Bytes(vec![0u8; 16])),
        (V::Text("name".into()), V::Text("a".into())),
    ]);
    let manifest = V::Map(vec![
        (V::Text("v".into()), V::Integer(1.into())),
        (V::Text("payload_id".into()), V::Bytes(vec![0u8; 16])),
        (V::Text("kind".into()), V::Text("batch".into())),
        (V::Text("created_at".into()), V::Integer(0.into())),
        (V::Text("sender".into()), sender),
        (V::Text("items".into()), V::Array(vec![item])),
    ]);
    let mut buf = Vec::new();
    ciborium::ser::into_writer(&manifest, &mut buf).unwrap();

    assert!(
        Manifest::from_cbor(&buf).is_err(),
        "item without required `type` must not decode"
    );
}

#[test]
fn folder_and_unknown_items_are_not_binary_items() {
    let m = Manifest::new(
        PayloadKind::Batch,
        DeviceRef {
            device_id: [4u8; 16],
            name: "d".into(),
        },
        vec![
            Item::folder(0, "album"),
            Item {
                index: 1,
                item_type: ItemType::Custom("hologram".into()),
                ..Item::default()
            },
        ],
    );
    assert_eq!(m.binary_items().count(), 0);
    assert_eq!(Manifest::text("x").binary_items().count(), 0);

    let mut with_doc = m.clone();
    with_doc
        .items
        .push(Item::from_file(2, &write_tmp(), 1024 * 1024).unwrap());
    assert_eq!(with_doc.binary_items().count(), 1);
}
