"""Config flow for Hasar."""

from __future__ import annotations

import logging
import os
from typing import Any
from urllib.parse import urlparse

import aiohttp
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    DEFAULT_ADDON_URL,
    DEFAULT_PORT,
    DOMAIN,
    ENV_SUPERVISOR,
    ENV_SUPERVISOR_TOKEN,
    FALLBACK_ADDON_URLS,
    SLUG_HINTS,
)

_LOGGER = logging.getLogger(__name__)

DEFAULT_PLUGIN_PORT = 8443

# The typed address is checked slowly; fallback addresses are checked quickly.
PROBE_TIMEOUT = aiohttp.ClientTimeout(total=6)
FALLBACK_TIMEOUT = aiohttp.ClientTimeout(total=2)
SUPERVISOR_TIMEOUT = aiohttp.ClientTimeout(total=6)

PAIR_SCHEMA = vol.Schema(
    {
        vol.Required("station_host"): str,
        vol.Optional("plugin_port", default=DEFAULT_PLUGIN_PORT): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=65535)
        ),
        vol.Required("pairing_code"): str,
    }
)


class WrongService(Exception):
    """The address answered, but it is not the Hasar add-on."""


def _normalize_addon_url(value: str) -> str:
    """Return a usable add-on base URL."""
    url = (value or "").strip().rstrip("/")
    if not url:
        return DEFAULT_ADDON_URL
    if not url.lower().startswith(("http://", "https://")):
        url = f"http://{url}"
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


async def _supervisor_get(
    session: aiohttp.ClientSession, url: str, headers: dict[str, str]
) -> dict[str, Any]:
    """GET the Supervisor API. The caller handles errors."""
    async with session.get(url, headers=headers, timeout=SUPERVISOR_TIMEOUT) as resp:
        resp.raise_for_status()
        payload = await resp.json(content_type=None)
    return payload if isinstance(payload, dict) else {}


def _looks_like_ours(entry: dict[str, Any]) -> bool:
    """Match the add-on by slug or display name."""
    slug = str(entry.get("slug") or "").lower()
    name = str(entry.get("name") or "").lower()
    return any(hint in slug or hint in name for hint in SLUG_HINTS)


async def async_discover_addon(hass: Any) -> dict[str, Any]:
    """Ask Supervisor for the exact Hasar add-on hostname and port.

    Works on Home Assistant OS / Supervised. On Home Assistant Container,
    or when the Supervisor API is unavailable, returns an empty dict and the
    flow falls back to the known addresses.
    """
    supervisor = (os.environ.get(ENV_SUPERVISOR) or "").rstrip("/")
    token = os.environ.get(ENV_SUPERVISOR_TOKEN)
    if not supervisor or not token:
        return {}

    session = async_get_clientsession(hass)
    headers = {"Authorization": f"Bearer {token}"}
    errors = (aiohttp.ClientError, TimeoutError, OSError, ValueError)

    try:
        payload = await _supervisor_get(session, f"{supervisor}/addons", headers)
    except errors as err:
        _LOGGER.debug("Supervisor API is unavailable: %s", err)
        return {}

    data = payload.get("data") or {}
    if isinstance(data, dict):
        installed = data.get("apps") or data.get("addons") or []
    elif isinstance(data, list):
        installed = data
    else:
        return {}
    if not isinstance(installed, list):
        return {}

    for entry in installed:
        if not isinstance(entry, dict) or not _looks_like_ours(entry):
            continue

        slug = str(entry.get("slug") or "")
        info: dict[str, Any] = {}
        if slug:
            try:
                info_payload = await _supervisor_get(
                    session, f"{supervisor}/addons/{slug}/info", headers
                )
                info = info_payload.get("data") or {}
                if not isinstance(info, dict):
                    info = {}
            except errors as err:
                _LOGGER.debug("Cannot read add-on info for %s: %s", slug, err)

        hostname = str(info.get("hostname") or slug.replace("_", "-"))
        try:
            port = int(info.get("ingress_port") or DEFAULT_PORT)
        except (TypeError, ValueError):
            port = DEFAULT_PORT

        urls: list[str] = []
        for host in (hostname, f"{hostname}.local.hass.io", info.get("ip_address")):
            if host:
                url = f"http://{host}:{port}"
                if url not in urls:
                    urls.append(url)

        _LOGGER.debug("Supervisor: add-on %s -> %s", slug, urls)
        return {
            "slug": slug,
            "hostname": hostname,
            "state": str(info.get("state") or entry.get("state") or ""),
            "urls": urls,
        }

    return {}


async def _probe_addon(
    session: aiohttp.ClientSession,
    base_url: str,
    timeout: aiohttp.ClientTimeout,
) -> dict[str, Any]:
    """Check /health and /api/config to make sure this is Hasar."""
    async with session.get(f"{base_url}/health", timeout=timeout) as response:
        response.raise_for_status()
        health = await response.json(content_type=None)
    if not isinstance(health, dict) or health.get("status") != "ok":
        raise WrongService(base_url)

    async with session.get(f"{base_url}/api/config", timeout=timeout) as response:
        response.raise_for_status()
        config = await response.json(content_type=None)
    if not isinstance(config, dict) or "provider" not in config or "plugin" not in config:
        raise WrongService(base_url)
    return config


class HasarConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Pair a YAM plugin through the Hasar add-on."""

    VERSION = 1
    _addon_url = DEFAULT_ADDON_URL
    _paired_plugin_url = ""

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Find the add-on and check whether it is already paired."""
        found = await async_discover_addon(self.hass)
        discovered = list(found.get("urls") or [])

        if user_input is None:
            suggested = discovered[0] if discovered else DEFAULT_ADDON_URL
            return self.async_show_form(
                step_id="user",
                data_schema=vol.Schema(
                    {vol.Required("addon_url", default=suggested): str}
                ),
            )

        typed = _normalize_addon_url(user_input.get("addon_url", ""))
        candidates: list[str] = []
        for url in (typed, *discovered, *FALLBACK_ADDON_URLS):
            if url and url not in candidates:
                candidates.append(url)

        first_error = "cannot_connect"
        session = async_get_clientsession(self.hass)

        for index, base_url in enumerate(candidates):
            self._async_abort_entries_match({"addon_url": base_url})
            timeout = PROBE_TIMEOUT if index == 0 else FALLBACK_TIMEOUT
            try:
                config = await _probe_addon(session, base_url, timeout)
            except WrongService:
                if index == 0:
                    first_error = "bad_response"
                _LOGGER.debug("Address %s is not a Hasar add-on", base_url)
                continue
            except aiohttp.ClientResponseError as err:
                if index == 0:
                    first_error = "bad_response"
                _LOGGER.debug("Address %s returned HTTP %s", base_url, err.status)
                continue
            except (aiohttp.ClientError, TimeoutError, OSError, ValueError) as err:
                _LOGGER.debug("Address %s is unavailable: %s", base_url, err)
                continue

            if base_url != typed:
                _LOGGER.info("Hasar add-on found at %s", base_url)

            self._addon_url = base_url
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

        error = first_error
        if first_error == "cannot_connect":
            if found.get("hostname") and found.get("state") not in ("", "started"):
                error = "addon_stopped"
            elif not found and os.environ.get(ENV_SUPERVISOR_TOKEN):
                error = "addon_missing"

        _LOGGER.warning(
            "Hasar add-on not found. Tried: %s", ", ".join(candidates)
        )
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {vol.Required("addon_url", default=typed): str}
            ),
            errors={"base": error},
            description_placeholders={
                "tried": ", ".join(candidates),
                "hostname": found.get("hostname") or "",
                "state": found.get("state") or "",
            },
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
