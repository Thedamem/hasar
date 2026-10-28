# AGENTS.md

Инструкции для AI-агентов и разработчиков, которые меняют этот репозиторий.

## Что это

Hasar — локальный мост между колонкой с YAM и Home Assistant. Три части:

1. `yam/` — Rust-плагин `.yap` для YAM. Тонкий слой: HTTPS API на колонке, pairing, bearer-токены, TLS fingerprint, проигрывание WAV, LED/часы, WebSocket heartbeat.
2. `addon/` — Node.js/TypeScript add-on Home Assistant. «Мозг»: маршрутизация, OpenAI/Gemini, MCP-tools, Piper, отправка аудио в плагин, web UI.
3. `custom_components/hasar/` — HACS-интеграция на Python. Только мастер привязки, config entry и dry-run сервис `hasar.recognize_intent`. Бизнес-логики здесь быть не должно.

Публичный репозиторий: `https://github.com/Thedamem/hasar`.

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
git grep -nE 'sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|/home/thedamem' -- . ':!AGENTS.md'
```

CI пока намеренно не добавлен. Не добавляйте workflow без просьбы.

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

## Архитектура и границы

### Маршрутизация

Порядок в `addon/src/pipeline.ts`:

1. Явный триггер LLM (`routing.llmTriggers`) → сразу LLM.
2. Режим `llm` → LLM.
3. Режим `assist` → Assist, при ошибке fallback в LLM.
4. Режим `auto` → dry-run `hasar.recognize_intent`; если intent в allowlist → Assist; иначе LLM.

Не расширяйте allowlist по умолчанию без причины. Бытовые команды должны оставаться в Assist, а не уходить в модель.

### Провайдеры

- OpenAI: только обычные Chat Completions (`/chat/completions`). **Не добавляйте OpenAI Realtime.**
- Gemini AI Studio: `generateContent` для chat и `bidiGenerateContent` для Live.
- Gemini Live используется только с текстовым входом и аудиовыходом. Микрофона/PCM-входа у плагина нет.
- Ключи передаются в заголовках: `Authorization: Bearer ...` и `x-goog-api-key`. Не возвращайте ключи в query string.
- SOCKS5 применяется к HTTP-запросам моделей и WebSocket Gemini Live. MCP-транспорты сейчас идут напрямую; не обещайте прокси для MCP в UI/README.

### Piper

Piper — отдельный add-on, Wyoming TCP, по умолчанию `tcp://core-piper:10200`. Клиент в `addon/src/tts/piper.ts`:

1. `synthesize`;
2. `audio-start` / `audio-chunk` / `audio-stop`;
3. сборка WAV;
4. `POST /v1/play` в плагин с bearer-токеном.

Gemini Live не использует Piper: PCM сразу превращается в WAV и уходит в плагин.

### MCP

Клиент в `addon/src/mcp/client.ts` поддерживает HTTP, SSE и stdio. Имена tools получают префикс сервера. Ошибка одного сервера не должна ломать остальные. Заголовки MCP-серверов могут содержать токены: в API они маскируются, на диске шифруются.

### HACS-интеграция

`custom_components/hasar/` — только:

- config flow (автоопределение add-on через Supervisor; адрес add-on; IP/порт колонки и pairing-код либо подтверждение уже существующей привязки add-on);
- config entry;
- сервис `hasar.recognize_intent` (dry-run, без выполнения действий).

Не переносите сюда вызовы LLM, MCP, Piper или маршрутизацию.

На Home Assistant OS / Supervised config flow сначала читает установленные add-on из уже загруженной интеграции `hassio` (`get_addons_info`), затем при необходимости падает обратно на Supervisor API (`/addons`, `/addons/{slug}/info`): hostname и `ingress_port`, и проверяет `/health` + `/api/config`. Не хардкодьте `local-hasar` как единственный адрес: у add-on из Git-репозитория hostname имеет префикс репозитория.

## Секреты add-on

- `addon/src/secrets.ts` — AES-256-GCM.
- Мастер-ключ: `/data/master.key`, режим `0600`, 32 байта. Альтернатива: env `HASAR_SECRET` (64 hex-символа или сильный пароль).
- `addon/src/config.ts` шифрует `openai.apiKey`, `gemini.apiKey`, `plugin.token`, `proxy.socks5` и значения `mcpServers[].headers`.
- `GET /api/config` возвращает `SECRET_MASK` (`••••••••`) вместо ключей, токена плагина и значений заголовков MCP.
- `PUT /api/config` сохраняет старый секрет, если пришла маска. Для MCP-серверов секреты ищутся по имени, затем по URL/команде; маска без найденного предыдущего значения превращается в пустую строку, а не сохраняется как литерал.
- Не логируйте тела запросов и заголовки с ключами. Fastify уже редактирует `authorization`, `x-goog-api-key`, `cookie`.
- Не удаляйте `master.key` при обновлении add-on. Без него зашифрованные значения не восстановить.

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

## Модели

`addon/src/models.ts` и `addon/src/gemini.ts`:

- OpenAI `/models` принимает `data[]`, `models[]` или массив; элементы могут быть строками.
- Gemini `/models` фильтруется по `supportedGenerationMethods`.
- Gemini base URL настраивается; по умолчанию `https://generativelanguage.googleapis.com/v1beta`.
- Ошибки discovery должны содержать провайдера и HTTP-статус, но не ключ.
- `POST /api/models` принимает текущие `baseUrl`/`apiKey` из формы. Если пришла маска — используется сохранённый ключ.

При отладке «модели не парсятся» сначала проверяйте форму ответа провайдера, затем `baseUrl` и заголовок ключа. Не меняйте фильтр `generateContent`/`bidiGenerateContent` вслепую.

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

## Стиль кода

- TypeScript ESM; в импортах внутри `src/` указывайте `.js` (NodeNext).
- Строгий TypeScript; не отключайте `strict` и `noUncheckedIndexedAccess`.
- Конфигурация — zod-схемы с дефолтами.
- Не добавляйте тяжёлые фреймворки и генераторы ради мелочей.
- Модули должны оставаться небольшими: `config`, `secrets`, `models`, `gemini`, `openai-base`, `http`, `pipeline`, `llm/*`, `mcp/*`, `tts/*`, `plugin`, `pairing`, `audio`, `ha`.
- Ошибки для пользователя — короткие и без секретов; подробности — в лог.
- Версию add-on поднимайте при изменениях, которые влияют на установленный образ (`addon/config.yaml`, `package.json`, `/health`).

## Ограничения, которые нельзя «починить» выдумкой

- Плагин не захватывает PCM микрофона и не делает STT.
- YAM не отдаёт PCM через Lua API; доступен только распознанный текст.
- Нет реального HA/MCP стенда в этой среде; интеграцию и intent fallback нужно проверять на живом Home Assistant.
- Нет гарантированных реальных ключей OpenAI/Gemini; используйте mock-серверы.
- Публичный репозиторий не должен содержать внутренние планы и research.

Если задача требует одного из этих ограничений, сначала объясните ограничение и предложите проверяемый обходной путь.
