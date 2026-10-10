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
