// The engine keeps the plan of a batched send as opaque text in `settings`.
// The engine must not parse the plan.

use std::sync::Arc;
use std::time::Duration;

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::error::CoreError;
use daak_core::pairing::PairMode;
use daak_core::store::pairings::Pairing;
use daak_core::store::Db;

const SHARE: &str = "00112233445566778899aabbccddeeff";
const SHARE_2: &str = "ffeeddccbbaa99887766554433221100";
const LIMIT: usize = 1024 * 1024;

async fn engine() -> (Engine, Arc<Db>, tempfile::TempDir) {
    let out = tempfile::tempdir().unwrap();
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let engine = Engine::start(EngineConfig {
        display_name: "self".into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: out.path().to_path_buf(),
        identity,
        db: db.clone(),
    })
    .await
    .unwrap();
    (engine, db, out)
}

fn pair(db: &Db, peer: [u8; 16]) {
    db.upsert_pairing(&Pairing {
        peer_device_id: peer,
        state: "trusted".into(),
        paired_at: 0,
        verify_key: [1u8; 32],
        static_dh_pub: [2u8; 32],
        label: None,
    })
    .unwrap();
}

fn list(engine: &Engine, peer: [u8; 16]) -> Vec<(String, String)> {
    let text = engine.list_send_plans(peer).unwrap();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["share"].as_str().unwrap().to_string(),
                e["plan"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_saved_plan_appears_in_the_list_of_its_peer() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    engine.save_send_plan(peer, SHARE, "{\"a\":1}").unwrap();
    assert_eq!(
        list(&engine, peer),
        vec![(SHARE.into(), "{\"a\":1}".into())]
    );
}

#[tokio::test]
async fn saving_the_same_share_again_replaces_the_plan() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    engine.save_send_plan(peer, SHARE, "one").unwrap();
    engine.save_send_plan(peer, SHARE, "two").unwrap();
    assert_eq!(list(&engine, peer), vec![(SHARE.into(), "two".into())]);
}

#[tokio::test]
async fn an_invalid_share_is_refused_and_nothing_is_stored() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let bad = [
        SHARE[..31].to_string(),
        format!("{SHARE}0"),
        SHARE.to_ascii_uppercase(),
        "0011223344556677889900aabbccddeg".to_string(),
        String::new(),
    ];
    for share in &bad {
        let err = engine.save_send_plan(peer, share, "x").unwrap_err();
        assert!(matches!(err, CoreError::Protocol(_)), "{share}");
        if !share.is_empty() {
            assert!(!err.to_string().contains(share.as_str()));
        }
        assert!(matches!(
            engine.delete_send_plan(peer, share).unwrap_err(),
            CoreError::Protocol(_)
        ));
    }
    assert!(list(&engine, peer).is_empty());
}

#[tokio::test]
async fn a_plan_over_1_mib_is_refused_and_a_plan_of_exactly_1_mib_is_accepted() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let exact = "a".repeat(LIMIT);
    engine.save_send_plan(peer, SHARE, &exact).unwrap();
    let over = "b".repeat(LIMIT + 1);
    assert!(matches!(
        engine.save_send_plan(peer, SHARE, &over).unwrap_err(),
        CoreError::Protocol(_)
    ));
    // The refused save does not change the stored plan.
    assert_eq!(list(&engine, peer), vec![(SHARE.into(), exact)]);
}

#[tokio::test]
async fn list_returns_the_plans_of_one_peer_only() {
    let (engine, db, _out) = engine().await;
    let (a, b) = ([5u8; 16], [6u8; 16]);
    pair(&db, a);
    pair(&db, b);
    engine.save_send_plan(a, SHARE, "plan a").unwrap();
    engine.save_send_plan(b, SHARE_2, "plan b").unwrap();
    assert_eq!(list(&engine, a), vec![(SHARE.into(), "plan a".into())]);
    assert_eq!(list(&engine, b), vec![(SHARE_2.into(), "plan b".into())]);
}

#[tokio::test]
async fn delete_removes_only_the_named_plan() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    engine.save_send_plan(peer, SHARE, "one").unwrap();
    engine.save_send_plan(peer, SHARE_2, "two").unwrap();
    engine.delete_send_plan(peer, SHARE).unwrap();
    assert_eq!(list(&engine, peer), vec![(SHARE_2.into(), "two".into())]);
    // A delete of a missing plan is not an error.
    engine.delete_send_plan(peer, SHARE).unwrap();
}

#[tokio::test]
async fn an_unpaired_peer_cannot_save_a_plan() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    let err = engine.save_send_plan(peer, SHARE, "x").unwrap_err();
    assert!(matches!(err, CoreError::Protocol(_)));
    assert!(err.to_string().contains("peer is not paired"));
    // A revoked pairing is not trusted either.
    pair(&db, peer);
    db.revoke_pairing(&peer).unwrap();
    assert!(engine.save_send_plan(peer, SHARE, "x").is_err());
    assert!(list(&engine, peer).is_empty());
}

#[tokio::test]
async fn revoke_pairing_removes_every_plan_of_that_peer_and_keeps_the_plans_of_another_peer() {
    let (engine, db, _out) = engine().await;
    let (a, b) = ([5u8; 16], [6u8; 16]);
    pair(&db, a);
    pair(&db, b);
    engine.save_send_plan(a, SHARE, "a1").unwrap();
    engine.save_send_plan(a, SHARE_2, "a2").unwrap();
    engine.save_send_plan(b, SHARE, "b1").unwrap();
    engine.revoke_pairing(a).await.unwrap();
    assert!(list(&engine, a).is_empty());
    assert_eq!(list(&engine, b), vec![(SHARE.into(), "b1".into())]);
}

async fn paired_engines() -> (Arc<Engine>, Arc<Engine>, Arc<Db>, [u8; 16], [u8; 16]) {
    async fn make(name: &str) -> (Arc<Engine>, Arc<Db>) {
        let store = Arc::new(MemorySecretStore::default());
        let identity = import_from_store(store.as_ref()).unwrap();
        let db = Arc::new(Db::open_in_memory().unwrap());
        db.migrate().unwrap();
        let e = Arc::new(
            Engine::start(EngineConfig {
                display_name: name.into(),
                listen_addr: "127.0.0.1:0".parse().unwrap(),
                out_dir: tempfile::tempdir().unwrap().keep(),
                identity,
                db: db.clone(),
            })
            .await
            .unwrap(),
        );
        (e, db)
    }
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    let (joiner, _jdb) = make("joiner").await;
    let (host, host_db) = make("host").await;
    let joiner_id = joiner.pairing_bundle().await.identity.device_id;
    let host_id = host.pairing_bundle().await.identity.device_id;
    host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accept = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once().await.unwrap() }
    });
    joiner
        .pair_with(host.local_addr(), host.pairing_bundle().await)
        .await
        .unwrap();
    accept.await.unwrap();
    (joiner, host, host_db, joiner_id, host_id)
}

#[tokio::test]
async fn a_peer_unpair_notice_revoke_remote_removes_the_plans_of_that_peer() {
    let (joiner, host, host_db, joiner_id, host_id) = paired_engines().await;
    host.save_send_plan(joiner_id, SHARE, "plan").unwrap();
    assert_eq!(list(&host, joiner_id).len(), 1);

    joiner.revoke_pairing(host_id).await.unwrap();

    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if host_db
                .get_pairing(&joiner_id)
                .unwrap()
                .is_some_and(|p| p.state == "revoked")
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the host must revoke the joiner");
    assert!(list(&host, joiner_id).is_empty());
}

#[tokio::test]
async fn the_store_prefix_query_and_a_plan_with_percent_and_underscore_characters_keep_their_meaning(
) {
    let (engine, db, _out) = engine().await;
    let (a, b) = ([5u8; 16], [6u8; 16]);
    pair(&db, a);
    pair(&db, b);
    let odd = "100% _sure_ %_ \\ \" '";
    engine.save_send_plan(a, SHARE, odd).unwrap();
    engine.save_send_plan(b, SHARE, "b").unwrap();
    assert_eq!(list(&engine, a), vec![(SHARE.into(), odd.into())]);
    // The store prefix query treats `%` and `_` as plain characters.
    db.set_setting("sendplan:abxd:x", b"1").unwrap();
    assert!(db
        .list_settings_with_prefix("sendplan:a%")
        .unwrap()
        .is_empty());
    assert!(db
        .list_settings_with_prefix("sendplan:ab_d:")
        .unwrap()
        .is_empty());
    assert_eq!(
        db.list_settings_with_prefix("sendplan:abxd:")
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn the_list_holds_the_plan_as_a_string_byte_for_byte() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let plan = "{ \"b\" : 2,\n  \"a\":[1, 2] , \"u\":\"\u{e9}\u{1F600}\" }  ";
    engine.save_send_plan(peer, SHARE, plan).unwrap();
    let value: serde_json::Value =
        serde_json::from_str(&engine.list_send_plans(peer).unwrap()).unwrap();
    assert!(value[0]["plan"].is_string());
    assert_eq!(value[0]["plan"].as_str().unwrap(), plan);
    // A plan that is not JSON at all is also kept as it is.
    engine.save_send_plan(peer, SHARE_2, "not json {").unwrap();
    assert!(list(&engine, peer).contains(&(SHARE_2.into(), "not json {".into())));
}

#[tokio::test]
async fn the_fifth_plan_of_a_peer_is_refused_and_a_replace_still_works() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let share = |n: u32| format!("{n:032x}");
    for n in 0..4 {
        engine.save_send_plan(peer, &share(n), "p").unwrap();
    }
    let err = engine.save_send_plan(peer, &share(4), "p").unwrap_err();
    assert_eq!(err.to_string(), "protocol: too many send plans");
    assert_eq!(list(&engine, peer).len(), 4);
    // A save for a share that exists replaces it, even at the limit.
    engine.save_send_plan(peer, &share(3), "new").unwrap();
    assert_eq!(list(&engine, peer).len(), 4);
    // A delete frees a place.
    engine.delete_send_plan(peer, &share(0)).unwrap();
    engine.save_send_plan(peer, &share(4), "p").unwrap();
    assert_eq!(list(&engine, peer).len(), 4);
}

#[tokio::test]
async fn a_stored_value_that_is_not_utf8_is_skipped_by_the_list() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let key = format!("sendplan:{}:{}", hex::encode(peer), SHARE);
    db.set_setting(&key, &[0xff, 0xfe]).unwrap();
    assert!(list(&engine, peer).is_empty());
}
