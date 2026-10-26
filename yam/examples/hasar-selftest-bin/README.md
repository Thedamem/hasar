# Hasar Self Test (Binary)

Проверяет binary runtime YAM, а не Lua-путь.

## Что проверяет

- наличие `YAM_API_URL` и `YAM_API_TOKEN`;
- `GET /api/runtime/<id>/device` с `X-YAM-Token`;
- permission `led` и `POST /led`;
- permission `clock` и `PUT /clock`;
- воспроизведение `tone.wav` через `aplay`;
- возврат LED/clock в штатное состояние.

Громкость не меняется.

## Установка

1. YAM web UI → «Установить .yap» → `hasar-selftest-bin-0.1.0.yap`.
2. Включить пакет.
3. Нажать «Запустить».
4. Посмотреть `yam logs hasar-selftest-bin` — там будет device JSON, статусы HTTP и результат `aplay`.

Пакет `oneshot`, после теста завершится сам.

## Сборка

```sh
./build.sh
```

Нужен Docker. Используется `messense/rust-musl-cross:aarch64-musl`.
