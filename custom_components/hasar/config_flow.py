"""Config flow for Hasar."""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlparse

import aiohttp
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

DEFAULT_ADDON_URL = "http://local-hasar:8097"
DEFAULT_PLUGIN_PORT = 8443

PAIR_SCHEMA = vol.Schema(
    {
        vol.Required("station_host"): str,
        vol.Optional("plugin_port", default=DEFAULT_PLUGIN_PORT): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=65535)
        ),
        vol.Required("pairing_code"): str,
    }
)


def _normalize_addon_url(value: str) -> str:
    """Return a usable add-on base URL or raise ValueError."""
    url = value.strip().rstrip("/")
    if not url:
        raise ValueError("add-on URL is empty")
    if not url.startswith(("http://", "https://")):
        raise ValueError("add-on URL must start with http:// or https://")
    return url


def _build_plugin_url(host: str, port: int) -> str:
    """Build the https:// plugin URL from a station host and port."""
    raw = host.strip()
    if not raw:
        raise ValueError("station host is empty")

    if "://" not in raw:
        # A bare IPv6 address contains more than one colon and needs brackets.
        if raw.count(":") >= 2 and not raw.startswith("["):
            raw = f"https://[{raw}]"
        else:
            raw = f"https://{raw}"

    parsed = urlparse(raw)
    if parsed.scheme != "https":
        raise ValueError("plugin URL must use https")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("station host is invalid")

    actual_port = parsed.port or port
    if not 1 <= actual_port <= 65535:
        raise ValueError("plugin port is invalid")

    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"

    if actual_port == 443:
        return f"https://{hostname}"
    return f"https://{hostname}:{actual_port}"


class HasarConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Pair a YAM plugin through the Hasar add-on."""

    VERSION = 1
    _addon_url = DEFAULT_ADDON_URL
    _paired_plugin_url = ""

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Check the add-on connection before asking for pairing details."""
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                addon_url = _normalize_addon_url(user_input["addon_url"])
                await self._check_addon(addon_url)
                config = await self._get_addon_config(addon_url)
            except TimeoutError:
                errors["base"] = "timeout"
            except (aiohttp.ClientError, ValueError):
                errors["base"] = "cannot_connect"
            else:
                self._addon_url = addon_url
                plugin = config.get("plugin")
                plugin_url = plugin.get("url") if isinstance(plugin, dict) else None
                token = plugin.get("token") if isinstance(plugin, dict) else None
                if (
                    isinstance(plugin_url, str)
                    and plugin_url
                    and isinstance(token, str)
                    and token
                ):
                    self._paired_plugin_url = plugin_url.rstrip("/")
                    return await self.async_step_confirm()
                return await self.async_step_pair()

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {vol.Required("addon_url", default=self._addon_url): str}
            ),
            errors=errors,
        )

    async def async_step_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Confirm reusing an existing pairing from the add-on."""
        if not self._paired_plugin_url:
            return await self.async_step_pair()

        if user_input is not None:
            plugin_url = self._paired_plugin_url
            await self.async_set_unique_id(plugin_url)
            self._abort_if_unique_id_configured()
            host = urlparse(plugin_url).hostname or "station"
            return self.async_create_entry(
                title=f"Hasar ({host})",
                data={
                    "addon_url": self._addon_url,
                    "plugin_url": plugin_url,
                },
            )

        return self.async_show_form(
            step_id="confirm",
            description_placeholders={
                "addon_url": self._addon_url,
                "plugin_url": self._paired_plugin_url,
            },
        )

    async def async_step_pair(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Ask for the station address and the one-time pairing code."""
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                plugin_url = _build_plugin_url(
                    user_input["station_host"], user_input["plugin_port"]
                )
            except ValueError:
                errors["base"] = "invalid_host"
            else:
                await self.async_set_unique_id(plugin_url)
                self._abort_if_unique_id_configured()
                try:
                    await self._pair(
                        self._addon_url,
                        plugin_url,
                        user_input["pairing_code"],
                    )
                except TimeoutError:
                    errors["base"] = "timeout"
                except aiohttp.ClientError:
                    errors["base"] = "cannot_connect"
                except ValueError as error:
                    _LOGGER.warning("Hasar pairing failed: %s", error)
                    errors["base"] = "cannot_pair"
                else:
                    host = urlparse(plugin_url).hostname or "station"
                    return self.async_create_entry(
                        title=f"Hasar ({host})",
                        data={
                            "addon_url": self._addon_url,
                            "plugin_url": plugin_url,
                        },
                    )

        return self.async_show_form(
            step_id="pair",
            data_schema=PAIR_SCHEMA,
            errors=errors,
            description_placeholders={"addon_url": self._addon_url},
        )

    async def _check_addon(self, addon_url: str) -> None:
        """Fail early when the add-on is not reachable."""
        session = async_get_clientsession(self.hass)
        async with session.get(
            f"{addon_url}/health",
            timeout=aiohttp.ClientTimeout(total=10),
        ) as response:
            if response.status != 200:
                raise ValueError(f"add-on returned HTTP {response.status}")
            payload = await response.json(content_type=None)
            if not isinstance(payload, dict) or payload.get("status") != "ok":
                raise ValueError("add-on health check failed")

    async def _get_addon_config(self, addon_url: str) -> dict[str, Any]:
        """Read the add-on config to detect an existing pairing."""
        session = async_get_clientsession(self.hass)
        async with session.get(
            f"{addon_url}/api/config",
            timeout=aiohttp.ClientTimeout(total=10),
        ) as response:
            if response.status != 200:
                raise ValueError(f"add-on returned HTTP {response.status}")
            payload = await response.json(content_type=None)
            if not isinstance(payload, dict):
                raise ValueError("add-on returned an invalid config")
            return payload

    async def _pair(
        self, addon_url: str, plugin_url: str, pairing_code: str
    ) -> None:
        """Ask the add-on to pair with the station plugin."""
        session = async_get_clientsession(self.hass)
        async with session.post(
            f"{addon_url}/api/pair",
            json={
                "pluginUrl": plugin_url,
                "code": pairing_code.strip(),
            },
            timeout=aiohttp.ClientTimeout(total=25),
        ) as response:
            payload = await response.json(content_type=None)
            if (
                response.status != 200
                or not isinstance(payload, dict)
                or not payload.get("ok")
            ):
                raise ValueError(
                    payload.get("error", "pairing failed")
                    if isinstance(payload, dict)
                    else "pairing failed"
                )
