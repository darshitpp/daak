use daak_core::thread::{ThreadItem, ThreadPage};
use daak_ffi::thread_page_json;

fn item(text: Option<&str>, outbound: bool) -> ThreadItem {
    ThreadItem {
        transfer_id: [0xab; 16],
        item_index: 2,
        outbound,
        is_text: text.is_some(),
        name: if text.is_some() {
            None
        } else {
            Some("a.pdf".into())
        },
        size: if text.is_some() { None } else { Some(10) },
        text: text.map(str::to_string),
        state: "done".into(),
        dest_path: None,
        at: 123,
        transfer_state: "done".into(),
        error: None,
    }
}

#[test]
fn json_has_the_documented_keys_and_nulls() {
    let p = ThreadPage {
        items: vec![item(Some("hi"), true), item(None, false)],
        older_cursor: Some("5:00".into()),
    };
    let v = thread_page_json(&p);
    assert_eq!(v["olderCursor"], "5:00");
    let a = &v["items"][0];
    assert_eq!(a["transferId"], "ab".repeat(16));
    assert_eq!(a["itemIndex"], 2);
    assert_eq!(a["direction"], "out");
    assert_eq!(a["type"], "text");
    assert_eq!(a["text"], "hi");
    assert!(a["name"].is_null() && a["size"].is_null() && a["destPath"].is_null());
    assert_eq!(a["at"], 123);
    assert_eq!(a["transferState"], "done");
    assert!(a["error"].is_null());
    let b = &v["items"][1];
    assert_eq!(b["direction"], "in");
    assert_eq!(b["type"], "file");
    assert_eq!(b["name"], "a.pdf");
    assert_eq!(b["size"], 10);
    assert!(b["text"].is_null());
}

#[test]
fn a_one_mebibyte_non_ascii_body_survives_serialization() {
    let body = "é🌍".repeat(200_000);
    let p = ThreadPage {
        items: vec![item(Some(&body), true)],
        older_cursor: None,
    };
    let s = serde_json::to_string(&thread_page_json(&p)).unwrap();
    let back: serde_json::Value = serde_json::from_str(&s).unwrap();
    assert_eq!(back["items"][0]["text"], body.as_str());
    assert!(back["olderCursor"].is_null());
}

fn key_fixture() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/core/test/fixtures/thread-page-keys.json");
    let raw = std::fs::read_to_string(path).expect("shared key fixture must exist");
    serde_json::from_str(&raw).expect("fixture is JSON")
}

fn keys_of(v: &serde_json::Value) -> Vec<String> {
    let mut keys: Vec<String> = v
        .as_object()
        .expect("a JSON object")
        .keys()
        .cloned()
        .collect();
    keys.sort();
    keys
}

fn pinned(v: &serde_json::Value) -> Vec<String> {
    let mut keys: Vec<String> = v
        .as_array()
        .expect("an array of keys")
        .iter()
        .map(|k| k.as_str().expect("a key is a string").to_string())
        .collect();
    keys.sort();
    keys
}

// The daakd and daak-core page builders must produce the same item keys as
// this one. The shared fixture pins all three.
#[test]
fn item_keys_match_the_pinned_list() {
    let fx = key_fixture();
    let p = ThreadPage {
        items: vec![item(Some("hi"), true)],
        older_cursor: Some("5:00".into()),
    };
    let v = thread_page_json(&p);
    assert_eq!(keys_of(&v["items"][0]), pinned(&fx["itemKeys"]));
    assert_eq!(keys_of(&v), pinned(&fx["pageKeys"]));
}
