use std::env;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::Command;
use std::thread::sleep;
use std::time::Duration;

struct Runtime {
    endpoint: String,
    token: String,
    host: String,
    address: String,
    base_path: String,
}

impl Runtime {
    fn from_env() -> Result<Self, String> {
        let endpoint = env::var("YAM_API_URL")
            .map_err(|_| "YAM_API_URL is not set; run through YAM binary runtime".to_string())?;
        let token = env::var("YAM_API_TOKEN")
            .map_err(|_| "YAM_API_TOKEN is not set; run through YAM binary runtime".to_string())?;
        let trimmed = endpoint.trim_end_matches('/');
        let rest = trimmed
            .strip_prefix("http://")
            .ok_or_else(|| format!("unsupported YAM_API_URL: {endpoint}"))?;
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
            endpoint: endpoint.clone(),
            token,
            host: host.to_string(),
            address,
            base_path: base_path.to_string(),
        })
    }

    fn request(&self, method: &str, suffix: &str, body: &str) -> Result<(u16, String), String> {
        let path = format!("{}{}", self.base_path, suffix);
        let mut stream = TcpStream::connect(&self.address)
            .map_err(|error| format!("connect {}: {error}", self.address))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| format!("set read timeout: {error}"))?;
        stream
            .set_write_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| format!("set write timeout: {error}"))?;
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nX-YAM-Token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            self.host,
            self.token,
            body.len(),
            body
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|error| format!("write request: {error}"))?;
        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .map_err(|error| format!("read response: {error}"))?;
        let (head, body) = response
            .split_once("\r\n\r\n")
            .ok_or_else(|| "malformed HTTP response".to_string())?;
        let status = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u16>().ok())
            .ok_or_else(|| format!("malformed HTTP status: {head}"))?;
        Ok((status, body.to_string()))
    }

    fn json_request(&self, method: &str, suffix: &str, body: &str) -> Result<(), String> {
        let (status, response) = self.request(method, suffix, body)?;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(format!("{method} {suffix}: HTTP {status}: {response}"))
        }
    }
}

fn parse_led_count(device: &str) -> usize {
    let marker = "led.ring.";
    let mut offset = 0;
    while let Some(found) = device[offset..].find(marker) {
        let start = offset + found + marker.len();
        let digits: String = device[start..]
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect();
        if let Ok(count) = digits.parse::<usize>() {
            if count > 0 {
                return count;
            }
        }
        offset = start;
    }
    3
}

fn set_ring(runtime: &Runtime, count: usize, color: &str) -> Result<(), String> {
    let colors = vec![format!("\"{color}\""); count].join(",");
    runtime.json_request("POST", "/led", &format!("{{\"colors\":[{colors}]}}"))
}

fn zone_frame(count: usize, zone: usize) -> String {
    let colors = (1..=count)
        .map(|index| {
            if index == zone {
                "\"#FFFFFF\"".to_string()
            } else {
                "\"#000000\"".to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("{{\"colors\":[{colors}]}}")
}

fn run_steps(runtime: &Runtime) -> Result<(), String> {
    println!("YAM runtime: {}", runtime.endpoint);
    let (status, device) = runtime.request("GET", "/device", "")?;
    if !(200..300).contains(&status) {
        return Err(format!("GET /device: HTTP {status}: {device}"));
    }
    println!("device HTTP {status}: {device}");

    let led_count = parse_led_count(&device);
    let has_led = device.contains("led.ring.rgb");
    let has_clock = device.contains("display.clock.segment.v1");
    let has_audio = device.contains("audio.play.aplay");

    if has_led {
        for color in ["#FF0000", "#00FF00", "#0000FF", "#FFFFFF"] {
            set_ring(runtime, led_count, color)?;
            sleep(Duration::from_millis(700));
        }
        for zone in 1..=led_count {
            runtime.json_request("POST", "/led", &zone_frame(led_count, zone))?;
            sleep(Duration::from_millis(500));
        }
    } else {
        println!("LED ring not advertised; skipping");
    }

    if has_clock {
        runtime.json_request(
            "POST",
            "/clock",
            "{\"time\":\"12:34\",\"brightness\":200}",
        )?;
        sleep(Duration::from_millis(2500));
        runtime.json_request("POST", "/clock", "{\"off\":true}")?;
    } else {
        println!("segment clock not advertised; skipping");
    }

    if has_audio {
        println!("playing tone.wav via aplay");
        match Command::new("aplay").args(["-q", "tone.wav"]).status() {
            Ok(status) => println!("aplay exit: {status}"),
            Err(error) => println!("aplay failed: {error}"),
        }
    } else {
        println!("aplay not advertised; skipping audio");
    }

    Ok(())
}

fn run() -> Result<(), String> {
    let runtime = Runtime::from_env()?;
    let result = run_steps(&runtime);

    // Cleanup must run even if a test step failed, otherwise the ring can stay
    // on the last test color after the process exits.
    let _ = runtime.json_request("POST", "/led/off", "");
    let _ = runtime.json_request("POST", "/clock", "{\"off\":true}");
    result
}

fn main() {
    if let Err(error) = run() {
        eprintln!("hasar-selftest-bin: {error}");
        std::process::exit(1);
    }
}
