// The thread of one paired device: each item sent to it or received from it.
//
// The manifest blob on the transfers row is the source of the item list.
// Both directions keep it, and it holds the text body of a text item.
// The transfer_items table is only an overlay: the receiver writes a row for
// each inbound item, but the sender writes one only for a quarantined item.
// A row, when present, gives the real state and dest path. Without a row,
// the state comes from the state of the whole transfer.
use crate::error::{CoreError, Result};
use crate::manifest::{ItemType, Manifest};
use crate::store::transfers::{ItemRow, TransferRow};
use crate::store::Db;

// A page never holds more than this many transfers.
pub const THREAD_MAX_LIMIT: u32 = 200;

// A page never holds more than this many manifest bytes, except that it always
// holds 1 transfer. The daemon frame limit is 4 MiB, and the JSON of a page is
// larger than its manifests, so the budget is half of it.
pub const THREAD_PAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadItem {
    pub transfer_id: [u8; 16],
    pub item_index: u32,
    pub outbound: bool,
    pub is_text: bool,
    pub name: Option<String>,
    pub size: Option<u64>,
    pub text: Option<String>,
    // One of the 6 item states. received is not a state.
    pub state: String,
    pub dest_path: Option<String>,
    // transfers.created_at, unix seconds.
    pub at: i64,
    // transfers.state. The UI reads it to show Waiting to send.
    pub transfer_state: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadPage {
    // Oldest first, so a screen can append.
    pub items: Vec<ThreadItem>,
    // Pass back as before to read the next older page. None at the end.
    pub older_cursor: Option<String>,
}

// Format: created_at, a colon, then the transfer id in hex.
pub fn encode_cursor(created_at: i64, id: &[u8; 16]) -> String {
    format!("{created_at}:{}", hex::encode(id))
}

// A malformed cursor is an error. It must never read as no cursor, because
// that would silently return the first page again.
pub fn parse_cursor(s: &str) -> Result<(i64, [u8; 16])> {
    let bad = || CoreError::Protocol(format!("bad thread cursor {s:?}"));
    let (at, id) = s.split_once(':').ok_or_else(bad)?;
    let at: i64 = at.parse().map_err(|_| bad())?;
    let id: [u8; 16] = hex::decode(id)
        .map_err(|_| bad())?
        .try_into()
        .map_err(|_| bad())?;
    Ok((at, id))
}

// The item state when no transfer_items row exists.
fn derive_state(outbound: bool, transfer_state: &str) -> &'static str {
    match (outbound, transfer_state) {
        (_, "done") => "done",
        (_, "failed") | (_, "canceled") => "failed",
        (true, _) => "pending",
        (false, _) => "receiving",
    }
}

pub fn list_thread(
    db: &Db,
    peer: &[u8; 16],
    limit: u32,
    before: Option<&str>,
) -> Result<ThreadPage> {
    // Parse the cursor first, so a bad cursor fails even when limit is 0.
    let after = before.map(parse_cursor).transpose()?;
    let limit = limit.min(THREAD_MAX_LIMIT);
    if limit == 0 {
        return Ok(ThreadPage {
            items: Vec::new(),
            older_cursor: None,
        });
    }
    let mut rows = db.list_peer_transfers_page(peer, after, limit + 1)?;
    let mut has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    // Expand rows into their wire items, newest first, and STOP at the byte
    // budget. The budget must bound the JSON the reader RECEIVES, not the raw
    // manifests: the JSON of a page is larger than its manifests (field names,
    // hex ids), so counting manifests let a page overrun the daemon frame.
    // Always keep 1 row, and do not expand a row past the budget.
    let mut groups: Vec<Vec<ThreadItem>> = Vec::with_capacity(rows.len());
    let mut used = 0usize;
    for t in &rows {
        let mut one = Vec::new();
        expand(db, t, &mut one)?;
        let cost = page_json_len(&one);
        if !groups.is_empty() && used + cost > THREAD_PAGE_BYTES {
            break;
        }
        used += cost;
        groups.push(one);
    }
    let keep = groups.len();
    if keep < rows.len() {
        rows.truncate(keep);
        has_more = true;
    }
    let older_cursor = match (has_more, rows.last()) {
        (true, Some(last)) => Some(encode_cursor(last.created_at, &last.transfer_id)),
        _ => None,
    };
    // Oldest first, so a screen can append. The query order is newest first.
    groups.reverse();
    let items: Vec<ThreadItem> = groups.into_iter().flatten().collect();
    Ok(ThreadPage {
        items,
        older_cursor,
    })
}
// A single transfer whose manifest alone exceeds the frame still fails on the
// daemon path. The manifest has no size cap today, and this plan adds none.

/// The byte size of the wire JSON for a run of items, EXCLUDING the page
/// envelope. `list_thread` uses it to bound a page by the JSON the reader
/// receives, not by the manifest bytes. It mirrors `thread_page_json` in
/// daakd/daak-ffi: the same keys and the same null-for-None rule.
fn page_json_len(items: &[ThreadItem]) -> usize {
    let v: Vec<serde_json::Value> = items
        .iter()
        .map(|i| {
            serde_json::json!({
                "transferId": hex::encode(i.transfer_id),
                "itemIndex": i.item_index,
                "direction": if i.outbound { "out" } else { "in" },
                "type": if i.is_text { "text" } else { "file" },
                "name": i.name,
                "size": i.size,
                "text": i.text,
                "state": i.state,
                "destPath": i.dest_path,
                "at": i.at,
                "transferState": i.transfer_state,
                "error": i.error,
            })
        })
        .collect();
    serde_json::Value::Array(v).to_string().len()
}

fn expand(db: &Db, t: &TransferRow, out: &mut Vec<ThreadItem>) -> Result<()> {
    let outbound = t.direction == "out";
    let overlay: Vec<ItemRow> = db.list_items(&t.transfer_id)?;
    let find = |idx: u32| overlay.iter().find(|r| r.item_index == idx);
    let make = |index: u32,
                is_text: bool,
                name: Option<String>,
                size: Option<u64>,
                text: Option<String>| {
        let row = find(index);
        ThreadItem {
            transfer_id: t.transfer_id,
            item_index: index,
            outbound,
            is_text,
            name,
            size,
            text,
            state: row
                .map(|r| r.state.clone())
                .unwrap_or_else(|| derive_state(outbound, &t.state).to_string()),
            dest_path: row.and_then(|r| r.dest_path.clone()),
            at: t.created_at,
            transfer_state: t.state.clone(),
            error: t.error.clone(),
        }
    };
    match Manifest::from_cbor(&t.manifest) {
        Ok(m) => {
            for i in &m.items {
                let is_text = matches!(i.item_type, ItemType::Text);
                out.push(make(
                    i.index,
                    is_text,
                    i.name.clone(),
                    i.size,
                    i.text.clone(),
                ));
            }
        }
        // A manifest that does not parse must not fail the whole page. The
        // item rows, if any, still say what exists. The text body is lost.
        Err(_) => {
            for r in &overlay {
                out.push(make(
                    r.item_index,
                    r.item_type == "text",
                    r.name.clone(),
                    r.size,
                    None,
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{DeviceRef, Item, ItemType, Manifest, PayloadKind};
    use crate::store::transfers::{ItemRow, TransferRow};

    fn manifest(items: Vec<Item>) -> Manifest {
        Manifest::new(
            PayloadKind::Text,
            DeviceRef {
                device_id: [0u8; 16],
                name: "x".into(),
            },
            items,
        )
    }

    fn file(index: u32, name: &str, size: u64) -> Item {
        Item {
            index,
            item_type: ItemType::Document,
            name: Some(name.into()),
            size: Some(size),
            ..Default::default()
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn put(db: &Db, id: u8, peer: u8, dir: &str, state: &str, at: i64, manifest: Vec<u8>, n: u32) {
        db.upsert_transfer(&TransferRow {
            transfer_id: [id; 16],
            payload_id: [id; 16],
            peer_device_id: [peer; 16],
            direction: dir.into(),
            kind: "media".into(),
            state: state.into(),
            bytes_total: 0,
            bytes_done: 0,
            item_count: n,
            created_at: at,
            updated_at: at,
            manifest,
            error: None,
        })
        .unwrap();
    }

    fn db() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db
    }

    // The exact wire JSON daakd/ffi build for a page (thread_page_json): the
    // envelope around the shared item JSON the production cap measures.
    fn whole_page_json_len(page: &ThreadPage) -> usize {
        let v = serde_json::json!({
            "items": page.items.iter().map(|i| serde_json::json!({
                "transferId": hex::encode(i.transfer_id),
                "itemIndex": i.item_index,
                "direction": if i.outbound { "out" } else { "in" },
                "type": if i.is_text { "text" } else { "file" },
                "name": i.name,
                "size": i.size,
                "text": i.text,
                "state": i.state,
                "destPath": i.dest_path,
                "at": i.at,
                "transferState": i.transfer_state,
                "error": i.error,
            })).collect::<Vec<_>>(),
            "olderCursor": page.older_cursor,
        });
        v.to_string().len()
    }

    #[test]
    fn empty_peer_returns_an_empty_page() {
        let page = list_thread(&db(), &[3u8; 16], 50, None).unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.older_cursor, None);
    }

    #[test]
    fn outbound_text_and_file_come_from_the_manifest() {
        let db = db();
        let m = manifest(vec![
            Item::text(0, "h\u{e9}llo \u{1f30d}"),
            file(1, "a.pdf", 10),
        ]);
        put(&db, 1, 3, "out", "queued", 100, m.to_cbor().unwrap(), 2);
        let page = list_thread(&db, &[3u8; 16], 50, None).unwrap();
        assert_eq!(page.items.len(), 2);
        let t = &page.items[0];
        assert!(t.outbound && t.is_text);
        assert_eq!(t.text.as_deref(), Some("h\u{e9}llo \u{1f30d}"));
        assert_eq!(t.name, None);
        assert_eq!(t.state, "pending");
        assert_eq!(t.transfer_state, "queued");
        let f = &page.items[1];
        assert!(!f.is_text);
        assert_eq!(f.name.as_deref(), Some("a.pdf"));
        assert_eq!(f.size, Some(10));
        assert_eq!(f.text, None);
    }

    #[test]
    fn an_item_row_overrides_the_derived_state_and_dest_path() {
        let db = db();
        let m = manifest(vec![file(0, "a.jpg", 5)]);
        put(&db, 2, 3, "in", "failed", 100, m.to_cbor().unwrap(), 1);
        db.upsert_item(&ItemRow {
            transfer_id: [2u8; 16],
            item_index: 0,
            item_type: "image".into(),
            name: Some("a.jpg".into()),
            mime: None,
            size: Some(5),
            hash: None,
            dest_path: Some("/tmp/a.jpg".into()),
            state: "quarantined".into(),
        })
        .unwrap();
        let page = list_thread(&db, &[3u8; 16], 50, None).unwrap();
        assert_eq!(page.items[0].state, "quarantined");
        assert_eq!(page.items[0].dest_path.as_deref(), Some("/tmp/a.jpg"));
        assert!(!page.items[0].outbound);
    }

    #[test]
    fn derived_state_follows_the_transfer_state() {
        assert_eq!(derive_state(true, "done"), "done");
        assert_eq!(derive_state(true, "canceled"), "failed");
        assert_eq!(derive_state(true, "failed"), "failed");
        assert_eq!(derive_state(true, "queued"), "pending");
        assert_eq!(derive_state(false, "active"), "receiving");
    }

    #[test]
    fn pages_are_oldest_first_and_join_without_overlap() {
        let db = db();
        for (id, at) in [(1u8, 10i64), (2, 20), (3, 20), (4, 30)] {
            let m = manifest(vec![Item::text(0, format!("t{id}"))]);
            put(&db, id, 3, "out", "done", at, m.to_cbor().unwrap(), 1);
        }
        let first = list_thread(&db, &[3u8; 16], 2, None).unwrap();
        let texts: Vec<_> = first
            .items
            .iter()
            .map(|i| i.text.clone().unwrap())
            .collect();
        assert_eq!(texts, vec!["t2", "t4"]);
        let cursor = first.older_cursor.expect("more pages remain");
        let second = list_thread(&db, &[3u8; 16], 2, Some(&cursor)).unwrap();
        let texts: Vec<_> = second
            .items
            .iter()
            .map(|i| i.text.clone().unwrap())
            .collect();
        assert_eq!(texts, vec!["t1", "t3"]);
        assert_eq!(second.older_cursor, None);
    }

    #[test]
    fn a_malformed_cursor_is_an_error_not_the_first_page() {
        for bad in ["", "abc", "1:zz", "x:00", "1:00"] {
            assert!(
                list_thread(&db(), &[3u8; 16], 5, Some(bad)).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_corrupt_manifest_does_not_fail_the_query() {
        let db = db();
        put(&db, 1, 3, "in", "done", 10, vec![1, 2, 3], 1);
        assert!(list_thread(&db, &[3u8; 16], 5, None)
            .unwrap()
            .items
            .is_empty());
        db.upsert_item(&ItemRow {
            transfer_id: [1u8; 16],
            item_index: 0,
            item_type: "text".into(),
            name: None,
            mime: None,
            size: None,
            hash: None,
            dest_path: None,
            state: "done".into(),
        })
        .unwrap();
        let page = list_thread(&db, &[3u8; 16], 5, None).unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.items[0].is_text);
        assert_eq!(page.items[0].text, None);
    }

    #[test]
    fn limit_zero_is_empty_and_a_huge_limit_is_clamped() {
        let db = db();
        let m = manifest(vec![Item::text(0, "a")]);
        put(&db, 1, 3, "out", "done", 10, m.to_cbor().unwrap(), 1);
        assert!(list_thread(&db, &[3u8; 16], 0, None)
            .unwrap()
            .items
            .is_empty());
        assert_eq!(
            list_thread(&db, &[3u8; 16], u32::MAX, None)
                .unwrap()
                .items
                .len(),
            1
        );
    }

    #[test]
    fn a_page_stops_at_the_byte_budget_and_still_returns_one_transfer() {
        let db = db();
        let body = "x".repeat(1024 * 1024);
        for id in 1u8..=4 {
            let m = manifest(vec![Item::text(0, body.clone())]);
            put(
                &db,
                id,
                3,
                "out",
                "done",
                id as i64,
                m.to_cbor().unwrap(),
                1,
            );
        }
        let first = list_thread(&db, &[3u8; 16], 50, None).unwrap();
        assert!(!first.items.is_empty() && first.items.len() < 4);
        // A 1 MiB body fills the JSON budget fast, so one page holds few rows.
        // Walk each page to the end. All 4 transfers appear once.
        let mut seen: Vec<[u8; 16]> = first.items.iter().map(|i| i.transfer_id).collect();
        let mut cursor = first.older_cursor.clone();
        while let Some(c) = cursor {
            let page = list_thread(&db, &[3u8; 16], 50, Some(&c)).unwrap();
            assert!(!page.items.is_empty());
            for i in &page.items {
                assert!(!seen.contains(&i.transfer_id));
                seen.push(i.transfer_id);
            }
            cursor = page.older_cursor.clone();
        }
        assert_eq!(seen.len(), 4);
    }

    // 3.6: the cap must bound the JSON that crosses the wire, not the raw
    // manifest. Two 1 MiB text bodies have manifests under the cap but a page
    // JSON over it, because the JSON of a page is larger than its manifests.
    #[test]
    fn the_page_cap_bounds_the_wire_json_not_the_manifests() {
        let db = db();
        // Many small items. Each item costs ~190 JSON bytes (4*32 hex id + the
        // field names) but only ~66 CBOR bytes (16 raw id + short keys), so the
        // page JSON is ~3x the manifest bytes. The manifests of 3 rows fit the
        // cap while their JSON does not -- exactly what the manifest accounting
        // got wrong.
        let items_per_row = 10_000u32;
        let row_items = |n: u32| {
            let mut v: Vec<Item> = Vec::new();
            for i in 0..n {
                let mut it = Item::text(i, format!("m{i}"));
                it.size = Some(0);
                v.push(it);
            }
            v
        };
        for id in 1u8..=3 {
            let m = manifest(row_items(items_per_row));
            put(
                &db,
                id,
                3,
                "out",
                "done",
                id as i64,
                m.to_cbor().unwrap(),
                1,
            );
        }
        let page = list_thread(&db, &[3u8; 16], 50, None).unwrap();
        assert!(!page.items.is_empty(), "a page always holds one transfer");
        assert!(
            whole_page_json_len(&page) <= THREAD_PAGE_BYTES,
            "the page JSON size {} must stay under the cap {THREAD_PAGE_BYTES}",
            whole_page_json_len(&page)
        );
    }

    // 3.6: small pages are unaffected. Several small transfers still fit two or
    // more to a page, so the cap does not cut every page to one row.
    #[test]
    fn a_page_of_small_transfers_keeps_more_than_one_row() {
        let db = db();
        for id in 1u8..=4 {
            let m = manifest(vec![Item::text(0, format!("t{id}"))]);
            put(
                &db,
                id,
                3,
                "out",
                "done",
                id as i64,
                m.to_cbor().unwrap(),
                1,
            );
        }
        let page = list_thread(&db, &[3u8; 16], 50, None).unwrap();
        assert_eq!(page.items.len(), 4);
        assert!(whole_page_json_len(&page) <= THREAD_PAGE_BYTES);
    }

    #[test]
    fn the_thread_survives_a_revoke_and_a_new_pairing() {
        use crate::store::pairings::Pairing;
        let db = db();
        let m = manifest(vec![Item::text(0, "kept")]);
        put(&db, 1, 3, "out", "queued", 10, m.to_cbor().unwrap(), 1);
        let pairing = Pairing {
            peer_device_id: [3u8; 16],
            state: "trusted".into(),
            paired_at: 0,
            verify_key: [1u8; 32],
            static_dh_pub: [2u8; 32],
            label: None,
        };
        db.upsert_pairing(&pairing).unwrap();
        db.revoke_pairing(&[3u8; 16]).unwrap();
        db.delete_outbox_for_peer(&[3u8; 16]).unwrap();
        let page = list_thread(&db, &[3u8; 16], 50, None).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].text.as_deref(), Some("kept"));
        assert_eq!(page.items[0].transfer_state, "queued");
        db.upsert_pairing(&pairing).unwrap();
        assert_eq!(
            list_thread(&db, &[3u8; 16], 50, None).unwrap().items.len(),
            1
        );
    }

    #[test]
    fn a_one_mebibyte_text_body_round_trips() {
        let db = db();
        let body = "\\u{e9}".repeat(512 * 1024); // 1 MiB in UTF-8
        let m = manifest(vec![Item::text(0, body.clone())]);
        put(&db, 1, 3, "out", "done", 10, m.to_cbor().unwrap(), 1);
        let page = list_thread(&db, &[3u8; 16], 5, None).unwrap();
        assert_eq!(page.items[0].text.as_deref(), Some(body.as_str()));
    }
}
