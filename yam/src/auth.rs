use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const PAIRING_TTL: Duration = Duration::from_secs(10 * 60);
const PAIRING_ATTEMPTS: u8 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenRecord {
    pub name: String,
    pub created: u64,
}

pub struct TokenStore {
    path: PathBuf,
    records: BTreeMap<String, TokenRecord>,
}

impl TokenStore {
    pub fn load(path: PathBuf) -> Result<Self> {
        let records = match fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|error| {
                tracing::warn!(%error, "tokens.json is corrupt; starting with no tokens");
                BTreeMap::new()
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        Ok(Self { path, records })
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn issue(&mut self, name: &str) -> Result<String> {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = format!(
            "hsr_{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        );
        self.records.insert(
            hash_token(&token),
            TokenRecord {
                name: name.to_string(),
                created: unix_now(),
            },
        );
        self.save()?;
        Ok(token)
    }

    pub fn verify(&self, token: &str) -> bool {
        self.records.contains_key(&hash_token(token))
    }

    fn save(&self) -> Result<()> {
        let raw = serde_json::to_vec_pretty(&self.records)?;
        fs::write(&self.path, raw).with_context(|| format!("write {}", self.path.display()))?;
        set_mode(&self.path, 0o600)?;
        Ok(())
    }
}

pub struct PairingState {
    code: String,
    expires: Instant,
    attempts: u8,
    path: PathBuf,
}

#[derive(Serialize)]
struct PairingFile<'a> {
    code: &'a str,
    fingerprint: &'a str,
    url: &'a str,
    ttl_seconds: u64,
}

impl PairingState {
    pub fn new(
        path: PathBuf,
        fingerprint: &str,
        url: &str,
    ) -> Result<Self> {
        let code = pairing_code();
        let state = Self {
            code: code.clone(),
            expires: Instant::now() + PAIRING_TTL,
            attempts: 0,
            path: path.clone(),
        };
        let file = PairingFile {
            code: &code,
            fingerprint,
            url,
            ttl_seconds: PAIRING_TTL.as_secs(),
        };
        fs::write(&path, serde_json::to_vec_pretty(&file)?)
            .with_context(|| format!("write {}", path.display()))?;
        set_mode(&path, 0o600)?;
        Ok(state)
    }

    pub fn is_open(&self) -> bool {
        self.attempts < PAIRING_ATTEMPTS && Instant::now() < self.expires
    }

    pub fn verify(&mut self, code: &str) -> bool {
        if !self.is_open() {
            self.close();
            return false;
        }
        if self.code == code {
            self.close();
            true
        } else {
            self.attempts += 1;
            if self.attempts >= PAIRING_ATTEMPTS {
                self.close();
            }
            false
        }
    }

    pub fn close(&mut self) {
        let _ = fs::remove_file(&self.path);
        self.attempts = PAIRING_ATTEMPTS;
    }
}

fn pairing_code() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut rng = rand::thread_rng();
    let mut out = String::with_capacity(8);
    for _ in 0..8 {
        let index = (rng.next_u32() as usize) % ALPHABET.len();
        out.push(ALPHABET[index] as char);
    }
    out
}

fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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
