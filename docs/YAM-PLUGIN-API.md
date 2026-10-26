# YAM plugin API: полная карта возможностей

Дата: 26.10.2026
Основано на YAM 0.1.18 (`docs/PLUGIN_API.md`, `src/main.rs`) и открытом PR #15.

## 1. Формат пакета

`.yap` — ZIP или `tar.gz` с `plugin.toml` в корне.

```toml
id = "hasar-agent"
name = "Hasar Agent"
version = "0.1.0"
entry = "main.lua"
permissions = ["exec"]
[launch]
kind = "binary"   # lua | binary
mode = "service"  # oneshot | service (legacy, сервис включается отдельно)
path = "bin/hasar-agent"
[compatibility]
# Пример проверенной модели.
# Чтобы тестировать на других колонках, оставьте models пустым.
models = ["yandexplum"]
features = ["arch.aarch64"]
```

Если `models` пуст, YAM не блокирует пакет по модели. Если список задан и модели в нём нет, пакет помечается несовместимым (`compatible=false`), и запуск отклоняется. Поэтому в тестовом пакете `models` не задаём, а `features` ограничиваем только архитектурой.

Ограничения:

- только один `launch.kind` и один entrypoint;
- binary требует permission `exec`;
- binary-пакет должен соответствовать архитектуре;
- распакованный размер ≤ 32 MiB, свободное место резервируется 8 MiB;
- пути только относительные, без `..`;
- `launch.interpreter` — только `sh`;
- `launch.library_paths` — относительные каталоги для `LD_LIBRARY_PATH`;
- `mode` старых пакетов принимается, но сервис включается через `yam service enable`.

## 2. Lua API

Lua sandbox: только `table`, `string`, `math`, `utf8`. Нет `io`, `os`, `package`, `debug`, сокетов.

### 2.1. Общие функции

| Функция | Что делает |
|---|---|
| `alice.sleep(ms)` | Сон с отменой; максимум 60 с |
| `alice.is_available(name)` | Проверка hardware/capability |
| `alice.model()` | Нормализованная модель |
| `device.model` | Модель |
| `device.architecture` | Архитектура |
| `device.led_count` | Число LED |
| `device.features` | Список features |
| `event` | Строка события запуска |

`is_available` поддерживает: `led`, `volume`, `audio`, `bluetooth`, `display`, `sensors`, `sensors.control`, `clock`, `input`, `network`, `ipc.alarm`, `ipc.speech`, `ipc.read`, `ipc.control`, `commands`, `system`. Для `exec` проверки нет.

### 2.2. Permissions и API

| Permission | API | Детали |
|---|---|---|
| `led` | `alice.set(colors)`, `alice.off()`, `alice.play(path)`, `alice.logo.set(colors)`, `alice.logo.off()` | RGB-кольцо/логотип; паттерн из файла пакета |
| `volume` | `alice.volume.get()`, `alice.volume.set(percent)` | `amixer Master`; 0..100 |
| `audio` | `alice.audio.play(path)` | Только файл внутри пакета; `aplay` |
| `bluetooth` | `status`, `power`, `scan`, `pair`, `connect`, `disconnect`, `remove` | `bluetoothctl` |
| `display` | `backlights()`, `set_backlight(name, value)` | `/sys/class/backlight` |
| `sensors` | `list()`, `read(id)` | IIO/thermal/hwmon/power_supply |
| `sensors.control` | `configure_ambient_light(name, gain, integration_ms)` | Только ambient light |
| `clock` | `available()`, `time(hh:mm)`, `segments(table)`, `off()` | Сегментный экран |
| `input` | `devices()`, `next_event(timeout_ms)` | Только declared evdev-устройства |
| `network` | `http.get(url)`, `http.post(url, body)` | Только allowlist, не localhost/private IP |
| `ipc.alarm` | `ipc.next_alarm(timeout_ms)` | События `alarmd` |
| `ipc.speech` | `ipc.next_speech(timeout_ms)` | Транскрипт от `aliced` |
| `ipc.read` | `ipc.next(service, timeout_ms)` | Сырой protobuf из declared services |
| `ipc.control` | `ipc.send(service, payload)` | Сырой protobuf в declared services |
| `ipc.read` + `ipc.control` | `ipc.request(service, payload, timeout_ms)` | Запрос/ответ по request_id |
| `commands` | `alice.command.listen(phrase, handler)`, `alice.command.cancel()` | Только declared phrases |
| `system` | `hostname()`, `uptime()`, `meminfo()` | /etc/hostname, /proc |
| `exec` | `alice.exec(program, args)` | Только файл пакета; admin включает binaries |

### 2.3. Input/кнопки

Манифест:

```toml
permissions = ["input"]
[input]
devices = ["vad_keypad", "mute"]
```

API:

```lua
alice.input.devices()             -- текст /proc/bus/input/devices
alice.input.next_event(1000)      -- nil или {device,type,code,value,time_ms}
```

Ограничения:

- точные имена kernel-устройств;
- максимум 16 устройств;
- чтение non-grabbing, read-only;
- таймаут максимум 60 с;
- `EV_SYN` отфильтрован;
- на разных моделях имена разные.

### 2.4. Команды

```toml
permissions = ["commands"]
[commands]
phrases = ["ананас"]
```

```lua
alice.command.listen("ананас", function(message)
  -- message.transcript, message.command, message.source
end)
alice.command.cancel()
```

Ограничения:

- максимум 32 фразы;
- нормализация регистра/пунктуации/пробелов;
- совпадение всей фразы или фразы с префиксом активации;
- `listen` блокирующий цикл, пока пакет запущен;
- `cancel` отправляет фиксированный `CANCEL_DIALOG` в `aliced`.

### 2.5. Network

```toml
permissions = ["network"]
[network]
allow = ["api.example.org", "*.example.com"]
allow_insecure_http = false
```

- только HTTP(S);
- hostname allowlist;
- `localhost` запрещён;
- литеральные private/loopback/link-local/multicast IP запрещены;
- DNS-имя, резолвящееся в private IP, политика не проверяет — это особенность, а не разрешение;
- redirects отключены;
- timeout 20 с;
- ответ ≤ 1 MiB;
- POST body ≤ 1 MiB.

### 2.6. IPC

`ipc.read`/`ipc.control` требует `[ipc].services` (до 16 имён). Это сырой protobuf Quasar. `ipc.control` может менять состояние системных сервисов — только доверенным пакетам.

`ipc.speech` даёт только текст, source и transcript; **не даёт PCM и не даёт request_id** в текущей версии.

## 3. Binary runtime

### 3.1. Где это в коде

Отдельного `runtime`-модуля нет. Всё в `src/main.rs`:

- `run_binary()` — запуск и жизненный цикл binary-пакета;
- `run_package()` — выбор Lua/binary по `launch.kind`;
- `start_package()` — проверки, cancellation token, запуск в tokio;
- `runtime_permission()` — проверка `X-YAM-Token` и permission;
- `runtime_device()`, `runtime_sensors()`, `runtime_led()`, `runtime_led_off()`, `runtime_clock()` — HTTP endpoints;
- `runtime_tokens: HashMap<String, String>` — одноразовые токены;
- `stop_process_group()` — SIGTERM/SIGKILL всей группы;
- `launch_program()` — `interpreter = "sh"` и legacy-runner;
- `binary_library_path()` — `LD_LIBRARY_PATH`;
- `RotatingLog` — `runtime.log`;
- `allow_plugin_binaries` в `Settings` — глобальный выключатель.

Поэтому поиск по `src/runtime/` ничего не даёт: binary runtime — это набор функций и маршрутов в одном файле.

### 3.2. Что даёт

Binary-пакет получает:

- `YAM_API_URL` — loopback;
- `YAM_API_TOKEN` — одноразовый токен;
- `YAM_PLUGIN_ID`;
- рабочую директорию пакета;
- `LD_LIBRARY_PATH`;
- отдельную process group; stop → SIGTERM → SIGKILL.

Runtime endpoints (0.1.18):

| Метод | Путь | Permission |
|---|---|---|
| `GET` | `/api/runtime/<id>/device` | `exec` |
| `GET` | `/api/runtime/<id>/sensors` | `sensors` |
| `POST` | `/api/runtime/<id>/led` | `led` |
| `POST` | `/api/runtime/<id>/led/off` | `led` |
| `POST` | `/api/runtime/<id>/clock` | `clock` |

Чего нет:

- input/кнопок;
- speech/транскриптов;
- volume;
- audio playback API;
- произвольного IPC.

PR #15 добавляет:

- `GET /api/runtime/<id>/media`;
- `POST /api/runtime/<id>/speech/next`;
- `POST /api/runtime/<id>/command/cancel`.

Требования: `exec` + `ipc.speech`; для cancel — `commands`.

## 4. Management API YAM

Без аутентификации, если `web.api = true`:

- `GET/POST /api/plugins`;
- `POST /api/plugins/registry`;
- `DELETE /api/plugins/:id`;
- `POST /api/plugins/:id/toggle`;
- `POST /api/plugins/:id/invoke`;
- `POST /api/plugins/:id/service/{enable,disable,start}`;
- `POST /api/plugins/:id/stop`;
- `GET /api/plugins/:id/logs`;
- `GET/PUT /api/settings`;
- `GET/PUT /api/device`;
- `GET /api/sensors`;
- `GET/PUT /api/clock`;
- `POST /api/led`, `/api/led/off`.

Это удобно для установки/управления, но **небезопасно** для WAN. Runtime token не защищает management API.

## 5. Можно ли совместить Lua и binary в одном пакете?

Да, файлы можно положить вместе. Но YAM запускает только один runtime:

- `kind = "lua"` → запускается Lua, binary-файлы лежат мёртвым грузом;
- `kind = "binary"` → запускается binary, Lua-файлы не исполняются.

Почему нельзя сделать Lua адаптером для binary:

1. Lua не может поднять сервер (нет сокетов).
2. Lua не может общаться с binary через localhost (network policy блокирует private IP).
3. Lua не может писать файлы/читать их (нет `io`).
4. `alice.exec` запускает bundled binary, но:
   - синхронно и без управления жизненным циклом;
   - не передаёт `YAM_API_URL`/`YAM_API_TOKEN`;
   - не даёт канала обратной связи;
   - требует `allow_plugin_binaries`.
5. Два пакета (Lua + binary) тоже не могут нормально общаться: нет plugin-to-plugin IPC.

Теоретически binary может **встроить Lua** (например, `mlua`) и исполнять adapter-скрипты. Но:

- +размер и сложность;
- YAM runtime API уже абстрагирует LED/clock/sensors;
- device-specific адаптеры лучше не тащить в пакет, а добавлять в YAM.

Вывод: для API-сервера, TLS и динамического аудио нужен **binary package**. Lua не может быть адаптером к нему в текущей модели YAM.

## 6. Нужен ли binary для Hasar?

Для заявленных фич — да:

| Фича | Lua | Binary |
|---|---|---|
| HTTP/WS API с TLS | нет | да |
| LAN-доступ к HA | нет (private IP blocked) | да |
| Приём `speech.final` | да, `ipc.speech` | только через PR #15 или прямой IPC |
| Кнопки | да, `input` | нет runtime API; нужен evdev |
| LED/clock | да | да, runtime API |
| Динамический TTS | нет (только файл пакета) | да, `aplay`/`maind` |
| Стриминг аудио на колонку | нет | да |
| Pairing/токены | нет | да |
| Сервисный автозапуск | да | да |

Lua-only вариант возможен только как «игрушка»: принять текст, отправить на публичный URL, мигнуть LED, проиграть заранее вложенный WAV. Для HA-интеграции с TTS и API — недостаточно.

## 7. Как избежать device-specific кода

Правило: **никаких sysfs, никаких `if model == ...`, никаких хардкодов LED count.**

Использовать:

- `GET /api/runtime/<id>/device` → `model`, `architecture`, `features`;
- features: `led.ring.rgb`, `led.ring.N`, `led.logo.rgb`, `display.clock.segment.v1`, `audio.play.aplay`, `audio.volume.alsa`, `arch.aarch64`, `arch.armhf`;
- `alice.is_available()` в Lua;
- YAM runtime `/led`, `/clock`, `/sensors`;
- `aplay` как внешний плеер, а не прямой доступ к `/dev/snd`;
- `maind --cli` как fallback, а не основной путь;
- `aliced`/PR #15 для речи; прямой `quasar.cfg` — только fallback с feature-probe.

Единственное исключение — **кнопки**: в binary runtime API их нет. Варианты:

1. Прямой evdev с allowlist (generic Linux input, но имена/коды зависят от модели).
2. Не поддерживать кнопки в MVP; cancel/listen — через HA UI/API.
3. Добавить runtime input API в YAM upstream (лучший долгосрочный вариант).
4. Lua sidecar — не работает из-за отсутствия plugin-to-plugin IPC.

Рекомендация: вынести кнопки в отдельный модуль, включить только при наличии устройств, а в MVP не делать их обязательными. Pairing — по коду из root-only файла, если кнопки нет.

## 8. Итоговая рекомендация

- Один **binary** `.yap`, без Lua-адаптера.
- Максимум YAM runtime API, минимум прямого FS.
- Кнопки — опционально, через evdev, с upstream-планом.
- Речь — через `ipc.speech`/PR #15; прямой IPC только fallback.
- TTS — через `aplay`/HA; native `maind` — fallback.
- LED/display — через YAM API; никаких sysfs.
- Кроссплатформенность — через features, не через модель.
