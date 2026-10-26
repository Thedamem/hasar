# Hasar Agent

Бинарный YAM-пакет: локальный мост между колонкой и Home Assistant.

## Возможности

- HTTPS API на `:8443`;
- самоподписанный TLS-сертификат;
- pairing по одноразовому коду;
- bearer-токены, на диске хранятся только их SHA-256;
- `GET /healthz`, `GET /v1/info`, `GET /v1/state`;
- `POST /v1/play` — WAV через `aplay`;
- `POST /v1/cancel`;
- `POST /v1/led`, `/v1/led/off`, `/v1/clock` через runtime API YAM;
- `GET /v1/events` — WebSocket heartbeat.

## Не делает

- не отдаёт speech events;
- не захватывает микрофон, не выполняет STT и live-модели;
- не предоставляет штатный TTS колонки;
- не обрабатывает физические кнопки;
- не обходит и не разблокирует внешние облачные сервисы.

## Сборка

Нужен Docker:

```sh
./build-yap.sh
```

Результат:

```text
dist/hasar-agent-0.1.1.yap
```

Используется образ `messense/rust-musl-cross:aarch64-musl`.

## Установка

```sh
yam install hasar-agent-0.1.1.yap
yam enable hasar-agent
yam service enable hasar-agent
yam logs hasar-agent
```

В настройках YAM должен быть включён `allow_plugin_binaries`.

## Совместимость

В манифесте пакета не задан список `models`, поэтому пакет не блокируется на незнакомых моделях. Обязательное требование — `arch.aarch64`. Проверено на `yandexplum`; другие AArch64-колонки можно тестировать.

## Данные

```text
/data/quazar/yam/data/hasar-agent/
├── cert.pem
├── key.pem
├── fingerprint.txt
├── device_id
├── pairing.json     # создаётся при открытом pairing
└── tokens.json
```

## Pairing

Если токенов нет, плагин создаёт `pairing.json` с правами `0600`.

Прочитать его можно только с колонки:

```sh
adb shell cat /data/quazar/yam/data/hasar-agent/pairing.json
```

Код не озвучивается и не отдаётся через API.

```sh
STATION_IP="<ip-колонки>"

curl -k "https://$STATION_IP:8443/v1/pair" \
  -H 'content-type: application/json' \
  -d '{"code":"XXXXXXXX","client_name":"test"}'
```

Ответ содержит токен. После успешного pairing `pairing.json` удаляется.

## Проверка API

```sh
STATION_IP="<ip-колонки>"
TOKEN='hsr_...'

curl -k "https://$STATION_IP:8443/v1/info" \
  -H "Authorization: Bearer $TOKEN"
```

## Проверка TTS

```sh
curl -k -X POST "https://$STATION_IP:8443/v1/play" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: audio/wav' \
  --data-binary @tone.wav
```

Плагин сохранит WAV в `/tmp` и запустит:

```text
aplay -q -D default <file>
```

## LED и экран

```sh
curl -k -X POST "https://$STATION_IP:8443/v1/led" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"colors":["#0000FF","#0000FF","#0000FF"]}'
```

```sh
curl -k -X POST "https://$STATION_IP:8443/v1/clock" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"time":"12:34","brightness":170}'
```

## Разработка

```text
src/api.rs       HTTP/WS endpoints
src/auth.rs      pairing и токены
src/config.rs    аргументы и пути
src/playback.rs  aplay и состояние
src/tls.rs       сертификат и fingerprint
src/yam.rs       клиент runtime API YAM
```

Секреты, сертификаты и runtime-данные не коммитятся.
