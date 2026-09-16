use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use daak_core::discovery::{default_display_name, unique_display_name};
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{DeviceRef, Item, Manifest, PayloadKind, CHUNK_SIZE_DEFAULT};

#[derive(Parser)]
#[command(name = "daak", about = "Daak LAN transfer harness")]
struct Cli {
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
    /// Send text or files to a peer
    Send {
        #[arg(long)]
        to: std::net::SocketAddr,
        #[arg(long)]
        text: Option<String>,
        #[arg(long, num_args = 0..)]
        files: Vec<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Name => {
            println!("{}", default_display_name()?);
        }
        Command::Discover { secs } => {
            let cfg = config("./daak-recv", 0)?;
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
            let cfg = config(&dir.to_string_lossy(), port)?;
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
        Command::Send { to, text, files } => {
            if text.is_none() && files.is_empty() {
                bail!("provide --text and/or --files");
            }
            let cfg = config("./daak-send-staging", 0)?;
            let me = DeviceRef {
                device_id: cfg.device_id,
                name: cfg.display_name.clone(),
            };
            let engine = Engine::start(cfg).await?;

            let manifest = match (text, files.is_empty()) {
                (Some(t), true) => Manifest::text(&t),
                (None, false) => build_file_manifest(me, &files)?,
                (Some(t), false) => {
                    let mut m = build_file_manifest(me, &files)?;
                    m.items.push(Item::text(m.items.len() as u32, t));
                    m.kind = PayloadKind::Batch;
                    m
                }
                (None, true) => unreachable!(),
            };
            let paths = manifest
                .items
                .iter()
                .map(|i| {
                    if i.item_type == daak_core::manifest::ItemType::Text {
                        None
                    } else {
                        files.get(i.index as usize).cloned()
                    }
                })
                .collect::<Vec<_>>();

            let id = engine.send_to(to, manifest, paths).await?;
            println!("sent {}", hex_id(id));
            engine.shutdown().await?;
        }
    }
    Ok(())
}

fn config(dir: &str, port: u16) -> Result<EngineConfig> {
    let name = default_display_name()?;
    let taken: Vec<String> = vec![];
    let mut rng = rand::thread_rng();
    Ok(EngineConfig {
        display_name: unique_display_name(&name, &taken, &mut rng),
        device_id: cfg_device_id(),
        listen_addr: format!("0.0.0.0:{port}")
            .parse()
            .context("bad listen addr")?,
        out_dir: PathBuf::from(dir),
    })
}

fn cfg_device_id() -> [u8; 16] {
    let mut id = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut id);
    id
}

fn build_file_manifest(me: DeviceRef, files: &[PathBuf]) -> Result<Manifest> {
    let mut items = Vec::new();
    for (i, f) in files.iter().enumerate() {
        items.push(Item::from_file(i as u32, f, CHUNK_SIZE_DEFAULT)?);
    }
    Ok(Manifest::batch(me, items)?)
}

fn hex_id(id: [u8; 16]) -> String {
    id.iter().map(|b| format!("{b:02x}")).collect()
}
