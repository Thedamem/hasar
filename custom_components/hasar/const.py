"""Общие константы интеграции Hasar."""

from __future__ import annotations

from typing import Final

DOMAIN = "hasar"
NAME = "Hasar"
VERSION = "0.1.3"

SERVICE_RECOGNIZE_INTENT = "recognize_intent"

DEFAULT_PORT: Final = 8097

# Supervisor передаёт ядру Home Assistant свой адрес и токен.
ENV_SUPERVISOR: Final = "SUPERVISOR"
ENV_SUPERVISOR_TOKEN: Final = "SUPERVISOR_TOKEN"

# По этим подстрокам ищем add-on в списке установленных.
SLUG_HINTS: Final = ("hasar",)

# Как Supervisor строит hostname:
#   slug = <id репозитория>_<slug из config.yaml> -> <id>_hasar
#   hostname = slug.replace("_", "-")             -> <id>-hasar
# Для локальной папки id = "local", для Git-репозитория — префикс из URL.
# Точный hostname и порт мастер спрашивает у Supervisor, это только запасные адреса.
DEFAULT_ADDON_URL: Final = f"http://local-hasar:{DEFAULT_PORT}"

FALLBACK_ADDON_URLS: Final = (
    DEFAULT_ADDON_URL,
    f"http://hasar:{DEFAULT_PORT}",
    f"http://local-hasar.local.hass.io:{DEFAULT_PORT}",
    f"http://hasar.local.hass.io:{DEFAULT_PORT}",
    f"http://addon_local_hasar:{DEFAULT_PORT}",
    f"http://local_hasar:{DEFAULT_PORT}",
    f"http://homeassistant.local:{DEFAULT_PORT}",
    f"http://127.0.0.1:{DEFAULT_PORT}",
)
