// R42: A NAME SET FROM SETTINGS WAS NEVER STORED.
//
//   A rename called Engine::set_display_name, which assigned p.base_name and
//   p.resolved_name and swapped the advertiser. That was all it did. The
//   settings table was never written by engine code at all: a grep for
//   get_setting / set_setting / delete_setting across every crate returned
//   zero callers outside store/settings.rs, and the shipped database had zero
//   rows in that table.
//
//   So the name lived in one Arc<Mutex<Profile>> and died with the process.
//   Every shipped entry point passes the SAME literal at start --
//   DaemonClient.ts sends display_name 'daak', InProcess.ts sends 'daak' --
//   and Engine::start copies that argument into base_name, so every launch
//   overwrote whatever the user had typed.
//
//   WHY NO TEST CAUGHT IT. contract-suite.ts:129 renames and reads back
//   through the SAME live engine, and both calls read the same in-memory
//   Profile struct. Nothing ever restarted an engine and read the name back.
//   These four tests are that missing shape.
//
//   These bind loopback sockets. Under a sandbox that denies socket(2) they
//   fail with EPERM, which is the sandbox and not a defect.
use std::path::Path;
use std::sync::Arc;

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::store::Db;

/// The settings key the display name lives under.
///
/// The engine keeps the same string in a PRIVATE `DISPLAY_NAME_KEY`, which an
/// integration test cannot import, so this constant is a copy and not a
/// compile-checked link. If the engine key ever changes, the `get_setting`
/// assertions below read `None` and these tests fail, so the copy cannot go
/// stale silently.
const DISPLAY_NAME_KEY: &str = "display_name";

/// A real engine on a real file-backed Db, so a second Engine::start in the
/// same test reads what the first one wrote. An in-memory Db loses every row
/// when the first handle drops, which is the defect under test.
async fn engine_on(dir: &Path, name: &str) -> (Engine, Arc<Db>) {
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(Db::open(&dir.join("daak.db")).unwrap());
    db.migrate().unwrap();
    let e = Engine::start(EngineConfig {
        display_name: name.into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: dir.to_path_buf(),
        identity,
        db: db.clone(),
    })
    .await
    .unwrap();
    (e, db)
}

/// The headline. A rename has to outlive the process that took it, and the
/// only proof is a SECOND engine on the SAME directory reporting the name.
///
/// The second start passes 'daak', the literal every shipped entry point
/// sends. If the file is not read back, the second engine reports 'daak' and
/// this fails, which is exactly the shipped defect.
#[tokio::test]
async fn a_rename_survives_an_engine_restart_on_the_same_directory() {
    let d = tempfile::tempdir().unwrap();

    let (first, _first_db) = engine_on(d.path(), "daak").await;
    first
        .set_display_name("studio-laptop".into())
        .await
        .unwrap();
    assert_eq!(first.self_profile().await.0, "studio-laptop");
    first.shutdown().await.unwrap();

    let (second, _second_db) = engine_on(d.path(), "daak").await;
    assert_eq!(
        second.self_profile().await.0,
        "studio-laptop",
        "the restart overwrote the name the user set"
    );
    second.shutdown().await.unwrap();
}

/// Pins the upsert. Two renames on one engine leave ONE row holding the
/// second name. A test that only checked the in-memory Profile would pass with
/// an INSERT whose second write silently did nothing.
#[tokio::test]
async fn a_second_rename_replaces_the_first_in_the_file() {
    let d = tempfile::tempdir().unwrap();
    let (e, db) = engine_on(d.path(), "daak").await;

    e.set_display_name("first-name".into()).await.unwrap();
    e.set_display_name("second-name".into()).await.unwrap();

    let stored = db.get_setting(DISPLAY_NAME_KEY).unwrap();
    assert_eq!(
        stored.as_deref(),
        Some(&b"second-name"[..]),
        "the file still holds the superseded name"
    );
    e.shutdown().await.unwrap();
}

/// The BASE name goes in the file, not the resolved one.
///
/// A collision has to be REAL for this to mean anything, so a second
/// advertiser holds `kitchen-display` on the LAN first. The engine then has to
/// publish a suffixed name, and the assertion that matters is the one on the
/// FILE: it must still read `kitchen-display`, so a later rename back to it --
/// or any rename at all -- is possible. A stored suffixed name fails here.
#[tokio::test]
async fn the_stored_name_is_the_base_name_and_not_the_resolved_name() {
    let d = tempfile::tempdir().unwrap();
    let (e, db) = engine_on(d.path(), "daak").await;

    // A peer already holds this name, so the rename below cannot keep it.
    let squatter = daak_core::discovery::Advertiser::start("kitchen-display", 9_999, [7u8; 16]);
    let squatter = squatter.expect("could not register the second advertiser");

    e.set_display_name("kitchen-display".into()).await.unwrap();
    let stored = db.get_setting(DISPLAY_NAME_KEY).unwrap();
    let stored = String::from_utf8(stored.expect("no display name row")).unwrap();
    assert_eq!(stored, "kitchen-display");

    // Now the SEPARATION, proven rather than assumed. The squatter is a real
    // peer holding the base name, so the engine had to publish a SUFFIXED
    // name. resolve_name builds either "<adjective> <animal> . <base>" or
    // "<base> <n>", so the base survives as a tail of the advertised name in
    // both forms. Asserting the suffix is the proof that a resolve really
    // happened. Asserting that the row is the plain base name is the proof
    // that the resolved one was NOT stored.
    let advertised = e.self_profile().await.0;
    assert_ne!(
        advertised, "kitchen-display",
        "the squatter did not force a suffix, so this test proved nothing"
    );
    assert!(
        advertised.ends_with("kitchen-display"),
        "the resolved name lost the base entirely: {advertised}"
    );
    assert_eq!(
        stored, "kitchen-display",
        "the file took the resolved name, so the user can never type it back"
    );

    e.shutdown().await.unwrap();
    squatter.stop();
}

/// A first launch has nothing stored, so the caller's argument must be used.
/// Without this an empty settings row would advertise an empty name, which
/// is a different and worse failure than the one being fixed here.
#[tokio::test]
async fn a_first_launch_uses_the_name_it_started_with() {
    let d = tempfile::tempdir().unwrap();
    let (e, db) = engine_on(d.path(), "boot-name").await;

    assert_eq!(e.self_profile().await.0, "boot-name");
    assert_eq!(db.get_setting(DISPLAY_NAME_KEY).unwrap(), None);
    e.shutdown().await.unwrap();

    let (second, _db) = engine_on(d.path(), "boot-name").await;
    assert_eq!(second.self_profile().await.0, "boot-name");
    second.shutdown().await.unwrap();
}

/// Two renames racing must leave the FILE and the ADVERTISEMENT agreeing.
///
/// `set_display_name` writes the row BEFORE the slow collision resolve, so two
/// concurrent calls can interleave: A writes "alpha", B writes "beta", then B
/// takes the profile lock first and A takes it second. Memory ends on "alpha"
/// and the file ends on "beta". The next launch then advertises a name no
/// peer has ever seen, and the rename looks like it reverted.
///
/// Which order wins is not the point and is not asserted: both outcomes are
/// legitimate. The point is that the FILE and the RUNNING engine agree, because
/// only that is observable by a user.
// MULTI_THREAD, and that is load-bearing rather than decoration. The body of
// set_display_name has NO await point between the database write and the
// profile lock: the collision resolve is a BLOCKING recv_timeout on the
// calling thread. So on a single-threaded runtime two calls can never
// interleave, and a join! test would pass against code that has the race. A
// multi_thread runtime puts the two renames on two workers, which is the only
// shape that can actually interleave them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_concurrent_pair_of_renames_leaves_the_file_matching_the_advertisement() {
    let d = tempfile::tempdir().unwrap();
    let (e, db) = engine_on(d.path(), "daak").await;

    // TWO INDEPENDENT TASKS, not a join! of two futures. The daemon serves one
    // task PER CONNECTION, so two clients really can be inside
    // set_display_name on two workers. join! would poll both futures on THIS
    // task, and since the body has no await between the write and the profile
    // lock, one future would run to completion before the other started -- so
    // join! could not interleave them and would pass against racy code.
    //
    // spawn moves each rename onto its own worker, and the barrier releases
    // both at the same moment so neither has a head start.
    // Engine is not Clone, so the tasks share it through an Arc rather than
    // each holding its own handle.
    let shared = Arc::new(e);
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let mut tasks = Vec::new();
    for name in ["alpha", "beta"] {
        let e = shared.clone();
        let barrier = barrier.clone();
        tasks.push(tokio::spawn(async move {
            barrier.wait();
            e.set_display_name(name.into()).await
        }));
    }
    for t in tasks {
        t.await.unwrap().unwrap();
    }

    let stored = db.get_setting(DISPLAY_NAME_KEY).unwrap();
    let stored = String::from_utf8(stored.expect("no display name row")).unwrap();
    let advertised = shared.self_profile().await.0;

    // This host holds no peer named alpha or beta, so the advertised name is
    // the base name and the two must be the same string.
    assert_eq!(
        advertised, stored,
        "a racing pair left the file and the advertisement disagreeing"
    );
    shared.shutdown().await.unwrap();

    // And the disagreement must not survive a restart either: the engine reads
    // the file, so the next launch inherits whichever copy won.
    let (again, _db) = engine_on(d.path(), "daak").await;
    assert_eq!(again.self_profile().await.0, stored);
    again.shutdown().await.unwrap();
}
