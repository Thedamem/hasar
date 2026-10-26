use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::TokenStore;
use crate::playback::PlaybackManager;
use crate::yam::YamClient;
use crate::VERSION;

pub struct AppState {
    pub device_id: String,
    pub device: Value,
    pub fingerprint: String,
    pub tokens: tokio::sync::Mutex<TokenStore>,
    pub pairing: tokio::sync::Mutex<Option<crate::auth::PairingState>>,
    pub yam: YamClient,
    pub playback: tokio::sync::Mutex<PlaybackManager>,
}

pub fn router(state: Arc<AppState>) -> Router {
    let protected = Router::new()
        .route("/info", get(info))
        .route("/state", get(state_view))
        .route("/play", post(play))
        .route("/cancel", post(cancel))
        .route("/led", post(led))
        .route("/led/off", post(led_off))
        .route("/clock", post(clock))
        .route("/events", get(events))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_auth,
        ));

    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/pairing", get(pairing_info))
        .route("/v1/pair", post(pair))
        .nest("/v1", protected)
        .with_state(state)
        .layer(DefaultBodyLimit::max(20 * 1024 * 1024))
}

async fn healthz() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": VERSION,
        "api_version": 1
    }))
}

async fn pairing_info(State(state): State<Arc<AppState>>) -> Json<Value> {
    let pairing = state.pairing.lock().await;
    let open = pairing.as_ref().is_some_and(|value| value.is_open());
    let model = state
        .device
        .get("model")
        .cloned()
        .unwrap_or(Value::Null);
    Json(json!({
        "device_id": state.device_id,
        "model": model,
        "fingerprint": state.fingerprint,
        "pairing_open": open,
        "api_version": 1
    }))
}

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    #[serde(default)]
    client_name: Option<String>,
}

async fn pair(
    State(state): State<Arc<AppState>>,
    Json(request): Json<PairRequest>,
) -> Result<Json<Value>, ApiError> {
    let client_name = request
        .client_name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Home Assistant".to_string());
    let mut pairing = state.pairing.lock().await;
    let Some(active) = pairing.as_mut() else {
        return Err(ApiError::unauthorized("pairing is closed"));
    };
    if !active.verify(request.code.trim()) {
        return Err(ApiError::unauthorized("invalid or expired pairing code"));
    }
    let token = state
        .tokens
        .lock()
        .await
        .issue(&client_name)
        .map_err(ApiError::internal)?;
    *pairing = None;
    Ok(Json(json!({
        "token": token,
        "device_id": state.device_id,
        "api_version": 1
    })))
}

async fn info(State(state): State<Arc<AppState>>) -> Json<Value> {
    let model = state
        .device
        .get("model")
        .cloned()
        .unwrap_or(Value::Null);
    let features = state
        .device
        .get("features")
        .cloned()
        .unwrap_or_else(|| json!([]));
    Json(json!({
        "api_version": 1,
        "device_id": state.device_id,
        "model": model,
        "features": features,
        "capabilities": {
            "speech_events": false,
            "native_tts": false,
            "audio_playback": true,
            "led": true,
            "clock": true,
            "buttons": false,
            "mic": false,
            "live": false
        }
    }))
}

async fn state_view(State(state): State<Arc<AppState>>) -> Json<Value> {
    let playback = state.playback.lock().await.status();
    let pairing_open = state
        .pairing
        .lock()
        .await
        .as_ref()
        .is_some_and(|value| value.is_open());
    Json(json!({
        "playback": playback,
        "pairing_open": pairing_open
    }))
}

async fn play(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let id = state
        .playback
        .lock()
        .await
        .play(&body)
        .map_err(ApiError::bad_request)?;
    Ok((StatusCode::ACCEPTED, Json(json!({ "id": id }))))
}

async fn cancel(State(state): State<Arc<AppState>>) -> StatusCode {
    state.playback.lock().await.cancel();
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
struct Frame {
    colors: Vec<String>,
}

async fn led(
    State(state): State<Arc<AppState>>,
    Json(frame): Json<Frame>,
) -> Result<StatusCode, ApiError> {
    let yam = state.yam.clone();
    tokio::task::spawn_blocking(move || yam.set_led(&frame.colors))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn led_off(State(state): State<Arc<AppState>>) -> Result<StatusCode, ApiError> {
    let yam = state.yam.clone();
    tokio::task::spawn_blocking(move || yam.led_off())
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ClockRequest {
    #[serde(default)]
    time: Option<String>,
    #[serde(default)]
    brightness: Option<u8>,
    #[serde(default)]
    off: bool,
}

async fn clock(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ClockRequest>,
) -> Result<StatusCode, ApiError> {
    let body = serde_json::to_string(&json!({
        "time": request.time,
        "brightness": request.brightness,
        "off": request.off
    }))
    .map_err(ApiError::internal)?;
    let yam = state.yam.clone();
    tokio::task::spawn_blocking(move || yam.set_clock(&body))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::bad_request)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn events(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| events_socket(socket, state))
}

async fn events_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let hello = json!({
        "type": "hello",
        "api_version": 1,
        "device_id": state.device_id,
        "device": state.device
    });
    if socket
        .send(Message::Text(hello.to_string()))
        .await
        .is_err()
    {
        return;
    }
    let mut interval = tokio::time::interval(Duration::from_secs(15));
    loop {
        tokio::select! {
            _ = interval.tick() => {
                let heartbeat = json!({"type":"heartbeat","ts": unix_ms()}).to_string();
                if socket.send(Message::Text(heartbeat)).await.is_err() {
                    break;
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

async fn require_auth(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let Some(token) = token else {
        return ApiError::unauthorized("missing bearer token").into_response();
    };
    if !state.tokens.lock().await.verify(token) {
        return ApiError::unauthorized("invalid token").into_response();
    }
    next.run(request).await
}

pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn unauthorized(message: &str) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.to_string(),
        }
    }

    fn bad_request(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: error.to_string(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error": self.message}))).into_response()
    }
}
