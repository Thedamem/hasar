use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};

use crate::VERSION;

pub struct Config {
    pub listen: SocketAddr,
    pub data_dir: PathBuf,
}

pub fn parse() -> Result<Config> {
    let mut listen = "0.0.0.0:8443".to_string();
    let mut data_dir = env::var("HASAR_DATA_DIR")
        .unwrap_or_else(|_| "/data/quazar/yam/data/hasar-agent".to_string());

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--listen" => {
                listen = args.next().context("--listen requires an address")?;
            }
            "--data-dir" => {
                data_dir = args.next().context("--data-dir requires a path")?;
            }
            "--version" | "-V" => {
                println!("hasar-agent {VERSION}");
                std::process::exit(0);
            }
            "--help" | "-h" => {
                println!(
                    "hasar-agent {VERSION}\n\n\
                     Usage: hasar-agent [--listen 0.0.0.0:8443] [--data-dir /path]\n\n\
                     Environment:\n  YAM_API_URL    YAM runtime API base URL\n  YAM_API_TOKEN  YAM runtime token\n  YAM_PLUGIN_ID  YAM plugin id\n  HASAR_DATA_DIR data directory override"
                );
                std::process::exit(0);
            }
            other => bail!("unknown argument: {other}"),
        }
    }

    let listen = listen
        .parse::<SocketAddr>()
        .with_context(|| format!("invalid listen address: {listen}"))?;
    Ok(Config {
        listen,
        data_dir: PathBuf::from(data_dir),
    })
}
