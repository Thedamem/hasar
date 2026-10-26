mod api;
mod auth;
mod config;
mod playback;
mod tls;
mod yam;

use std::fs;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum_server::tls_rustls::RustlsConfig;
use tracing_subscriber::EnvFilter;

use api::AppState;
use auth::{PairingState, TokenStore};
use playback::PlaybackManager;
use yam::YamClient;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const API_VERSION: u32 = 1;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = config::parse()?;
    fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("create {}", config.data_dir.display()))?;
    set_mode(&config.data_dir, 0o700)?;

    let tls = tls::load_or_create(&config.data_dir)?;
    let yam = YamClient::from_env()?;
    let device = yam.device().context("read YAM device profile")?;
    let model = device
        .get("model")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_string();

    let device_id = load_or_create_device_id(&config.data_dir)?;
    let tokens = TokenStore::load(config.data_dir.join("tokens.json"))?;
    let tokens_empty = tokens.is_empty();
    let pairing_path = config.data_dir.join("pairing.json");
    let pairing = if tokens_empty {
        let url = std::env::var("HASAR_ADVERTISE_URL")
            .unwrap_or_else(|_| "https://hasar.local:8443".to_string());
        let state = PairingState::new(pairing_path.clone(), &tls.fingerprint, &url)?;
        tracing::info!(
            path = %pairing_path.display(),
            "pairing is open; read the root-only pairing.json on the station"
        );
        Some(state)
    } else {
        let _ = fs::remove_file(&pairing_path);
        None
    };

    let state = Arc::new(AppState {
        device_id,
        device,
        fingerprint: tls.fingerprint.clone(),
        tokens: tokio::sync::Mutex::new(tokens),
        pairing: tokio::sync::Mutex::new(pairing),
        yam,
        playback: tokio::sync::Mutex::new(PlaybackManager::new()),
    });

    let app = api::router(state);
    let rustls = RustlsConfig::from_pem(tls.cert_pem.into_bytes(), tls.key_pem.into_bytes())
        .await
        .context("load TLS material")?;

    tracing::info!(
        version = VERSION,
        api_version = API_VERSION,
        model = %model,
        listen = %config.listen,
        fingerprint = %tls.fingerprint,
        "hasar-agent listening"
    );

    axum_server::bind_rustls(config.listen, rustls)
        .serve(app.into_make_service())
        .await
        .context("serve hasar-agent")?;
    Ok(())
}

fn load_or_create_device_id(data_dir: &Path) -> Result<String> {
    let path = data_dir.join("device_id");
    if path.is_file() {
        let value = fs::read_to_string(&path)
            .with_context(|| format!("read {}", path.display()))?
            .trim()
            .to_string();
        if !value.is_empty() {
            return Ok(value);
        }
    }
    let value = uuid::Uuid::new_v4().to_string();
    fs::write(&path, format!("{value}\n"))?;
    set_mode(&path, 0o600)?;
    Ok(value)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .with_context(|| format!("chmod {}", path.display()))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<()> {
    Ok(())
}
