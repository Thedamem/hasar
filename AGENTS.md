# AGENTS.md

Инструкции для AI-агентов и разработчиков, которые меняют этот репозиторий.

> Это не обзор продукта, а контракт: что можно менять, что нельзя, как проверять результат. Если текст расходится с кодом, источником истины считается код, но правило нужно сразу исправить в этом файле и объяснить причину. Не подгоняйте код под устаревший текст молча.

Актуально на 29.10.2026. При изменении архитектуры, API, схемы конфигурации или правил безопасности обновляйте соответствующий раздел вместе с кодом.

## Как пользоваться этим файлом

1. Прочитайте разделы «Ограничения», «Архитектура и границы» и «Правила публикации» до начала правок.
2. Найдите задачу в «Карта репозитория» и «Где искать ответ» — не сканируйте весь проект наугад.
3. Перед изменением поведения проверьте, не описано ли оно в «Поток запроса», «API add-on» или «YAM-плагин».
4. После изменения запустите минимальный набор проверок из «Быстрые команды» и «Матрица проверок».
5. Если задача требует нарушить правило — остановитесь, объясните ограничение и предложите проверяемый обходной путь. Не делайте исключение «втихую».
6. Не выдумывайте результаты тестов, версии, ответы Home Assistant, состояние колонки или наличие ключей. Если проверка не выполнялась, так и напишите.

Приоритет правил при конфликте:

1. Безопасность и секреты.
2. Архитектурные границы и совместимость с YAM/HA.
3. Публикация репозитория.
4. Стиль и удобство.

## Кратко для агента (TL;DR)

- Hasar — три части: Rust-плагин для YAM, Node.js add-on для Home Assistant и тонкая HACS-интеграция на Python.
- Плагин — только транспорт: HTTPS, pairing, bearer, TLS fingerprint, WAV через `aplay`, LED/часы, WebSocket heartbeat. Никакого STT и микрофона.
- Add-on — «мозг»: routing, OpenAI/Gemini, MCP-tools, Piper, отправка аудио в плагин, web UI.
- HACS-интеграция — только мастер привязки, config entry и dry-run сервис `hasar.recognize_intent`. Бизнес-логики там быть не должно.
- Ключи и токены шифруются AES-256-GCM; в API отдаются маской; в логи не попадают.
- UI работает за ingress, без сборщика, без inline-стилей и скриптов, только относительный `API_BASE`.
- `PLAN.md`, `docs/YAM-RESEARCH.md`, `docs/internal/`, `ref/`, `dist/`, `target/`, `.env`, `config.json`, `pairing.json`, `master.key`, сертификаты и реальные IP не публикуются.
- Перед коммитом: `npm run check`, `py_compile`, проверка секретов, `git diff --cached --check`.
- CI намеренно нет; не добавляйте workflow без просьбы.
- Ограничения (нет PCM/STT, нет реального HA-стенда, YAM v2 без супервизора служб) нельзя «починить» выдумкой — их нужно явно называть.

## Что это

Hasar — локальный мост между колонкой с YAM и Home Assistant. Три части:

1. `yam/` — Rust-плагин `.yap` для YAM. Тонкий слой: HTTPS API на колонке, pairing, bearer-токены, TLS fingerprint, проигрывание WAV, LED/часы, WebSocket heartbeat.
2. `addon/` — Node.js/TypeScript add-on Home Assistant. «Мозг»: маршрутизация, OpenAI/Gemini, MCP-tools, Piper, отправка аудио в плагин, web UI.
3. `custom_components/hasar/` — HACS-интеграция на Python. Только мастер привязки, config entry и dry-run сервис `hasar.recognize_intent`. Бизнес-логики здесь быть не должно.

Публичный репозиторий: `https://github.com/Thedamem/hasar`.

| Часть | Язык/рантайм | Точка входа | Роль |
|---|---|---|---|
| `yam/` | Rust, musl AArch64 | `yam/src/main.rs` | Плагин на колонке, локальный HTTPS API |
| `addon/` | Node.js 20+, TypeScript ESM | `addon/src/index.ts` | Оркестратор, провайдеры, MCP, TTS, UI |
| `custom_components/hasar/` | Python, Home Assistant | `custom_components/hasar/__init__.py` | Мастер привязки и dry-run intent |

## Карта репозитория

```text
.
├── addon/                     # Home Assistant add-on (Node.js/TypeScript)
│   ├── config.yaml            # манифест add-on, ingress :8097
│   ├── Dockerfile             # multi-stage: tsc → node:22-slim
│   ├── package.json           # скрипты build/check/dev/start
│   ├── package-lock.json      # фиксированные зависимости
│   ├── tsconfig.json          # NodeNext, strict, noUncheckedIndexedAccess
│   └── src/
│       ├── index.ts           # Fastify, HTTP API, статика UI, ошибки
│       ├── config.ts          # zod-схема, load/save, маска секретов
│       ├── secrets.ts         # AES-256-GCM, master.key
│       ├── pipeline.ts        # routing и оркестрация ответа
│       ├── debug.ts           # in-memory журнал последних запросов
│       ├── models.ts          # discovery моделей OpenAI/Gemini
│       ├── gemini.ts          # base URL, заголовки, Live URL
│       ├── openai-base.ts     # нормализация OpenAI base URL
│       ├── http.ts            # JSON HTTP + SOCKS5
│       ├── ha.ts              # вызовы Home Assistant/Assist
│       ├── plugin.ts          # HTTPS-клиент плагина + fingerprint
│       ├── pairing.ts         # pairing с плагином
│       ├── audio.ts           # PCM → WAV
│       ├── llm/               # openai.ts, gemini.ts, gemini-live.ts, types.ts
│       ├── mcp/client.ts      # MCP HTTP/SSE/stdio
│       ├── tts/piper.ts       # Wyoming TCP
│       └── ui/                # index.html, styles.css, app.js
├── custom_components/hasar/   # HACS-интеграция
│   ├── __init__.py            # setup/unload, регистрация сервиса
│   ├── config_flow.py         # discovery add-on и pairing
│   ├── const.py               # DOMAIN, версия, URL-подсказки
│   ├── services.py            # hasar.recognize_intent
│   ├── services.yaml          # описание сервиса
│   ├── manifest.json          # after_dependencies: conversation, hassio
│   ├── strings.json           # тексты/ошибки config flow
│   └── translations/          # en.json, ru.json
├── yam/                       # YAM-плагин (Rust)
│   ├── Cargo.toml             # hasar-agent 0.1.1
│   ├── build-yap.sh           # кросс-сборка musl + .yap
│   ├── packaging/plugin.toml  # манифест пакета
│   ├── src/
│   │   ├── main.rs            # запуск, TLS, pairing, state
│   │   ├── api.rs             # HTTP/WS endpoints, auth middleware
│   │   ├── auth.rs            # pairing-код и токены
│   │   ├── config.rs          # аргументы и пути
│   │   ├── playback.rs        # aplay, WAV, статус
│   │   ├── tls.rs             # самоподписанный сертификат
│   │   └── yam.rs             # клиент runtime API YAM
│   ├── examples/              # self-test пакеты (Lua и binary)
│   └── README.md
├── docs/
│   ├── YAM-PLUGIN-API.md      # публичная карта YAM API
│   └── YAM-RESEARCH.md        # внутренний, gitignored
├── PLAN.md                    # внутренний план, gitignored
├── ref/                       # локальные клоны YAM/Luna, gitignored
├── repository.yaml            # репозиторий add-on
├── hacs.json                  # метаданные HACS
├── README.md                  # публичная документация
├── AGENTS.md                  # этот файл
└── LICENSE
```

### Add-on (`addon/`)

| Модуль | Ответственность | Чего делать нельзя |
|---|---|---|
| `index.ts` | Fastify, маршруты, статика, error handler, security headers | Тащить бизнес-логику из `pipeline.ts` |
| `config.ts` | zod-схема, загрузка/сохранение, `redactedConfig` | Хранить секреты в открытом виде |
| `secrets.ts` | AES-256-GCM, ключ из env или `/data/master.key` | Логировать ключи и ciphertext |
| `pipeline.ts` | Выбор маршрута, Assist/LLM/Live, MCP, TTS | Знать про Fastify и HTTP |
| `llm/openai.ts` | Chat Completions + tool calls | Добавлять Realtime/Responses API |
| `llm/gemini.ts` | `generateContent` | Ожидать tools в chat-режиме |
| `llm/gemini-live.ts` | WebSocket `bidiGenerateContent`, аудио + transcript | Добавлять микрофонный PCM-вход |
| `mcp/client.ts` | HTTP/SSE/stdio, префиксы tools, изоляция ошибок | Ронять весь запрос из-за одного сервера |
| `tts/piper.ts` | Wyoming TCP → WAV | Подменять Piper на HTTP без необходимости |
| `plugin.ts` | HTTPS-клиент плагина, fingerprint pinning | Отключать проверку fingerprint |
| `pairing.ts` | Обмен кода на токен | Хранить pairing-код |
| `ha.ts` | `conversation.process`, `hasar.recognize_intent` | Выполнять intents самостоятельно |
| `models.ts` | `/models` OpenAI и Gemini | Фильтровать модели «на глаз» |
| `ui/*` | SPA без сборщика | Inline-стили/скрипты, innerHTML с данными |

### Плагин (`yam/`)

| Файл | Ответственность |
|---|---|
| `main.rs` | Чтение конфигурации, создание TLS, `device_id`, загрузка токенов, запуск axum |
| `api.rs` | Публичные `/healthz`, `/v1/pairing`, `/v1/pair`; защищённые `/v1/*`; WebSocket `/v1/events` |
| `auth.rs` | Pairing-код (10 минут, 5 попыток), токены `hsr_…`, хранение SHA-256 |
| `playback.rs` | Проверка WAV, лимит 20 MiB, `aplay -q -D default`, отмена, статус |
| `tls.rs` | Самоподписанный сертификат, стабильный fingerprint из PEM |
| `yam.rs` | Сырой HTTP/1.1 к `YAM_API_URL` с `X-YAM-Token` |
| `build-yap.sh` | Кросс-сборка `aarch64-unknown-linux-musl`, упаковка `.yap` |

### HACS-интеграция (`custom_components/hasar/`)

| Файл | Ответственность |
|---|---|
| `config_flow.py` | Автопоиск add-on, проверка `/health` + `/api/config`, pairing, confirm |
| `services.py` | `hasar.recognize_intent`: dry-run через conversation agent |
| `__init__.py` | Регистрация сервиса, сохранение данных entry |
| `const.py` | `DOMAIN`, версия, подсказки hostname |
| `manifest.json` | `config_flow`, `after_dependencies`, версия |

### Документация, примеры, локальные клоны

- `README.md` — публичное описание, установка, API, безопасность. Обновляйте при изменении пользовательского поведения.
- `docs/YAM-PLUGIN-API.md` — публичная карта возможностей YAM. Можно коммитить.
- `docs/YAM-RESEARCH.md`, `docs/internal/`, `PLAN.md` — внутренние материалы, gitignored. Не добавляйте их через `git add -f`.
- `ref/yam`, `ref/luna` — локальные reference-клоны, gitignored. Не переносите оттуда код без проверки лицензии и совместимости.
- `yam/examples/` — self-test пакеты. Они публичные; не кладите туда реальные токены, IP и записи речи.

### Где искать ответ

| Вопрос | Файл |
|---|---|
| Как выбирается маршрут? | `addon/src/pipeline.ts` |
| Как сохраняются секреты? | `addon/src/secrets.ts`, `addon/src/config.ts` |
| Какой endpoint у add-on? | `addon/src/index.ts`, раздел «API add-on» |
| Почему не грузятся модели? | `addon/src/models.ts`, `addon/src/gemini.ts`, `addon/src/openai-base.ts` |
| Почему нет звука? | `addon/src/pipeline.ts`, `addon/src/tts/piper.ts`, `addon/src/plugin.ts` |
| Почему не привязывается колонка? | `addon/src/pairing.ts`, `yam/src/auth.rs`, `yam/src/tls.rs` |
| Почему HACS не находит add-on? | `custom_components/hasar/config_flow.py`, `const.py` |
| Что умеет плагин? | `yam/src/api.rs`, `yam/README.md` |
| Что умеет YAM API? | `docs/YAM-PLUGIN-API.md` |
| Что нельзя публиковать? | раздел «Правила публикации» |

## Поток запроса

### Общая схема

```text
POST /api/ask  (или будущий вызов со станции)
  └─ pipeline.ask
       ├─ запись стартового события в debug ring buffer
       ├─ hasTrigger / routing.mode
       │    ├─ auto: HA hasar.recognize_intent (dry-run)
       │    │        └─ intent в allowlist → conversation.process (Assist)
       │    ├─ assist: conversation.process, при ошибке → LLM
       │    └─ llm / trigger: сразу LLM
       ├─ LLM-ветка
       │    ├─ OpenAI: /chat/completions + MCP tools (до 6 раундов)
       │    ├─ Gemini chat: generateContent (без tools)
       │    └─ Gemini Live: WebSocket, текст → аудио + transcript
       └─ speak
            ├─ Piper → WAV
            └─ plugin POST /v1/play
```

### Шаг за шагом

1. `POST /api/ask` валидирует тело: `text` (минимум 1 символ), `speak` (по умолчанию `true`), `source` (`station | debug | api`, по умолчанию `api`).
2. `pipeline.ask` обрезает пробелы, отклоняет пустой текст, фиксирует провайдера, модель и время старта.
3. `askInner` проверяет явные триггеры LLM, затем режим.
4. Ветка возвращает `AskResult`: `route` (`assist | chat | gemini-live`), `text`, опциональный `intent`, `audio` (`played | skipped | failed`).
5. `recordAsk` пишет событие в ring buffer на 50 записей: источник, текст (до 2000 символов), маршрут, intent, провайдер, модель, длительность, аудио или ошибку.
6. Ошибка также попадает в журнал и возвращается в `/api/ask` как HTTP 400 с очищенным текстом.

### Режимы маршрутизации

| Режим | Поведение | Когда использовать |
|---|---|---|
| `llm` | Всегда LLM | Отладка модели, сложные диалоги |
| `assist` | Сначала Assist; пустой/ошибочный ответ → LLM | Дом должен отвечать быстро и локально |
| `auto` | Dry-run intent; allowlist → Assist; иначе LLM | Значение по умолчанию |

Важные детали:

- Явный триггер (`routing.llmTriggers`) проверяется до режима и переводит запрос в LLM даже в `assist`.
- Триггеры — подстроки без учёта регистра; пустые строки игнорируются.
- В `auto` Assist вызывается только если intent распознан и входит в `routing.intentAllowlist`. Иначе запрос уходит в LLM, а не в Assist.
- Если `hasar.recognize_intent` недоступен (интеграция не установлена, HA не отвечает), `recognizeIntent` возвращает `null`, и `auto` деградирует в LLM. Это ожидаемое поведение, а не ошибка.
- Если Assist вернул пустой текст или упал, `auto`/`assist` уходят в LLM.
- `routing.sessionTimeoutSeconds` объявлен в схеме и UI, но `pipeline.ts` его пока не использует. Не описывайте его как работающий таймаут сессии. Если будете реализовывать — добавьте состояние сессии, очистку и тест.

## Правила публикации

В репозиторий не должны попадать:

- `PLAN.md`, `docs/YAM-RESEARCH.md`, `docs/internal/`, `ref/`;
- `node_modules/`, `dist/`, `target/`, собранные `.yap`, логи;
- `.env`, `config.json`, `pairing.json`, `master.key`, сертификаты, токены, API-ключи;
- реальные IP колонок, домашние пути, имена пользователей и другие личные данные;
- секреты провайдеров даже в примерах и тестах.

Перед коммитом проверяйте:

```sh
git status --short
git diff --cached --check
git grep -nE 'sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}' -- . ':!AGENTS.md'
```

CI пока намеренно не добавлен. Не добавляйте workflow без просьбы.

### Что можно публиковать

- Исходники `addon/`, `yam/`, `custom_components/`, `docs/YAM-PLUGIN-API.md`, `yam/examples/`.
- `README.md`, `LICENSE`, `repository.yaml`, `hacs.json`, `AGENTS.md`.
- Примеры конфигурации без реальных ключей и адресов; используйте `192.0.2.0/24`, `example.com`, `sk-test`.

### Дополнительные проверки

```sh
# Токены плагина и ключи в неожиданных местах
git grep -nE 'hsr_[A-Za-z0-9_-]{20,}|enc:v1:' -- . ':!AGENTS.md'

# Приватные ключи и PEM
git grep -nE 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|BEGIN CERTIFICATE' -- .

# Личные пути, имена и домашние адреса
git grep -nE '/home/[a-z0-9_-]+|/Users/[A-Za-z0-9_-]+' -- .
```

Не добавляйте в репозиторий тестовые артефакты (`*.wav`, `*.log`, `*.sqlite`, дампы) без явной необходимости. Если пример нужен — держите его маленьким и синтетическим.

### Если секрет уже попал в git

1. Не пытайтесь «замазать» его новым коммитом: история сохранит значение.
2. Немедленно отзовите ключ/токен у провайдера и в плагине (`tokens.json` можно очистить, pairing закрыт).
3. Удалите секрет из истории (`git filter-repo`/BFG) и предупредите пользователя.
4. Проверьте, не ушёл ли репозиторий в remote/форк.
5. Только после ротации добавляйте защиту от повторения (grep-правило, тест, `.gitignore`).

### Версии

Версии синхронизированы в нескольких местах; поднимайте их одним коммитом.

| Компонент | Где менять | Текущая |
|---|---|---|
| Add-on | `addon/config.yaml`, `addon/package.json`, строка в `/health` (`addon/src/index.ts`) | `0.2.1` |
| Плагин | `yam/Cargo.toml`, `yam/packaging/plugin.toml`, `VERSION` в `yam/build-yap.sh` | `0.1.1` |
| HACS-интеграция | `custom_components/hasar/const.py`, `custom_components/hasar/manifest.json` | `0.1.4` |

Правила:

- Меняете установленный образ add-on — поднимите все три места add-on.
- Меняете `.yap` — поднимите версию плагина; старые `.yap` не перезаписывайте.
- Меняете интеграцию — поднимите версию в `const.py` и `manifest.json`.
- Не поднимайте версию «на всякий случай» без изменения поведения.

## Быстрые команды

Add-on:

```sh
cd addon
npm ci
npm run check      # tsc --noEmit
npm run build      # dist/
npm run dev        # tsx src/index.ts
```

Плагин:

```sh
./yam/build-yap.sh
```

Проверка Python-интеграции:

```sh
python3 -m py_compile custom_components/hasar/*.py
```

Docker-образ add-on:

```sh
cd addon
docker build -t hasar-addon:test .
```

Локальный запуск add-on с отдельной папкой данных:

```sh
HASAR_DATA_DIR=/tmp/hasar-data node dist/index.js
```

По умолчанию UI и API слушают `:8097`. В Supervisor наружу порт не публикуется: UI открывается через ingress, интеграция ходит на `http://local-hasar:8097`.

### Дополнительно

```sh
# Проверка синтаксиса и типов без сборки
cd addon && npm run check

# Запуск собранного add-on
cd addon && npm run start

# Проверка здоровья и конфигурации
curl -s http://127.0.0.1:8097/health
curl -s http://127.0.0.1:8097/api/config | head

# Rust: быстрая проверка на хосте (если установлен toolchain)
cd yam && cargo check

# Список публичных файлов, которые уйдут в коммит
git ls-files
```

Требования к окружению: Node.js ≥ 20 (в Docker используется 22), npm, Python 3.11+ для `py_compile`, Docker для `.yap`, Rust toolchain — опционально. В этой среде нет гарантированного Home Assistant, MCP-стенда и реальных ключей; см. «Тестирование без реальных ключей».

## Конфигурация, данные и окружение

### Файлы add-on

| Путь | Что это | Права/примечание |
|---|---|---|
| `${HASAR_DATA_DIR:-/data}/config.json` | Конфигурация; секреты внутри зашифрованы | `0600`, атомарная запись через `.tmp` + `rename` |
| `${HASAR_DATA_DIR:-/data}/master.key` | 32 байта ключа AES-256-GCM | `0600`, создаётся при первом сохранении |
| `${HASAR_DATA_DIR:-/data}/options.json` | Опции Supervisor | Читается только `log_level`; не редактируйте вручную |
| stdout | Логи Fastify/pino | Секреты редактируются |

Локально используйте отдельную папку (`HASAR_DATA_DIR=/tmp/hasar-data`), чтобы не смешивать тестовые и рабочие данные.

### Файлы плагина

По умолчанию `/data/quazar/yam/data/hasar-agent/` (переопределяется `HASAR_DATA_DIR`):

| Путь | Что это | Права |
|---|---|---|
| `cert.pem` | Самоподписанный сертификат | `0644` |
| `key.pem` | Приватный ключ | `0600` |
| `fingerprint.txt` | `sha256:<hex>` от DER сертификата | `0644` |
| `device_id` | UUID устройства | `0600` |
| `tokens.json` | Хэши выданных токенов | `0600` |
| `pairing.json` | Временный код pairing | `0600`, удаляется после успеха/истечения |

Каталог данных создаётся с `0700`. Не удаляйте `tokens.json` при обновлении: это отзовёт все привязки. Не удаляйте `key.pem`/`cert.pem`: сменится fingerprint, и add-on перестанет доверять колонке.

### Переменные окружения

Add-on:

| Переменная | Назначение | Приоритет |
|---|---|---|
| `HASAR_DATA_DIR` | Каталог данных | По умолчанию `/data` |
| `LOG_LEVEL` | Уровень логов | Перекрывается `options.json.log_level` |
| `HASAR_SECRET` | Мастер-ключ: 64 hex или пароль | Выше `/data/master.key` |
| `SUPERVISOR_TOKEN` | Токен Supervisor для HA API | Автоматически в add-on |
| `HA_TOKEN` | Альтернативный токен HA | Если нет `SUPERVISOR_TOKEN` |
| `HA_URL` | Базовый URL HA API | Иначе `http://supervisor/core/api` |

Плагин:

| Переменная | Назначение |
|---|---|
| `HASAR_DATA_DIR` | Каталог данных (по умолчанию `/data/quazar/yam/data/hasar-agent`) |
| `HASAR_ADVERTISE_URL` | URL, который попадёт в `pairing.json` (по умолчанию `https://hasar.local:8443`) |
| `YAM_API_URL` | Runtime API YAM; обязателен, только `http://` |
| `YAM_API_TOKEN` | Токен runtime API; обязателен |
| `YAM_PLUGIN_ID` | id пакета; передаётся YAM, плагином сейчас не используется |

HACS-интеграция:

| Переменная | Назначение |
|---|---|
| `SUPERVISOR` | Адрес Supervisor API (ставит HA) |
| `SUPERVISOR_TOKEN` | Токен Supervisor (ставит HA) |

### Приоритет источников

1. Явные аргументы командной строки плагина (`--listen`, `--data-dir`) выше env.
2. `HASAR_SECRET` выше файла `master.key`.
3. `options.json.log_level` выше `LOG_LEVEL`.
4. `PUT /api/config` сохраняет то, что пришло; маска означает «оставить прежнее значение».

### Схема `config.json`

| Ключ | Тип | По умолчанию | Примечание |
|---|---|---|---|
| `provider` | `openai \| gemini` | `openai` | Активный провайдер |
| `openai.baseUrl` | string | `https://api.openai.com/v1` | Нормализуется |
| `openai.apiKey` | string | `""` | Шифруется |
| `openai.model` | string | `""` | Обязателен для OpenAI |
| `gemini.baseUrl` | string | `https://generativelanguage.googleapis.com/v1beta` | Нормализуется |
| `gemini.apiKey` | string | `""` | Шифруется |
| `gemini.chatModel` | string | `""` | Для `generateContent` |
| `gemini.liveModel` | string | `gemini-3.8-live` | Для `bidiGenerateContent` |
| `gemini.liveEnabled` | boolean | `false` | Включает Live вместо chat |
| `systemPrompt` | string | `"Ты голосовой помощник. Отвечай кратко, по-русски и без markdown."` | Общий для chat и Live |
| `piper.url` | string | `tcp://core-piper:10200` | Только `tcp://` |
| `piper.voice` | string | `""` | Пусто — голос Piper по умолчанию |
| `routing.mode` | `auto \| assist \| llm` | `auto` | См. «Маршрутизация» |
| `routing.intentAllowlist` | string[] | 10 Hass*-intent'ов | Не расширяйте без причины |
| `routing.llmTriggers` | string[] | `хасар`, `спроси хасар`, `поговори с хасар` | Подстроки |
| `routing.sessionTimeoutSeconds` | number | `120` | Сейчас не используется pipeline |
| `proxy.socks5` | string | `""` | Шифруется; только модели и Gemini Live |
| `mcpServers[]` | объект | `[]` | См. ниже |
| `plugin.url` | string | `""` | Только `https://` |
| `plugin.token` | string | `""` | Шифруется |
| `plugin.fingerprint` | string | `""` | `sha256:<hex>`, не секрет |

`mcpServers[]`:

| Поле | Тип | По умолчанию | Примечание |
|---|---|---|---|
| `name` | string | обязателен | Префикс tools |
| `transport` | `http \| sse \| stdio` | `http` | HTTP сначала, fallback на SSE |
| `url` | string | `""` | Для http/sse |
| `command` | string | `""` | Для stdio |
| `args` | string[] | `[]` | Для stdio |
| `headers` | record | `{}` | Значения шифруются |
| `enabled` | boolean | `true` | Выключенные не подключаются |

Замечания:

- Не редактируйте `config.json` вручную. Открытый текст при загрузке принимается и будет зашифрован при следующем сохранении.
- Пустые секреты остаются пустыми, непустые в `GET /api/config` заменяются на `SECRET_MASK`.
- `plugin.fingerprint` не маскируется: это публичная величина.
- Не добавляйте новые поля только в UI или только в схему: см. чек-лист в разделе «UI add-on».

## Архитектура и границы

### Маршрутизация

Порядок в `addon/src/pipeline.ts`:

1. Явный триггер LLM (`routing.llmTriggers`) → сразу LLM.
2. Режим `llm` → LLM.
3. Режим `assist` → Assist, при ошибке fallback в LLM.
4. Режим `auto` → dry-run `hasar.recognize_intent`; если intent в allowlist → Assist; иначе LLM.

Не расширяйте allowlist по умолчанию без причины. Бытовые команды должны оставаться в Assist, а не уходить в модель.

Уточнения:

- Allowlist по умолчанию: `HassTurnOn`, `HassTurnOff`, `HassToggle`, `HassGetState`, `HassSetPosition`, `HassStartTimer`, `HassCancelTimer`, `HassCancelAllTimers`, `HassTimerStatus`, `HassClimateGetTemperature`.
- `recognize_intent` — именно dry-run: сервис не выполняет действие, а возвращает `matched`, `intent`, `slots`, `unmatched_entities`.
- `matched` вычисляется как «нет unmatched_entities», а не как «intent не пустой». Учитывайте это при отладке.
- Assist вызывается через `conversation.process` с `agent_id: conversation.home_assistant`; текст берётся из `response.speech.plain.speech` или `response.speech.text`.
- В `auto` при неудачном Assist после успешного intent запрос всё равно уходит в LLM. Это осознанный fallback, не баг.
- Не добавляйте сюда прямые вызовы сервисов HA (`light.turn_on` и т.п.) в обход Assist: это ломает allowlist и безопасность.

### Провайдеры

- OpenAI: только обычные Chat Completions (`/chat/completions`). **Не добавляйте OpenAI Realtime.**
- Gemini AI Studio: `generateContent` для chat и `bidiGenerateContent` для Live.
- Gemini Live используется только с текстовым входом и аудиовыходом. Микрофона/PCM-входа у плагина нет.
- Ключи передаются в заголовках: `Authorization: Bearer ...` и `x-goog-api-key`. Не возвращайте ключи в query string.
- SOCKS5 применяется к HTTP-запросам моделей и WebSocket Gemini Live. MCP-транспорты сейчас идут напрямую; не обещайте прокси для MCP в UI/README.

Детали OpenAI:

- Endpoint: `${openAiBaseUrl}/chat/completions`.
- `openAiBaseUrl` убирает хвостовые `/`, `/chat/completions`, `/models`; для `https://api.openai.com` добавляет `/v1`.
- Заголовок `Authorization` ставится только если ключ непустой (локальные mock-серверы могут работать без ключа).
- Таймаут 120 секунд.
- Ответ: `choices[0].message.content` и `tool_calls[]`; аргументы парсятся из JSON-строки, при ошибке — `{}`.
- Если модель вернула tool calls, pipeline выполняет их и отправляет результаты обратно; максимум 6 раундов.

Детали Gemini:

- Chat: `POST {base}/models/{model}:generateContent`, тело `{systemInstruction, contents}`.
- Chat не поддерживает tools: если в ответе есть `functionCall`, выбрасывается ошибка. Не обещайте MCP-tools в Gemini chat.
- Live: WebSocket `wss://…/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`.
- Live setup: `model: models/<id>`, `responseModalities: ["AUDIO"]`, `systemInstruction`, `outputAudioTranscription`, опционально `tools`.
- Live отправляет текст только после `setupComplete` через `realtimeInput.text`.
- Live собирает `inlineData` (base64 PCM), sample rate из `mimeType` (`rate=...`), transcript из `outputTranscription.text`.
- Live завершается по `turnComplete`, `interrupted`, закрытию сокета или таймауту 45 секунд.
- Live получает MCP-tools и умеет `toolCall`/`toolResponse`.
- `geminiBaseUrl` убирает `/models`, добавляет `https://` при отсутствии схемы и `/v1beta` для корня `generativelanguage.googleapis.com`.

Прокси:

- `proxy.socks5` применяется в `http.ts` (`SocksProxyAgent`) и в `gemini-live.ts`.
- Не применяется к MCP, HA API и plugin API.
- Не логируйте URL прокси с учётными данными; в UI он маскируется как секрет.

### LLM tool loop

- Сообщения: `system`, `user`, затем `assistant` с `toolCalls` и `tool` с результатами.
- Максимум 6 раундов; после исчерпания — ошибка `LLM exceeded the tool-call limit`.
- Ошибка одного tool не роняет запрос: в историю уходит `error: ...`, модель может продолжить.
- `mcp.close()` вызывается в `finally`, даже при ошибке.
- Для OpenAI tool call без `id` генерируется `call_<index>`.
- Не добавляйте бесконечный цикл и не выполняйте tools параллельно без необходимости: порядок сообщений важен для OpenAI.

### Piper

Piper — отдельный add-on, Wyoming TCP, по умолчанию `tcp://core-piper:10200`. Клиент в `addon/src/tts/piper.ts`:

1. `synthesize`;
2. `audio-start` / `audio-chunk` / `audio-stop`;
3. сборка WAV;
4. `POST /v1/play` в плагин с bearer-токеном.

Gemini Live не использует Piper: PCM сразу превращается в WAV и уходит в плагин.

Детали:

- URL обязан быть `tcp://`; иначе ошибка.
- Порт по умолчанию `10200`.
- Запрос — одна JSON-строка: `{"type":"synthesize","data":{"text":"…","voice":{"name":"…"}}}`; `voice` добавляется только если задан.
- Ответ — Wyoming-фреймы: JSON-заголовок + `\n`, затем `data_length` байт data и `payload_length` байт payload.
- Поддерживаются `audio-start`, `audio-chunk`, `audio-stop`, `error`.
- По умолчанию 22050 Гц, 16 бит, моно; значения из `audio-start` перекрывают.
- Таймаут 60 секунд; закрытие до `audio-stop` — ошибка.
- WAV-заголовок собирается вручную (44 байта, PCM).
- Если `plugin.url` пуст, `speak()` всё равно сначала вызывает Piper, затем возвращает `skipped`. При оптимизации сначала проверяйте URL.

### MCP

Клиент в `addon/src/mcp/client.ts` поддерживает HTTP, SSE и stdio. Имена tools получают префикс сервера. Ошибка одного сервера не должна ломать остальные. Заголовки MCP-серверов могут содержать токены: в API они маскируются, на диске шифруются.

Детали:

- Для `http` сначала пробуется `StreamableHTTPClientTransport`; при ошибке подключения — `SSEClientTransport`.
- Для `sse` используется только SSE; для `stdio` — `StdioClientTransport` с `command`/`args`.
- Имя tool: `<sanitized server name>__<sanitized tool name>`, каждый сегмент до 40 символов, разрешены `[a-zA-Z0-9_-]`.
- При совпадении имён побеждает последний сервер; не создавайте одинаковые имена.
- Соединения открываются на каждый LLM-запрос с tools (OpenAI и Gemini Live) и закрываются в `finally`; пула нет.
- Результат tool: текстовые блоки соединяются `\n`, не-текстовые сериализуются в JSON; `isError` превращается в исключение.
- `stdio` запускает произвольную команду внутри контейнера add-on. Добавляйте только доверенные серверы; не принимайте команды из недоверенного ввода.
- MCP не ходит через SOCKS5. Не пишите обратное в UI/README.

### HACS-интеграция

`custom_components/hasar/` — только:

- config flow (автоопределение add-on через Supervisor; адрес add-on; IP/порт колонки и pairing-код либо подтверждение уже существующей привязки add-on);
- config entry;
- сервис `hasar.recognize_intent` (dry-run, без выполнения действий).

Не переносите сюда вызовы LLM, MCP, Piper или маршрутизацию.

На Home Assistant OS / Supervised config flow сначала читает установленные add-on из уже загруженной интеграции `hassio` (`get_addons_info`), затем при необходимости падает обратно на Supervisor API (`/addons`, `/addons/{slug}/info`): hostname и `ingress_port`, и проверяет `/health` + `/api/config`. Не хардкодьте `local-hasar` как единственный адрес: у add-on из Git-репозитория hostname имеет префикс репозитория.

Детали:

- Порядок discovery: кэш `hassio` → Supervisor API → локальный IP HA → fallback-список.
- Совпадение add-on: подстрока `hasar` в `slug` или `name` (`SLUG_HINTS`).
- URL-кандидаты: `hostname`, `hostname.local.hass.io`, `ip_address`; порт — `ingress_port` или `8097`.
- Проверка «это Hasar»: `/health` вернул `status: ok`, `/api/config` содержит `provider` и `plugin`.
- Таймауты: авто-проба 2 с / 1 с; ручная 6 с / 2 с; Supervisor 6 с; pairing 25 с.
- Ошибки формы: `supervisor_unavailable`, `addon_stopped`, `addon_missing`, `not_supervised`, `bad_response`, `cannot_connect`, `timeout`, `cannot_connect_pairing`, `cannot_pair`, `invalid_host`.
- `unique_id` — URL плагина; повторная привязка того же URL абортится.
- Config entry хранит только `addon_url` и `plugin_url`; токен плагина остаётся в add-on. Код pairing нигде не сохраняется.
- Если `GET /api/config` вернул непустой `plugin.token` (маску), мастер считает колонку уже привязанной и предлагает подтверждение.
- Сервис регистрируется в `async_setup` (не в `async_setup_entry`) и только один раз.
- `recognize_intent` вызывает `async_recognize_intent` conversation-агента; сначала со `strict_intents_only=True`, при `TypeError` — без него. Это совместимость с разными версиями HA.
- Сервис не выполняет действия и не вызывает LLM. Не добавляйте сюда `conversation.process`.
- Интеграция не создаёт entities, не опрашивает add-on после настройки и не хранит историю.

### YAM-плагин

Плагин — отдельный `.yap`-пакет `hasar-agent`. Он не знает про Home Assistant, модели и MCP.

Публичные endpoints:

| Метод | Путь | Авторизация | Ответ |
|---|---|---|---|
| `GET` | `/healthz` | нет | `status`, `version`, `api_version` |
| `GET` | `/v1/pairing` | нет | `device_id`, `model`, `fingerprint`, `pairing_open`, `api_version` |
| `POST` | `/v1/pair` | код | `token`, `device_id`, `api_version` |

Защищённые endpoints (Bearer):

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/v1/info` | Модель, features, capabilities |
| `GET` | `/v1/state` | Статус playback и pairing |
| `POST` | `/v1/play` | WAV в теле, `202 {id}` |
| `POST` | `/v1/cancel` | Остановить playback, `204` |
| `POST` | `/v1/led` | `{colors: string[]}`, `204` |
| `POST` | `/v1/led/off` | `204` |
| `POST` | `/v1/clock` | `{time?, brightness?, off}`, `204` |
| `GET` | `/v1/events` | WebSocket: `hello` + heartbeat каждые 15 с |

Детали:

- `POST /v1/play` принимает только WAV (`RIFF`/`WAVE`), максимум 20 MiB; сохраняет во временный файл и запускает `aplay -q -D default`.
- Новый play останавливает предыдущий; `/v1/cancel` убивает процесс и удаляет файл; статус подчищает завершённые файлы.
- `/v1/led` принимает массив цветов без строгой валидации; add-on ограничивает debug-запрос 1..64 цветами.
- `/v1/clock` принимает `time` строкой, `brightness` 0..255, `off` boolean.
- `/v1/info` отдаёт фиксированные capabilities: `speech_events: false`, `native_tts: false`, `audio_playback: true`, `led: true`, `clock: true`, `buttons: false`, `mic: false`, `live: false`.
- `/v1/events` защищён bearer; после подключения отправляет `hello` с device, затем heartbeat; входящие Ping получают Pong. Событий речи нет.
- Pairing: код 8 символов из алфавита без `I/L/O/U`, TTL 10 минут, 5 попыток. После успеха `pairing.json` удаляется, токен выдаётся один раз.
- Токены: `hsr_<base64url(32 bytes)>`; на диске только SHA-256. Очистка `tokens.json` отзывает все привязки и снова открывает pairing при следующем старте.
- TLS: самоподписанный сертификат для `hasar.local`, `localhost`; fingerprint считается от точного PEM, который отдаёт rustls. Ключ `0600`, сертификат `0644`.
- Add-on проверяет fingerprint перед каждым запросом (TLS-соединение + сравнение сертификата) и дополнительно сверяет сертификат ответа. `rejectUnauthorized: false` допустим только вместе с pinning.
- YAM client: только `http://`, сырой HTTP/1.1, заголовок `X-YAM-Token`, таймауты 10 с. Endpoints: `/device`, `/led`, `/led/off`, `/clock`.
- Плагин не хранит расшифровки, ключи провайдеров и историю запросов.

## YAM v2

YAM v2 (`main`, `.yampkg`, `yam.yaml`, platform profiles) — package manager без
супервизора служб. Пакет может объявить `services`, но YAM v2 их не запускает;
Luna пока использует старые `.yap`/`plugin.toml`. Не мигрируйте `hasar-agent`
на `.yampkg`, пока не появится host/supervisor для служб: иначе пакет будет
устанавливаться, но не работать. Локальные reference-клоны: `ref/yam`,
`ref/luna` (gitignored).

## API add-on

Fastify обслуживает `/health`, статику и `/api/*` на `0.0.0.0:8097`. Отдельной авторизации у add-on нет: доступ ограничен ingress Home Assistant и внутренней сетью add-on. Не публикуйте порт наружу и не добавляйте CORS.

| Метод | Путь | Тело | Ответ | Примечание |
|---|---|---|---|---|
| `GET` | `/health` | — | `{status:"ok", version}` | Используется watchdog и HACS-пробой |
| `GET` | `/` | — | HTML UI | CSP, no-cache |
| `GET` | `/index.html` | — | HTML UI | То же |
| `GET` | `/styles.css` | — | CSS | no-cache |
| `GET` | `/app.js` | — | JS | no-cache |
| `GET` | `/favicon.ico` | — | `204` | — |
| `GET` | `/api/config` | — | Конфиг с маской | Секреты не отдаются |
| `PUT` | `/api/config` | Полный `Config` | Конфиг с маской | Маска сохраняет прежний секрет |
| `POST` | `/api/models` | `{provider?, openai?, gemini?}` | `{chat:[], live:[]}` | Принимает текущие baseUrl/ключ из формы |
| `GET` | `/api/status` | — | Провайдер, модели, Piper, routing, число MCP | UI сейчас не использует |
| `POST` | `/api/ask` | `{text, speak?, source?}` | `AskResult` | Основной вход |
| `POST` | `/api/pair` | `{pluginUrl, code}` | `{ok, device_id, fingerprint}` | Сохраняет токен и fingerprint |
| `GET` | `/api/debug/plugin` | — | `{info, state, ledCount}` | Параллельно info+state |
| `POST` | `/api/debug/led` | `{colors: string[]}` | `{ok:true}` | 1..64 цвета |
| `POST` | `/api/debug/led/off` | — | `{ok:true}` | — |
| `POST` | `/api/debug/clock` | `{time?, brightness?, off?}` | `{ok:true}` | `time` не валидируется по формату на сервере |
| `POST` | `/api/debug/cancel` | — | `{ok:true}` | Останавливает playback |
| `GET` | `/api/debug/log` | — | `{events:[]}` | Последние 50 запросов |

Правила:

- Лимит тела Fastify — 1 MiB.
- Zod-ошибки → `400 {error, issues}`; 4xx сохраняются; 5xx → `500 {error:"internal error"}` с логом.
- Публичные ошибки очищаются от `sk-…`, `AIza…`, `Bearer …`, `?key=…`.
- `onSend` ставит `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-frame-options: SAMEORIGIN`; для `/api/*` — `cache-control: no-store`.
- CSP отдаётся только для `/` и `/index.html`: `default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'`.
- `/api/models` при ошибке возвращает `400 {error, provider}` и пишет warning без ключа.
- `/api/ask` при ошибке возвращает `400 {error}`; текст ошибки уже очищен.
- Не добавляйте endpoint, который отдаёт сохранённый секрет, даже по отдельному флагу.

## Секреты add-on

- `addon/src/secrets.ts` — AES-256-GCM.
- Мастер-ключ: `/data/master.key`, режим `0600`, 32 байта. Альтернатива: env `HASAR_SECRET` (64 hex-символа или сильный пароль).
- `addon/src/config.ts` шифрует `openai.apiKey`, `gemini.apiKey`, `plugin.token`, `proxy.socks5` и значения `mcpServers[].headers`.
- `GET /api/config` возвращает `SECRET_MASK` (`••••••••`) вместо ключей, токена плагина и значений заголовков MCP.
- `proxy.socks5` шифруется на диске, но в ответе `/api/config` пока не маскируется — не полагайтесь на маску для этого поля и не выводите его в логи.
- `PUT /api/config` сохраняет старый секрет, если пришла маска. Для MCP-серверов секреты ищутся по имени, затем по URL/команде; маска без найденного предыдущего значения превращается в пустую строку, а не сохраняется как литерал.
- Не логируйте тела запросов и заголовки с ключами. Fastify уже редактирует `authorization`, `x-goog-api-key`, `cookie`.
- Не удаляйте `master.key` при обновлении add-on. Без него зашифрованные значения не восстановить.

Уточнения:

- Формат шифротекста: `enc:v1:<iv>.<tag>.<ciphertext>`, IV 12 байт, tag 16 байт, base64url.
- `HASAR_SECRET` из 64 hex-символов используется как 32 байта; иначе — `scrypt(password, "hasar-addon-v1", 32)`.
- Ключ кэшируется в памяти по каталогу данных; при ошибке кэш сбрасывается.
- `openSecret` пропускает незашифрованные значения как есть; при ошибке расшифровки пишет warning и подставляет пустую строку. Это лучше, чем падать, но означает потерю секрета — предупредите пользователя.
- `sealSecret` не шифрует пустые строки и уже зашифрованные значения (идемпотентность).
- `saveConfig` пишет во временный файл с `0600`, затем `rename`; не заменяйте на прямой `writeFile`.
- Маска — это ровно `SECRET_MASK`; не хардкодьте `••••••••` в других модулях.
- Не шифруются: URL, baseUrl, имена моделей, `plugin.fingerprint`, имя/транспорт/URL/команда MCP, systemPrompt. Не считайте их секретами.
- Ротация ключа: смена `HASAR_SECRET` или `master.key` делает старые значения нечитаемыми. Миграции нет; после смены ключа секреты нужно ввести заново. Всегда копируйте `master.key` вместе с `/data`.
- Диагностика: если после обновления все ключи пустые — проверьте, что `master.key` на месте и не изменился `HASAR_SECRET`.
- Логи: pino redact покрывает только перечисленные пути; новые заголовки с секретами добавляйте в redact и в `publicError`.

## UI add-on

Файлы: `addon/src/ui/index.html`, `addon/src/ui/styles.css`, `addon/src/ui/app.js`. Без сборщика и внешних зависимостей; add-on отдаёт их как статические маршруты `/`, `/styles.css`, `/app.js`.

Правила:

- Визуальный язык Home Assistant: светлая/тёмная тема, Roboto/system-ui, боковая навигация, верхняя панель, карточки.
- Радиусы маленькие: карточки 8px, поля и кнопки 4px. Не возвращайте крупные скругления и тяжёлые тени.
- Контент не должен быть одной вертикальной колонкой: используйте `tile-grid`, `two-col`, `split-grid`, `mcp-layout`.
- UI должен работать за HA ingress. Все запросы идут через относительный `API_BASE` и `api("api/...")`; не используйте абсолютные `/api/...`.
- Не добавляйте inline `<style>`/`<script>` и `style="..."`: CSP работает без `unsafe-inline`. Утилитарные классы складывайте в `styles.css`.
- Не вставляйте пользовательские данные через `innerHTML`. Для текста модели/ошибок используйте `textContent`.
- Формы: ключи маскируются, после сохранения показывается маска. Кнопка «Загрузить» у моделей должна отправлять текущие значения полей, а не требовать предварительного сохранения.
- Новые поля конфигурации добавляйте одновременно в `ConfigSchema`, `renderConfig`, `collectConfig` и UI.
- Мобильная версия: сайдбар уходит в drawer, сетки схлопываются, верхняя панель остаётся доступной.
- Вкладка «Отладка» использует `/api/debug/plugin`, `/api/debug/led`, `/api/debug/led/off`, `/api/debug/clock`, `/api/debug/cancel`, `/api/debug/log`. Не дублируйте эти данные в обычных настройках.
- Поток речи из Алисы пока не подключён: бинарный плагин YAM не отдаёт `ipc.speech`. Не обещайте в UI, что журнал показывает речь Алисы.

Уточнения по текущей реализации:

- Историческая формулировка про `tile-grid`, `two-col`, `split-grid`, `mcp-layout` относится к старой вёрстке. В текущем `styles.css` этих классов нет. Актуальные сетки: `overview-grid` (контент + 320px), `form-grid` (2 колонки), `summary-list` (2), `debug-grid` (2), `segmented` (2), `mcp-head`; `status-line` — вертикальный список. На узких экранах они схлопываются в 1 колонку. Если добавляете новый класс — сначала определите его в `styles.css`, потом используйте в HTML.
- Радиусы в текущем CSS: 3–6px у полей, сегментов и бренда; секции-карточки плоские. Ориентир «карточки 8px, поля 4px» можно использовать для новых компонентов, но не переделывайте существующие без задачи.
- `API_BASE` вычисляется из `window.location.pathname`: для ingress вида `/api/hassio_ingress/<token>/` берётся этот префикс, иначе — текущий каталог. Любой новый запрос должен идти через `apiUrl`/`api`.
- Роутинг страниц — по hash (`#overview`, `#models`, …), навигация — `data-page`; не добавляйте отдельные HTML-страницы.
- Состояние: `state.config`, `state.dirty`, `state.health`, `state.autoLoaded`, `state.ledCount`. Не храните секреты в localStorage.
- Сохранение: `collectConfig()` собирает полный объект, `save()` делает `PUT /api/config`, затем подставляет маски обратно в поля. Не сохраняйте маску как реальный ключ.
- Загрузка моделей: `refreshModels()` отправляет текущие `baseUrl`/`apiKey` обоих провайдеров; сервер сам решает, какой использовать. Если пришла маска, используется сохранённый ключ.
- Автозагрузка моделей: один раз на провайдера, только при наличии ключа (Gemini) или нестандартного base URL (OpenAI).
- MCP-форма: имя обязательно; для включённого http/sse обязателен URL, для stdio — команда; аргументы через запятую; заголовки по одному `Key: value` на строку; ошибка формата показывается пользователю.
- Отладка: `ledCount` берётся из feature `led.ring.N`, иначе 6; в UI ограничивается 1..24. Пресеты `off`, `pulse`, `rainbow`, `custom`; пульс/радуга отправляют несколько кадров с задержкой.
- Журнал: 50 событий в памяти, теряются при рестарте; текст и ошибка обрезаются до 2000 символов.
- Доступность: сохраняйте `label for`, `aria-live`, `aria-pressed`, `aria-current`, `role="alert"`; не заменяйте кнопки на div.
- Не добавляйте внешние шрифты, CDN, иконки и аналитику: CSP и офлайн-работа add-on этого не допускают.

### Соответствие полей

| Поле конфига | DOM id |
|---|---|
| `provider` | кнопки `[data-provider-choice]` |
| `openai.baseUrl` | `openai-base` |
| `openai.apiKey` | `openai-key` |
| `openai.model` | `openai-model` |
| `gemini.baseUrl` | `gemini-base` |
| `gemini.apiKey` | `gemini-key` |
| `gemini.chatModel` | `gemini-chat` |
| `gemini.liveModel` | `gemini-live` |
| `gemini.liveEnabled` | `gemini-live-enabled` |
| `routing.mode` | `routing-mode` |
| `routing.sessionTimeoutSeconds` | `session-timeout` |
| `routing.llmTriggers` | `llm-triggers` |
| `routing.intentAllowlist` | `intent-allowlist` |
| `systemPrompt` | `system-prompt` |
| `piper.url` | `piper-url` |
| `piper.voice` | `piper-voice` |
| `proxy.socks5` | `socks5` |
| `plugin.url` | `plugin-url`, `pair-url` |
| `plugin.token` | `plugin-token` |
| `plugin.fingerprint` | `plugin-fingerprint` (readonly) |

### Чек-лист нового поля конфигурации

1. Добавить поле в `ConfigSchema` с дефолтом и валидацией.
2. Убедиться, что `DEFAULT_CONFIG` получает его через `ConfigSchema.parse({})`.
3. Добавить поле в `renderConfig`.
4. Добавить поле в `collectConfig`.
5. Добавить input/select/checkbox в `index.html` с `label for`.
6. Если поле секретное — добавить в `secretFields`, `redactedConfig`, `mergeSecrets` и в список redact, если оно может попасть в заголовки.
7. Если поле влияет на поток — использовать его в `pipeline.ts`/`models.ts`/`plugin.ts`, а не только хранить.
8. Обновить README, если поле видно пользователю.
9. Проверить сохранение, перезагрузку и маску.

## Модели

`addon/src/models.ts` и `addon/src/gemini.ts`:

- OpenAI `/models` принимает `data[]`, `models[]` или массив; элементы могут быть строками.
- Gemini `/models` фильтруется по `supportedGenerationMethods`.
- Gemini base URL настраивается; по умолчанию `https://generativelanguage.googleapis.com/v1beta`.
- Ошибки discovery должны содержать провайдера и HTTP-статус, но не ключ.
- `POST /api/models` принимает текущие `baseUrl`/`apiKey` из формы. Если пришла маска — используется сохранённый ключ.

При отладке «модели не парсятся» сначала проверяйте форму ответа провайдера, затем `baseUrl` и заголовок ключа. Не меняйте фильтр `generateContent`/`bidiGenerateContent` вслепую.

Детали парсинга:

- OpenAI: `data` приоритетнее `models`; если нет ни того, ни другого — ошибка `expected data[] or models[]`. Элемент-строка становится id; объект берёт `id` или `name`. Дедупликация по id, сортировка numeric-aware. Фильтра по методам нет, `live` всегда пустой.
- Gemini: без ключа — ошибка; `pageSize=1000`; обязателен массив `models[]`; id — `name` без `models/`; методы — `supportedGenerationMethods`; лимиты токенов сохраняются.
- Если хотя бы у одной Gemini-модели есть методы: `chat` — только `generateContent`, `live` — только `bidiGenerateContent`.
- Если методов нет вообще: `chat` — все, кроме `/embed/i`, `live` — пустой. Это fallback для нестандартных прокси.
- Ошибки оборачиваются в `OpenAI /models request failed: …` или `Gemini /models request failed: …`.
- `requestJson` включает до 800 символов тела ошибки; публичный обработчик дополнительно редактирует ключи. Не добавляйте ключ в URL.

## Тестирование без реальных ключей

Можно поднять локальный OpenAI-совместимый mock и проверить весь путь:

```sh
# mock /v1/models и /v1/chat/completions
# затем:
curl -X PUT http://127.0.0.1:8097/api/config \
  -H 'content-type: application/json' \
  -d '{"provider":"openai","openai":{"baseUrl":"http://127.0.0.1:18080/v1","apiKey":"sk-test","model":"mock"},"routing":{"mode":"llm"}}'

curl -X POST http://127.0.0.1:8097/api/ask \
  -H 'content-type: application/json' \
  -d '{"text":"привет","speak":false}'
```

Для Gemini mock:

- `GET /v1beta/models` → `{"models":[...]}`
- `POST /v1beta/models/<model>:generateContent`
- проверьте, что ключ пришёл в `x-goog-api-key`, а не в query.

Для Piper mock: TCP-сервер, который читает JSON-строку `synthesize` и отвечает Wyoming `audio-start` / `audio-chunk` / `audio-stop`.

Не коммитьте тестовые ключи и временные данные. Используйте `/tmp` и `HASAR_DATA_DIR`.

### Минимальный OpenAI mock

```js
// /tmp/hasar-mock-openai.mjs
import http from "node:http";

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "mock" }] }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      JSON.parse(body); // validate the request body
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "mock response" } },
          ],
        }),
      );
    });
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.listen(18080, "127.0.0.1", () => console.log("mock on :18080"));
```

Запуск: `node /tmp/hasar-mock-openai.mjs`, затем add-on с `HASAR_DATA_DIR=/tmp/hasar-data`. Проверьте `GET /api/models` и `POST /api/ask`; лог запроса появится в `GET /api/debug/log`.

### Gemini mock

- `GET /v1beta/models?pageSize=1000` → `{"models":[{"name":"models/mock-chat","supportedGenerationMethods":["generateContent"]},{"name":"models/mock-live","supportedGenerationMethods":["bidiGenerateContent"]}]}`.
- `POST /v1beta/models/mock-chat:generateContent` → `{"candidates":[{"content":{"parts":[{"text":"mock"}]}}]}`.
- Проверьте заголовок `x-goog-api-key`; в URL ключа быть не должно.
- Chat-ветка не использует MCP; не ждите tool calls.
- Live-ветку mock-сервером на HTTP не проверить: нужен WebSocket-стенд или живой ключ. Не утверждайте, что Live протестирован, если стенда не было.

### Piper mock

Wyoming-фрейм: JSON-заголовок + `\n`, затем `data_length` байт JSON-данных и `payload_length` байт аудио. Минимальный сценарий:

1. Прочитать строку `{"type":"synthesize",...}`.
2. Отправить `{"type":"audio-start","data":{"rate":22050,"width":2,"channels":1}}`.
3. Отправить несколько `audio-chunk` с PCM.
4. Отправить `audio-stop`.

Если `audio-stop` не пришёл, клиент завершится ошибкой по таймауту/закрытию.

### Home Assistant / Assist mock

Установите `HA_URL=http://127.0.0.1:18123` и `HA_TOKEN=test` (без `SUPERVISOR_TOKEN`, иначе приоритет будет у Supervisor). Нужны:

- `POST /services/conversation/process?return_response=true` → `{"service_response":{"response":{"speech":{"plain":{"speech":"ok"}}}}}`.
- `POST /services/hasar/recognize_intent?return_response=true` → `{"service_response":{"matched":true,"intent":"HassTurnOn","slots":{}}}`.

Проверьте режимы `auto`, `assist`, `llm` и fallback при 500/пустом ответе. Помните: в `auto` при отсутствии mock-сервиса запрос уйдёт в LLM.

### Plugin mock

Для проверки add-on без колонки нужен HTTPS-сервер с самоподписанным сертификатом:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout /tmp/plugin-key.pem -out /tmp/plugin-cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Сервер должен отдавать `/v1/pairing`, `/v1/pair`, `/v1/info`, `/v1/state`, `/v1/play`, `/v1/led`, `/v1/led/off`, `/v1/clock`, `/v1/cancel` и проверять `Authorization: Bearer`. Fingerprint для `PUT /api/config` можно получить из `openssl x509 -in /tmp/plugin-cert.pem -noout -fingerprint -sha256` (приведите к `sha256:<hex>` без двоеточий). Проверьте:

- неверный fingerprint → `plugin certificate fingerprint mismatch`;
- неверный код → 400;
- `/v1/play` получает WAV и правильный `content-type`;
- `/v1/led` получает массив цветов.

### Матрица проверок

| Что меняли | Минимум |
|---|---|
| `addon/src/*.ts` | `npm run check`, `npm run build`, запуск и `/health` |
| `pipeline.ts` | mock OpenAI + `/api/ask` во всех режимах, журнал |
| `models.ts` / `gemini.ts` | mock `/models`, `/api/models`, ошибка без ключа |
| `tts/piper.ts` | Piper mock, WAV в plugin mock |
| `plugin.ts` / `pairing.ts` | plugin mock, неверный fingerprint, неверный код |
| `ui/*` | ручной smoke в браузере, ingress-путь, мобильная ширина, CSP |
| `custom_components/*.py` | `py_compile`, import в HA, config flow вручную |
| `yam/src/*.rs` | `cargo check`, `./yam/build-yap.sh`, установка на колонку |
| `yam/src/api.rs` | curl всех endpoints, 401 без токена, WAV > 20 MiB |
| `AGENTS.md` / README | проверка ссылок, отсутствие секретов, соответствие коду |

## Отладка по симптомам

| Симптом | Вероятная причина | Где смотреть | Что делать |
|---|---|---|---|
| «Модели не парсятся» | Неверный `baseUrl`, форма ответа, ключ в query | `models.ts`, `gemini.ts`, лог `/api/models` | Проверить форму ответа, заголовок, `/v1` |
| «Модели пустые» у Gemini | Нет `supportedGenerationMethods` или фильтр | `models.ts` | Не менять фильтр вслепую; проверить ответ |
| Нет звука | Piper недоступен, plugin URL пуст, WAV отклонён | `pipeline.ts`, `piper.ts`, `plugin.ts` | Проверить `tcp://core-piper:10200`, `/v1/play`, лог |
| «plugin is not paired» | Нет URL/токена | `config.json`, `/api/config` | Пройти pairing, проверить маску |
| «fingerprint mismatch» | Сменился сертификат или неверный fingerprint | `plugin.ts`, `tls.rs` | Перепривязать или восстановить `cert.pem`/`key.pem` |
| Pairing «invalid or expired» | Код истёк/использован/5 попыток | `auth.rs`, `pairing.json` | Перезапустить плагин, прочитать новый код |
| HACS не находит add-on | Другой hostname, add-on остановлен, нет Supervisor | `config_flow.py`, `const.py` | Указать адрес вручную, проверить `/health` |
| UI пустой за ingress | Абсолютный `/api/...` или CSP | `app.js`, `index.ts` | Использовать `API_BASE`, проверить консоль |
| Сохранение «съело» ключ | Маска без предыдущего значения | `mergeSecrets`, `redactedConfig` | Ввести ключ заново, проверить имя/URL MCP |
| MCP tool «unknown» | Неверный префикс/сервер не подключился | `mcp/client.ts`, лог | Проверить имя `<server>__<tool>` и warning |
| Gemini Live таймаут | Нет `turnComplete`, сеть, прокси | `gemini-live.ts` | Проверить WS, 45 с, SOCKS5 |
| Assist всегда fallback | Нет HACS-интеграции или intent не в allowlist | `ha.ts`, `pipeline.ts`, журнал | Установить интеграцию, проверить intent |
| Журнал пуст после рестарта | Ring buffer в памяти | `debug.ts` | Это ожидаемо; не обещайте персистентность |

## Стиль кода

- TypeScript ESM; в импортах внутри `src/` указывайте `.js` (NodeNext).
- Строгий TypeScript; не отключайте `strict` и `noUncheckedIndexedAccess`.
- Конфигурация — zod-схемы с дефолтами.
- Не добавляйте тяжёлые фреймворки и генераторы ради мелочей.
- Модули должны оставаться небольшими: `config`, `secrets`, `models`, `gemini`, `openai-base`, `http`, `pipeline`, `llm/*`, `mcp/*`, `tts/*`, `plugin`, `pairing`, `audio`, `ha`.
- Ошибки для пользователя — короткие и без секретов; подробности — в лог.
- Версию add-on поднимайте при изменениях, которые влияют на установленный образ (`addon/config.yaml`, `package.json`, `/health`).

### TypeScript

- Импорты типов — `import type`.
- Не используйте `any`; для внешних данных — `unknown` + проверка/zod.
- Все границы (HTTP body, config, provider response) валидируются; внутри — доверенные типы.
- Асинхронность — `async/await`; не оставляйте «висящие» промисы без `void`/обработки.
- Ошибки — `Error` с понятным сообщением; не бросайте строки.
- Не логируйте тела запросов, ключи, токены и заголовки авторизации.
- Имена: `camelCase` для переменных/полей JSON, `PascalCase` для типов, `UPPER_SNAKE` для констант.
- Не меняйте wire-формат плагина (`device_id`, `api_version`, `pairing_open`) без версии API.

### Rust

- `anyhow` для прикладных ошибок, `Context` с путём/операцией.
- `tracing` со структурированными полями; не логируйте токены и коды pairing.
- Не используйте `unwrap()`/`expect()` в обработке запросов; в `main` допустим `Context`.
- Синхронные вызовы YAM — через `spawn_blocking`.
- Секреты (`key.pem`, `tokens.json`, `device_id`, `pairing.json`) — `0600`; каталог — `0700`; публичные `cert.pem` и `fingerprint.txt` — `0644`.
- Не добавляйте крейты без необходимости; бинарник должен оставаться маленьким.
- Не меняйте формат `tokens.json` без миграции: старые токены должны продолжать работать.

### Python

- Следуйте стилю Home Assistant: async, type hints, `_LOGGER`.
- Не блокируйте event loop; сеть — через `async_get_clientsession`.
- Ошибки config flow — ключи из `strings.json`/`translations`, а не произвольный текст.
- Не создавайте entities и координаторы: интеграция ничего не опрашивает.
- Не храните токены и коды в config entry.
- `services.py` не должен выполнять действия; только dry-run.

### HTML/CSS

- Визуальный язык HA, CSS-переменные из `:root`, поддержка `prefers-color-scheme`.
- Никаких inline-стилей и `<style>`; только классы в `styles.css`.
- Никаких внешних ресурсов; иконки — SVG в разметке или текст.
- Сетки — `overview-grid`, `form-grid`, `summary-list`, `debug-grid`, `segmented`; мобильные брейкпоинты уже есть.
- Не используйте `innerHTML` с данными; шаблоны (`<template>`) — только статические.
- Сохраняйте доступность: `label for`, `aria-*`, `role`, `aria-live`.

### Ошибки и логи

- Пользовательские ошибки UI — короткие, по-русски, без стека и секретов.
- Технические ошибки API/логов — по-английски, с контекстом (провайдер, статус), без ключей.
- 5xx логируются полностью на сервере, клиенту — `internal error`.
- Новые секретные заголовки добавляйте в pino redact и в `publicError`.
- Не логируйте текст запроса пользователя без необходимости; в debug ring buffer он и так хранится 50 записей.

## Git и коммиты

- Сообщения — короткие, в повелительном наклонении, на английском, как в истории (`Add compact UI and debug console`, `Document YAM v2 migration blocker`).
- Одно логическое изменение — один коммит; не смешивайте рефакторинг и поведение.
- Не коммитьте `dist/`, `target/`, `node_modules/`, `.yap`, логи, временные WAV и тестовые данные.
- Не добавляйте CI без просьбы.
- Не переписывайте историю и не делайте force-push без явной просьбы.
- Не используйте `git add -A` вслепую: staging только относящихся к задаче файлов.
- Перед коммитом: проверки, `git diff --cached --check`, grep секретов.
- Если пользователь просит коммит — не добавляйте в него несвязанные правки и не меняйте версии без причины.
- Теги и релизы — только по просьбе.

## Чего не делать (антипаттерны)

- Добавлять OpenAI Realtime или Responses API вместо Chat Completions.
- Добавлять микрофонный PCM/STT в Gemini Live или плагин.
- Переносить routing/LLM/MCP/Piper в HACS-интеграцию.
- Выполнять intents в `hasar.recognize_intent` или вызывать `conversation.process` из сервиса.
- Хранить секреты в открытом виде, возвращать их в API или писать в логи.
- Передавать ключи в query string.
- Обещать SOCKS5 для MCP.
- Хардкодить `local-hasar` как единственный адрес add-on.
- Мигрировать `hasar-agent` на `.yampkg` до появления супервизора служб.
- Добавлять сборщик/фреймворк/внешние CDN в UI.
- Использовать `innerHTML` с текстом модели, пользователя или ошибки.
- Добавлять inline `<style>`, `<script>`, `style="..."`.
- Возвращать крупные скругления и тяжёлые тени.
- Добавлять CI workflow без просьбы.
- Коммитить `PLAN.md`, `docs/YAM-RESEARCH.md`, `docs/internal/`, `ref/`, `config.json`, `pairing.json`, `master.key`.
- Менять wire-поля плагина без повышения `api_version`.
- «Чинить» ограничения выдуманными функциями (STT, кнопки, штатный TTS, речь Алисы).
- Скрывать ошибку конфигурации пустым значением без warning.
- Объявлять проверку выполненной, если она не запускалась.

## Ограничения, которые нельзя «починить» выдумкой

- Плагин не захватывает PCM микрофона и не делает STT.
- YAM не отдаёт PCM через Lua API; доступен только распознанный текст.
- Нет реального HA/MCP стенда в этой среде; интеграцию и intent fallback нужно проверять на живом Home Assistant.
- Нет гарантированных реальных ключей OpenAI/Gemini; используйте mock-серверы.
- Публичный репозиторий не должен содержать внутренние планы и research.

Если задача требует одного из этих ограничений, сначала объясните ограничение и предложите проверяемый обходной путь.

Дополнительно:

- Gemini Live — только текстовый вход и аудиовыход; нет микрофона, barge-in и непрерывного диалога.
- Gemini chat не получает MCP-tools; tools есть только в OpenAI-ветке и Gemini Live.
- Piper — отдельный add-on; Hasar его не устанавливает и не запускает.
- Плагин не отдаёт speech events; `capabilities.speech_events` всегда `false`.
- Плагин не управляет кнопками; `buttons` всегда `false`.
- HACS-интеграция не создаёт entities и не хранит токен плагина.
- Порт add-on не публикуется наружу; доступ только через ingress или внутреннюю сеть.
- `routing.sessionTimeoutSeconds` пока не влияет на поведение.
- YAM v2 не запускает `services`; миграция на `.yampkg` заблокирована до появления host/supervisor.
- `.yap` собран под `aarch64`; на других архитектурах не запустится.
- В манифесте плагина нет списка `models`; это сделано для тестирования на разных колонках, а не для обещания совместимости.

## Глоссарий

| Термин | Значение |
|---|---|
| YAM | Y Application Manager, runtime на колонке |
| `.yap` | Формат пакета YAM (ZIP/tar.gz с `plugin.toml`) |
| `.yampkg` | Новый формат YAM v2; службы пока не запускаются |
| Add-on | Приложение Home Assistant в Supervisor, здесь Node.js |
| Ingress | Проксирование UI add-on через Home Assistant |
| HACS | Home Assistant Community Store, доставка интеграции |
| Config entry | Сохранённая запись интеграции в HA |
| Assist | Локальный conversation-агент HA |
| Intent | Намерение HA (`HassTurnOn` и т.п.) |
| Allowlist | Список intent'ов, которые можно отдать Assist |
| MCP | Model Context Protocol, источник tools |
| Tool call | Вызов инструмента моделью |
| Wyoming | Протокол Piper (`synthesize`, `audio-*`) |
| Fingerprint | SHA-256 сертификата плагина, `sha256:<hex>` |
| Pairing | Обмен одноразового кода на bearer-токен |
| `SECRET_MASK` | Строка `••••••••`, означающая «секрет не изменён» |
| Ring buffer | Журнал последних 50 запросов в памяти |

## Definition of done

Перед завершением задачи проверьте:

- [ ] Изменение соответствует архитектурным границам (плагин — транспорт, add-on — мозг, HACS — привязка).
- [ ] `cd addon && npm run check` проходит (если менялся TS).
- [ ] `npm run build` проходит, если менялся runtime-код.
- [ ] `python3 -m py_compile custom_components/hasar/*.py` проходит (если менялся Python).
- [ ] `cd yam && cargo check` или `./yam/build-yap.sh` проходит (если менялся Rust).
- [ ] Секреты не попали в код, логи, примеры и git; grep-проверки чистые.
- [ ] Новые поля конфигурации добавлены во все четыре места (схема, render, collect, HTML).
- [ ] Секретные поля добавлены в `secretFields`, `redactedConfig`, `mergeSecrets`.
- [ ] UI работает за ingress, без inline-стилей, без `innerHTML` с данными.
- [ ] Версии подняты там, где нужно.
- [ ] README/AGENTS.md обновлены, если изменилось пользовательское поведение или правила.
- [ ] В ответе явно указано, что проверено, а что нет (особенно HA, колонка, Gemini Live, реальные ключи).
- [ ] Нет выдуманных результатов и «починенных» ограничений.
