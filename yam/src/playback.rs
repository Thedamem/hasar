use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tokio::process::{Child, Command};
use uuid::Uuid;

const MAX_AUDIO_BYTES: usize = 20 * 1024 * 1024;

struct ActivePlayback {
    id: String,
    child: Child,
    path: PathBuf,
}

#[derive(Serialize)]
pub struct PlaybackStatus {
    pub playing: bool,
    pub id: Option<String>,
    pub error: Option<String>,
}

pub struct PlaybackManager {
    current: Option<ActivePlayback>,
    last_error: Option<String>,
}

impl PlaybackManager {
    pub fn new() -> Self {
        Self {
            current: None,
            last_error: None,
        }
    }

    pub fn play(&mut self, data: &[u8]) -> Result<String> {
        if data.len() > MAX_AUDIO_BYTES {
            bail!("audio payload exceeds 20 MiB");
        }
        if !data.starts_with(b"RIFF") || data.get(8..12) != Some(b"WAVE") {
            bail!("only WAV audio is supported");
        }
        self.stop();

        let id = Uuid::new_v4().to_string();
        let path = std::env::temp_dir().join(format!("hasar-play-{id}.wav"));
        fs::write(&path, data).with_context(|| format!("write {}", path.display()))?;

        let child = Command::new("aplay")
            .args(["-q", "-D", "default"])
            .arg(&path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("start aplay")?;
        self.current = Some(ActivePlayback {
            id: id.clone(),
            child,
            path,
        });
        self.last_error = None;
        Ok(id)
    }

    pub fn cancel(&mut self) {
        self.stop();
    }

    pub fn status(&mut self) -> PlaybackStatus {
        if let Some(active) = self.current.as_mut() {
            match active.child.try_wait() {
                Ok(Some(_)) => {
                    let path = active.path.clone();
                    let id = active.id.clone();
                    self.current = None;
                    let _ = fs::remove_file(path);
                    return PlaybackStatus {
                        playing: false,
                        id: Some(id),
                        error: self.last_error.clone(),
                    };
                }
                Ok(None) => {
                    return PlaybackStatus {
                        playing: true,
                        id: Some(active.id.clone()),
                        error: self.last_error.clone(),
                    };
                }
                Err(error) => {
                    self.last_error = Some(format!("aplay status: {error}"));
                    self.stop();
                    return PlaybackStatus {
                        playing: false,
                        id: None,
                        error: self.last_error.clone(),
                    };
                }
            }
        }
        PlaybackStatus {
            playing: false,
            id: None,
            error: self.last_error.clone(),
        }
    }

    fn stop(&mut self) {
        if let Some(mut active) = self.current.take() {
            let _ = active.child.start_kill();
            let _ = fs::remove_file(&active.path);
        }
    }
}

#[allow(dead_code)]
fn cleanup(path: &Path) {
    let _ = fs::remove_file(path);
}
