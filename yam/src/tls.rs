use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use base64::Engine;
use sha2::{Digest, Sha256};

pub struct TlsMaterial {
    pub cert_pem: String,
    pub key_pem: String,
    pub fingerprint: String,
}

pub fn load_or_create(data_dir: &Path) -> Result<TlsMaterial> {
    let cert_path = data_dir.join("cert.pem");
    let key_path = data_dir.join("key.pem");
    let fingerprint_path = data_dir.join("fingerprint.txt");

    if cert_path.is_file() && key_path.is_file() {
        let cert_pem = fs::read_to_string(&cert_path)
            .with_context(|| format!("read {}", cert_path.display()))?;
        let key_pem =
            fs::read_to_string(&key_path).with_context(|| format!("read {}", key_path.display()))?;
        // rcgen can re-sign the certificate on every serialize_* call. The
        // fingerprint must be derived from the exact PEM that rustls serves.
        let fingerprint = fingerprint_from_pem(&cert_pem)?;
        let stored = fs::read_to_string(&fingerprint_path).unwrap_or_default();
        if stored.trim() != fingerprint {
            fs::write(&fingerprint_path, format!("{fingerprint}\n"))?;
        }
        return Ok(TlsMaterial {
            cert_pem,
            key_pem,
            fingerprint,
        });
    }

    let certified = rcgen::generate_simple_self_signed(vec![
        "hasar.local".to_string(),
        "localhost".to_string(),
    ])
    .context("generate self-signed certificate")?;
    let cert_pem = certified.serialize_pem()?;
    let key_pem = certified.serialize_private_key_pem();
    // Hash the PEM we persist, not a second serialize_der() signing.
    let fingerprint = fingerprint_from_pem(&cert_pem)?;

    fs::write(&cert_path, &cert_pem)?;
    fs::write(&key_path, &key_pem)?;
    fs::write(&fingerprint_path, format!("{fingerprint}\n"))?;
    set_mode(&key_path, 0o600)?;
    set_mode(&cert_path, 0o644)?;
    set_mode(&fingerprint_path, 0o644)?;

    Ok(TlsMaterial {
        cert_pem,
        key_pem,
        fingerprint,
    })
}

fn fingerprint_from_pem(pem: &str) -> Result<String> {
    let body = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>();
    let der = base64::engine::general_purpose::STANDARD
        .decode(body)
        .context("decode certificate PEM")?;
    Ok(format!("sha256:{:x}", Sha256::digest(der)))
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
