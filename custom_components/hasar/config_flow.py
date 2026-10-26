"""Config flow for Hasar."""

from __future__ import annotations

import logging
from typing import Any

import aiohttp
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

DEFAULT_ADDON_URL = "http://local-hasar:8097"

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required("addon_url", default=DEFAULT_ADDON_URL): str,
        vol.Required("plugin_url"): str,
        vol.Required("pairing_code"): str,
    }
)


class HasarConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Pair a YAM plugin through the Hasar add-on."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            await self.async_set_unique_id(user_input["plugin_url"].rstrip("/"))
            self._abort_if_unique_id_configured()
            try:
                await self._pair(user_input)
            except aiohttp.ClientError:
                errors["base"] = "cannot_connect"
            except TimeoutError:
                errors["base"] = "timeout"
            except ValueError as error:
                _LOGGER.warning("Hasar pairing failed: %s", error)
                errors["base"] = "cannot_pair"
            else:
                return self.async_create_entry(
                    title="Hasar",
                    data={
                        "addon_url": user_input["addon_url"].rstrip("/"),
                        "plugin_url": user_input["plugin_url"].rstrip("/"),
                    },
                )
        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_SCHEMA,
            errors=errors,
        )

    async def _pair(self, data: dict[str, Any]) -> None:
        addon_url = data["addon_url"].rstrip("/")
        session = async_get_clientsession(self.hass)
        async with session.post(
            f"{addon_url}/api/pair",
            json={
                "pluginUrl": data["plugin_url"].rstrip("/"),
                "code": data["pairing_code"].strip(),
            },
            timeout=aiohttp.ClientTimeout(total=25),
        ) as response:
            payload = await response.json(content_type=None)
            if response.status != 200 or not payload.get("ok"):
                raise ValueError(payload.get("error", "pairing failed"))
