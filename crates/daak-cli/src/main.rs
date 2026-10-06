use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::FileSecretStore;
use daak_core::discovery::{default_display_name, unique_display_name};
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{
    from_picked_paths, DeviceRef, Item, Manifest, PayloadKind, CHUNK_SIZE_DEFAULT,
};
use daak_core::pairing::{PairMode, PairingBundle};
use daak_core::store::Db;

#[derive(Parser)]
#[command(name = "daak", about = "Daak LAN transfer harness")]
struct Cli {
    /// Directory for the identity keys and sqlite db.
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print the default display name for this device
    Name,
    /// Discover nearby Daak devices for a few seconds
    Discover {
        #[arg(long, default_value_t = 3)]
        secs: u64,
    },
    /// Run a receiver in the foreground
    Serve {
        #[arg(long, default_value = "./daak-recv")]
        dir: PathBuf,
        #[arg(long, default_value = "0")]
        port: u16,
    },
    /// Print the local pairing bundle as lowercase hex (the QR payload)
    Bundle,
    /// Pair with a peer as the initiator
    Pair {
        #[arg(long)]
        to: std::net::SocketAddr,
        #[arg(long)]
        code: Option<String>,
        #[arg(long)]
        bundle: Option<String>,
    },
    /// Accept an inbound pairing as the responder
    PairAccept {
        #[arg(long, default_value = "0")]
        port: u16,
        /// Arm the accept slot for the FIRST inbound pairing, naming no peer.
        /// This is the host half the apps use (Engine::offer_inbound_pairing,
        /// spec 3.3 Mode A), where the joiner learns its own identity in-band.
        /// Without it the only arm this command can set is Expected, which
        /// needs the JOINER's bundle -- a value no host ever holds.
        #[arg(long, conflicts_with_all = ["code", "bundle"])]
        open: bool,
        #[arg(long)]
        code: Option<String>,
        #[arg(long)]
        bundle: Option<String>,
    },
    /// Send text or files to a paired peer
    Send {
        #[arg(long)]
        to: std::net::SocketAddr,
        #[arg(long)]
        device_id: String,
        #[arg(long)]
        text: Option<String>,
        #[arg(long, num_args = 0..)]
        files: Vec<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let Cli { data_dir, command } = Cli::parse();
    // `warn` so a REFUSED pairing names itself. The engine has always logged
    // that refusal; without a subscriber the line was dropped and the only
    // evidence anywhere was the joiner's "connection closed during
    // handshake", which says nothing about the cause.
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_writer(std::io::stderr)
        .init();
    let data_dir = data_dir.unwrap_or_else(default_data_dir);
    match command {
        Command::Name => {
            println!("{}", default_display_name()?);
        }
        Command::Discover { secs } => {
            let cfg = config(&data_dir, "./daak-recv", 0)?;
            let engine = Engine::start(cfg).await?;
            let mut events = engine.events();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
            while let Ok(Ok(EngineEvent::DeviceFound(d))) =
                tokio::time::timeout_at(deadline, events.recv()).await
            {
                println!("{}  {}  {}", hex_id(d.device_id), d.name, d.addr);
            }
            engine.shutdown().await?;
        }
        Command::Serve { dir, port } => {
            let cfg = config(&data_dir, &dir.to_string_lossy(), port)?;
            let engine = Engine::start(cfg).await?;
            println!("listening on {}", engine.local_addr());
            let mut events = engine.events();
            loop {
                match events.recv().await {
                    Ok(EngineEvent::TransferDone { transfer_id }) => {
                        println!("received {}", hex_id(transfer_id));
                    }
                    Ok(EngineEvent::TransferFailed { error, .. }) => eprintln!("failed: {error}"),
                    Ok(_) => {}
                    Err(_) => {}
                }
            }
        }
        Command::Bundle => {
            let cfg = config(&data_dir, "./daak-recv", 0)?;
            let engine = Engine::start(cfg).await?;
            println!("{}", hex::encode(engine.pairing_bundle().await.to_cbor()?));
            engine.shutdown().await?;
        }
        Command::Pair { to, code, bundle } => {
            let cfg = config(&data_dir, "./daak-recv", 0)?;
            let engine = Engine::start(cfg).await?;
            let (sas, peer_id) = match (code, bundle) {
                (Some(code), None) => engine.pair_with_code(to, &code).await?,
                (None, Some(bundle)) => engine.pair_with(to, bundle_from_hex(&bundle)?).await?,
                _ => bail!("provide exactly one of --code or --bundle"),
            };
            println!("sas {sas}");
            println!("peer {}", hex_id(peer_id));
            engine.shutdown().await?;
        }
        Command::PairAccept {
            port,
            code,
            bundle,
            open,
        } => {
            let cfg = config(&data_dir, "./daak-recv", port)?;
            let engine = Engine::start(cfg).await?;
            println!("listening on {}", engine.local_addr());
            match (code, bundle, open) {
                (Some(code), None, false) => engine.offer_code_pairing(code).await?,
                (None, Some(bundle), false) => {
                    engine
                        .offer_pairing(bundle_from_hex(&bundle)?, PairMode::Qr, None)
                        .await?
                }
                (None, None, true) => engine.offer_inbound_pairing(PairMode::Qr).await?,
                _ => bail!("provide exactly one of --code, --bundle, or --open"),
            }
            let sas = engine.accept_pairing_once().await?;
            println!("sas {sas}");
            engine.shutdown().await?;
        }
        Command::Send {
            to,
            device_id,
            text,
            files,
        } => {
            if text.is_none() && files.is_empty() {
                bail!("provide --text and/or --files");
            }
            let peer_id = parse_device_id(&device_id)?;
            let peer_id_hex = device_id.clone();
            let cfg = config(&data_dir, "./daak-send-staging", 0)?;
            let engine = Engine::start(cfg).await?;
            let me = DeviceRef {
                device_id: engine.identity().device_id(),
                name: engine.display_name().await,
            };

            // B1: a picked path may be a DIRECTORY, which has no bytes of its
            // own. from_picked_paths expands a folder into one item per file
            // and returns the source path per ITEM index, so `sources` is what
            // the sender streams -- indexing `files` by item index (the old
            // code) silently pointed at the wrong file once a folder shifted
            // the indices.
            let (manifest, sources) = match (text, files.is_empty()) {
                (Some(t), true) => (Manifest::text(&t), Vec::new()),
                (None, false) => from_picked_paths(me, &files, CHUNK_SIZE_DEFAULT)?,
                (Some(t), false) => {
                    let (mut m, sources) = from_picked_paths(me, &files, CHUNK_SIZE_DEFAULT)?;
                    m.items.push(Item::text(m.items.len() as u32, t));
                    m.kind = PayloadKind::Batch;
                    (m, sources)
                }
                (None, true) => unreachable!(),
            };
            let paths: Vec<Option<PathBuf>> = manifest
                .items
                .iter()
                // `get`, not `[]`: the item index is peer-of-us data that only
                // happens to be in range because from_picked_paths assigns it.
                // `[]` would panic on any future caller that hands us a manifest
                // it did not build. A missing source stays None, which the sender
                // already reports as a Transfer error rather than a panic.
                .map(|i| {
                    i.is_binary()
                        .then(|| sources.get(i.index as usize).cloned())
                        .flatten()
                })
                .collect();

            // R-T11-3: send_secure no longer takes an addr -- the session
            // registry resolves it from the device map, so seed the entry from
            // the address the user gave us.
            engine.note_peer(peer_id, &peer_id_hex, to).await;
            let id = engine.send_secure(peer_id, manifest, paths).await?;
            println!("sent {}", hex_id(id));
            engine.shutdown().await?;
        }
    }
    Ok(())
}

fn config(data_dir: &Path, dir: &str, port: u16) -> Result<EngineConfig> {
    let name = default_display_name()?;
    let taken: Vec<String> = vec![];
    let mut rng = rand::thread_rng();
    let store = FileSecretStore::new(data_dir.join("keys"))?;
    let identity = import_from_store(&store)?;
    let db = Db::open(&data_dir.join("daak.db"))?;
    db.migrate()?;
    Ok(EngineConfig {
        display_name: unique_display_name(&name, &taken, &mut rng),
        listen_addr: format!("0.0.0.0:{port}")
            .parse()
            .context("bad listen addr")?,
        out_dir: PathBuf::from(dir),
        identity,
        db: Arc::new(db),
    })
}

fn default_data_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local/share/daak"))
        .unwrap_or_else(|| PathBuf::from(".daak"))
}

fn parse_device_id(s: &str) -> Result<[u8; 16]> {
    let bytes = hex::decode(s.trim()).context("device id must be hex")?;
    bytes
        .try_into()
        .map_err(|v: Vec<u8>| anyhow::anyhow!("device id must be 16 bytes, got {}", v.len()))
}

fn bundle_from_hex(s: &str) -> Result<PairingBundle> {
    let bytes = hex::decode(s.trim()).context("bundle must be hex")?;
    PairingBundle::from_cbor(&bytes).context("invalid pairing bundle")
}

fn hex_id(id: [u8; 16]) -> String {
    id.iter().map(|b| format!("{b:02x}")).collect()
}
