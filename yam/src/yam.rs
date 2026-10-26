use std::env;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;

#[derive(Clone)]
pub struct YamClient {
    host: String,
    address: String,
    base_path: String,
    token: String,
}

impl YamClient {
    pub fn from_env() -> Result<Self> {
        let endpoint = env::var("YAM_API_URL")
            .context("YAM_API_URL is not set; hasar-agent must run as a YAM binary package")?;
        let token = env::var("YAM_API_TOKEN")
            .context("YAM_API_TOKEN is not set; hasar-agent must run as a YAM binary package")?;
        let trimmed = endpoint.trim_end_matches('/');
        let rest = trimmed
            .strip_prefix("http://")
            .with_context(|| format!("unsupported YAM_API_URL: {endpoint}"))?;
        let (host, base_path) = match rest.find('/') {
            Some(index) => (&rest[..index], &rest[index..]),
            None => (rest, ""),
        };
        let address = if host.contains(':') {
            host.to_string()
        } else {
            format!("{host}:80")
        };
        Ok(Self {
            host: host.to_string(),
            address,
            base_path: base_path.to_string(),
            token,
        })
    }

    pub fn device(&self) -> Result<Value> {
        let (status, body) = self.request("GET", "/device", "")?;
        anyhow::ensure!(status == 200, "GET /device returned HTTP {status}: {body}");
        serde_json::from_str(&body).context("parse /device JSON")
    }

    pub fn set_led(&self, colors: &[String]) -> Result<()> {
        let body = serde_json::json!({ "colors": colors }).to_string();
        self.json_request("POST", "/led", &body)
    }

    pub fn led_off(&self) -> Result<()> {
        self.json_request("POST", "/led/off", "")
    }

    pub fn set_clock(&self, body: &str) -> Result<()> {
        self.json_request("POST", "/clock", body)
    }

    fn json_request(&self, method: &str, suffix: &str, body: &str) -> Result<()> {
        let (status, response) = self.request(method, suffix, body)?;
        anyhow::ensure!(
            (200..300).contains(&status),
            "{method} {suffix} returned HTTP {status}: {response}"
        );
        Ok(())
    }

    fn request(&self, method: &str, suffix: &str, body: &str) -> Result<(u16, String)> {
        let path = format!("{}{}", self.base_path, suffix);
        let mut stream = TcpStream::connect(&self.address)
            .with_context(|| format!("connect {}", self.address))?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        stream.set_write_timeout(Some(Duration::from_secs(10)))?;
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nX-YAM-Token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            self.host,
            self.token,
            body.len(),
            body
        );
        stream.write_all(request.as_bytes())?;
        let mut response = String::new();
        stream.read_to_string(&mut response)?;
        let (head, body) = response
            .split_once("\r\n\r\n")
            .context("malformed HTTP response from YAM")?;
        let status = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u16>().ok())
            .with_context(|| format!("malformed HTTP status from YAM: {head}"))?;
        Ok((status, body.to_string()))
    }
}
