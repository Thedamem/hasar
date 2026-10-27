# HAsar

Локальный мост между колонкой с [YAM](https://github.com/nyakokitsu/yam) (Y Application Manager) и Home Assistant.

## Что делает

`hasar-agent` — бинарный `.yap`-пакет для YAM. Он поднимает на колонке небольшой HTTPS API:

- pairing по одноразовому коду;
- авторизация по bearer-токену;
- самоподписанный TLS-сертификат со стабильным fingerprint;
- проигрывание WAV через `aplay`;
- управление кольцом и сегментным экраном через runtime API YAM;
- WebSocket `/v1/events` (heartbeat).

## Не делает

- не захватывает PCM микрофона;
- не выполняет STT;
- не обходит и не разблокирует внешние облачные сервисы;
- не предоставляет штатный TTS колонки;
- не обрабатывает физические кнопки.

Live-модели используются в add-on только с текстовым входом и аудиовыходом. YAM отдаёт распознанный текст только через Lua API; для голосового ввода нужен доступ к PCM микрофона.

## Структура репозитория

```text
.
├── yam/                       # плагин для YAM (Rust)
│   ├── src/
│   ├── packaging/
│   ├── examples/
│   └── README.md
├── addon/                     # Supervisor app (Node/TS)
│   ├── src/
│   ├── Dockerfile
│   └── config.yaml
├── custom_components/hasar/   # HACS-интеграция (Python)
├── repository.yaml            # app repository
├── hacs.json
├── docs/
│   └── YAM-PLUGIN-API.md
├── AGENTS.md                  # инструкции для AI-агентов
├── LICENSE
└── README.md
```

## Требования

- YAM 0.1.17 или новее (рекомендуется 0.1.18);
- `allow_plugin_binaries = true` в настройках YAM;
- AArch64-колонка для текущей сборки;
- Docker для локальной кросс-сборки.

## Сборка

```sh
./yam/build-yap.sh
```

Результат:

```text
yam/dist/hasar-agent-0.1.1.yap
```

Сборка использует Docker-образ:

```text
messense/rust-musl-cross:aarch64-musl
```

## Установка

```sh
yam install hasar-agent-0.1.1.yap
yam enable hasar-agent
yam service enable hasar-agent
yam logs hasar-agent
```

## Первый pairing

Плагин создаёт TLS-материалы и одноразовый pairing-файл:

```text
/data/quazar/yam/data/hasar-agent/pairing.json
```

Файл имеет права `0600`. Читать его нужно через ADB/SSH, а не через web API YAM:

```sh
adb shell cat /data/quazar/yam/data/hasar-agent/pairing.json
```

Pairing:

```sh
STATION_IP="<ip-колонки>"

curl -k "https://$STATION_IP:8443/v1/pair" \
  -H 'content-type: application/json' \
  -d '{"code":"XXXXXXXX","client_name":"test"}'
```

Ответ содержит bearer-токен. После успешного pairing файл `pairing.json` удаляется.

## Add-on

Add-on ставится через Supervisor:

1. Settings → Apps → App store → Repositories.
2. Добавить URL этого репозитория.
3. Установить **Hasar**.

UI открывается из панели add-on в Home Assistant (ingress). Отдельный порт наружу не публикуется: интеграция обращается к add-on по внутреннему имени `http://local-hasar:8097`.

В UI настраиваются:

- OpenAI-совместимый Chat Completions и модель (список из `/models`);
- Google AI Studio: base URL, chat-модель, live-модель (`bidiGenerateContent`) и режим live;
- Piper: Wyoming URL и голос;
- SOCKS5-прокси для запросов моделей;
- MCP-серверы (HTTP/SSE/stdio);
- routing: Assist / LLM / auto;
- URL и токен плагина.

Add-on умеет:

- вызывать OpenAI Chat Completions с MCP-tools;
- вызывать Gemini Chat Completions (`generateContent`);
- вызывать Gemini Live с текстовым входом и аудиовыходом;
- синтезировать ответ через Piper (Wyoming) и отправлять WAV в плагин;
- проверять intent через `hasar.recognize_intent` и отдавать простые команды Assist;
- тестировать ответ через `/api/ask` и карточку «Быстрая проверка» в UI.

Piper — отдельный add-on. Внутри Supervisor он доступен как `core-piper:10200`.

### API add-on

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | Проверка живости |
| `GET` | `/api/config` | Конфигурация с маскированными секретами |
| `PUT` | `/api/config` | Сохранение конфигурации |
| `POST` | `/api/models` | Список моделей; принимает текущие base URL и ключ из формы |
| `POST` | `/api/ask` | Прогон текста через routing, LLM, MCP, Piper и плагин |
| `POST` | `/api/pair` | Привязка YAM-плагина по одноразовому коду |

Маршруты `/api/*` доступны через ingress Home Assistant или из внутренней сети add-on. Наружу порт не пробрасывается.

## HACS-интеграция

Интеграция добавляется как custom repository в HACS. Мастер привязки состоит из двух шагов:

1. **Подключение к add-on.** На Home Assistant OS / Supervised мастер сам находит add-on через Supervisor (точный hostname и порт). Если add-on найден и уже привязан, шаг сразу пропускается. Если не найден, адрес можно указать вручную.
2. **Привязка колонки.** Укажите IP-адрес колонки (например, `192.0.2.10`), порт плагина (по умолчанию `8443`) и pairing-код. Можно вставить и полный адрес `https://192.0.2.10:8443`.

Если add-on уже привязан к колонке, мастер покажет её адрес и попросит только подтвердить — код заново не нужен.

Pairing-код создаётся плагином на колонке. Его нужно прочитать через ADB или SSH:

```sh
adb shell cat /data/quazar/yam/data/hasar-agent/pairing.json
```

В файле будет поле `code` — это и есть код. Он одноразовый: после успешной привязки `pairing.json` удаляется.

Интеграция сохраняет config entry и регистрирует сервис `hasar.recognize_intent` — dry-run распознавания intent'ов Home Assistant без выполнения.

## API

| Метод | Путь | Авторизация | Назначение |
|---|---|---|---|
| `GET` | `/healthz` | нет | Проверка живости |
| `GET` | `/v1/pairing` | нет | Состояние pairing и fingerprint |
| `POST` | `/v1/pair` | код | Обмен кода на токен |
| `GET` | `/v1/info` | bearer | Модель, features, capabilities |
| `GET` | `/v1/state` | bearer | Состояние playback и pairing |
| `POST` | `/v1/play` | bearer | Проиграть WAV через `aplay` |
| `POST` | `/v1/cancel` | bearer | Остановить playback |
| `POST` | `/v1/led` | bearer | Установить цвета кольца |
| `POST` | `/v1/led/off` | bearer | Вернуть кольцо |
| `POST` | `/v1/clock` | bearer | Управлять экраном/часами |
| `GET` | `/v1/events` | bearer | WebSocket-события |

Пример:

```sh
curl -k "https://$STATION_IP:8443/v1/info" \
  -H "Authorization: Bearer $TOKEN"
```

```sh
curl -k -X POST "https://$STATION_IP:8443/v1/play" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: audio/wav' \
  --data-binary @tone.wav
```

## Безопасность

Плагин:

- TLS с самоподписанным сертификатом и fingerprint;
- pairing-код хранится только в root-only файле на колонке; он не озвучивается и не отдаётся через API;
- bearer-токены на диске хранятся только как SHA-256;
- API рассчитан на доверенную LAN; не выставляйте его в WAN;
- плагин не сохраняет расшифровки речи и ключи провайдеров.

Add-on:

- API-ключи, токен плагина, SOCKS5-URL и заголовки MCP шифруются на диске AES-256-GCM;
- ключ шифрования лежит в `/data/master.key` с правами `0600` или задаётся через `HASAR_SECRET`;
- `GET /api/config` возвращает маску вместо API-ключей, токена плагина и заголовков MCP;
- ключи моделей передаются в заголовках (`Authorization`, `x-goog-api-key`), а не в query string;
- порт add-on не публикуется на хост: доступ идёт через ingress Home Assistant или внутреннюю сеть add-on;
- логи Fastify редактируют заголовки авторизации.

При резервном копировании `/data` копируйте и `master.key`: без него сохранённые секреты восстановить нельзя.

## Лицензия

MIT. См. [LICENSE](LICENSE).
