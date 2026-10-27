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
# Initial auto-probe should finish quickly; the form is the fallback.
AUTO_TIMEOUT = aiohttp.ClientTimeout(total=2)
AUTO_FALLBACK_TIMEOUT = aiohttp.ClientTimeout(total=1)
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


def _as_addon_list(value: Any) -> list[dict[str, Any]]:
    """Normalize the different Supervisor add-on list shapes."""
    if isinstance(value, list):
        result: list[dict[str, Any]] = []
        for item in value:
            if isinstance(item, dict):
                result.append(item)
            elif isinstance(item, str):
                result.append({"slug": item})
        return result
    if isinstance(value, dict):
        nested = value.get("apps") or value.get("addons")
        if isinstance(nested, (list, dict)) and nested is not value:
            return _as_addon_list(nested)
        result = []
        for key, item in value.items():
            if isinstance(item, dict):
                if "slug" not in item:
                    item = {**item, "slug": key}
                result.append(item)
        return result
    return []


def _looks_like_ours(entry: dict[str, Any]) -> bool:
    """Match the add-on by slug or display name."""
    slug = str(entry.get("slug") or "").lower()
    name = str(entry.get("name") or "").lower()
    return any(hint in slug or hint in name for hint in SLUG_HINTS)


def _local_addon_urls(hass: Any) -> list[str]:
    """Useful when the add-on is a standalone container on the HA host."""
    api = getattr(hass.config, "api", None)
    local_ip = getattr(api, "local_ip", None)
    if not local_ip:
        return []
    host = str(local_ip)
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return [f"http://{host}:{DEFAULT_PORT}"]


async def async_discover_addon(hass: Any) -> dict[str, Any]:
    """Ask Supervisor for the exact Hasar add-on hostname and port.

    Works on Home Assistant OS / Supervised. On Home Assistant Container,
    or when the Supervisor API is unavailable, returns a marker that tells
    the flow to use the manual/fallback path.
    """
    supervisor = (os.environ.get(ENV_SUPERVISOR) or "").rstrip("/")
    token = os.environ.get(ENV_SUPERVISOR_TOKEN)
    if not supervisor or not token:
        return {"supervised": False}

    session = async_get_clientsession(hass)
    headers = {"Authorization": f"Bearer {token}"}
    errors = (aiohttp.ClientError, TimeoutError, OSError, ValueError)

    try:
        payload = await _supervisor_get(session, f"{supervisor}/addons", headers)
    except errors as err:
        _LOGGER.warning("Supervisor API is unavailable: %s", err)
        return {"supervised": True, "api_error": str(err)}

    data = payload.get("data") if isinstance(payload, dict) else payload
    installed = _as_addon_list(data)
    if not installed and isinstance(payload, dict):
        # Some Supervisor versions return {"apps": [...]} without a data wrapper.
        installed = _as_addon_list(payload)
    if not installed:
        return {"supervised": True}

    _LOGGER.debug(
        "Supervisor add-ons: %s",
        [str(entry.get("slug")) for entry in installed],
    )

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

        ip_address = info.get("ip_address")
        if ip_address in ("", "0.0.0.0", "::", None):
            ip_address = None

        urls: list[str] = []
        for host in (hostname, f"{hostname}.local.hass.io", ip_address):
            if host:
                url = f"http://{host}:{port}"
                if url not in urls:
                    urls.append(url)

        _LOGGER.debug("Supervisor: add-on %s -> %s", slug, urls)
        return {
            "supervised": True,
            "slug": slug,
            "hostname": hostname,
            "state": str(info.get("state") or entry.get("state") or ""),
            "urls": urls,
        }

    return {"supervised": True}


async def _probe_addon(
    session: aiohttp.ClientSession,
    base_url: str,
    timeout: aiohttp.ClientTimeout,
) -> dict[str, Any]:
    """Check /health and /api/config to make sure this is Hasar."""
    async with session.get(f"{base_url}/health", timeout=timeout) as response:
        response.raise_for_status()
        try:
            health = await response.json(content_type=None)
        except ValueError as err:
            raise WrongService(base_url) from err
    if not isinstance(health, dict) or health.get("status") != "ok":
        raise WrongService(base_url)

    async with session.get(f"{base_url}/api/config", timeout=timeout) as response:
        response.raise_for_status()
        try:
            config = await response.json(content_type=None)
        except ValueError as err:
            raise WrongService(base_url) from err
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
        """Find the add-on automatically; ask for an address only if needed."""
        found = await async_discover_addon(self.hass)
        discovered = list(found.get("urls") or [])
        for url in _local_addon_urls(self.hass):
            if url not in discovered:
                discovered.append(url)

        if user_input is None:
            # Try the addresses Supervisor gave us before showing a form.
            config, first_error = await self._probe_candidates(
                discovered[:4], AUTO_TIMEOUT, AUTO_FALLBACK_TIMEOUT
            )
            if config is not None:
                return await self._after_addon_found(config)

            suggested = discovered[0] if discovered else DEFAULT_ADDON_URL
            tried = discovered or [DEFAULT_ADDON_URL]
            return self.async_show_form(
                step_id="user",
                data_schema=vol.Schema(
                    {vol.Required("addon_url", default=suggested): str}
                ),
                description_placeholders={
                    "tried": ", ".join(tried),
                    "hostname": found.get("hostname") or "",
                    "state": found.get("state") or "",
                },
            )

        typed = _normalize_addon_url(user_input.get("addon_url", ""))
        candidates: list[str] = []
        for url in (typed, *discovered, *FALLBACK_ADDON_URLS):
            if url and url not in candidates:
                candidates.append(url)

        config, first_error = await self._probe_candidates(
            candidates, PROBE_TIMEOUT, FALLBACK_TIMEOUT
        )
        if config is not None:
            return await self._after_addon_found(config)

        _LOGGER.warning("Hasar add-on not found. Tried: %s", ", ".join(candidates))
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {vol.Required("addon_url", default=typed): str}
            ),
            errors={"base": self._error_for(found, first_error)},
            description_placeholders={
                "tried": ", ".join(candidates),
                "hostname": found.get("hostname") or "",
                "state": found.get("state") or "",
            },
        )

    async def _probe_candidates(
        self,
        candidates: list[str],
        first_timeout: aiohttp.ClientTimeout,
        rest_timeout: aiohttp.ClientTimeout,
    ) -> tuple[dict[str, Any] | None, str]:
        """Probe addresses in order and return the first Hasar config."""
        first_error = "cannot_connect"
        session = async_get_clientsession(self.hass)

        for index, base_url in enumerate(candidates):
            timeout = first_timeout if index == 0 else rest_timeout
            try:
                config = await _probe_addon(session, base_url, timeout)
            except WrongService:
                if index == 0:
                    first_error = "bad_response"
                _LOGGER.debug("Address %s is not a Hasar add-on", base_url)
                continue
            except aiohttp.ClientResponseError as err:
                if index == 0 and 400 <= err.status < 500:
                    first_error = "bad_response"
                _LOGGER.debug("Address %s returned HTTP %s", base_url, err.status)
                continue
            except (aiohttp.ClientError, TimeoutError, OSError, ValueError) as err:
                _LOGGER.debug("Address %s is unavailable: %s", base_url, err)
                continue

            self._async_abort_entries_match({"addon_url": base_url})
            if index > 0:
                _LOGGER.info("Hasar add-on found at %s", base_url)
            self._addon_url = base_url
            return config, first_error

        return None, first_error

    async def _after_addon_found(self, config: dict[str, Any]) -> FlowResult:
        """Go to confirmation or pairing after a successful probe."""
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

    def _error_for(self, found: dict[str, Any], first_error: str) -> str:
        """Choose a useful error instead of always saying cannot_connect."""
        if found.get("api_error"):
            return "supervisor_unavailable"
        if found.get("hostname") and found.get("state") not in ("", "started"):
            return "addon_stopped"
        if found.get("supervised") and not found.get("hostname"):
            return "addon_missing"
        if not found.get("supervised"):
            return "not_supervised"
        if first_error == "bad_response":
            return "bad_response"
        return "cannot_connect"

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
                    errors["base"] = "cannot_connect_pairing"
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
