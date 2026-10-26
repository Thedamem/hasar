"""Services that expose HA intent recognition without executing it."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.components import conversation
from homeassistant.components.conversation.const import HOME_ASSISTANT_AGENT
from homeassistant.components.conversation.models import ConversationInput
from homeassistant.core import (
    Context,
    HomeAssistant,
    ServiceCall,
    SupportsResponse,
)
from homeassistant.exceptions import HomeAssistantError

from .const import DOMAIN, SERVICE_RECOGNIZE_INTENT

_LOGGER = logging.getLogger(__name__)

RECOGNIZE_SCHEMA = vol.Schema(
    {
        vol.Required("text"): str,
        vol.Optional("language"): str,
        vol.Optional("device_id"): str,
    }
)


async def async_setup_services(hass: HomeAssistant) -> None:
    """Register Hasar services once."""
    if hass.services.has_service(DOMAIN, SERVICE_RECOGNIZE_INTENT):
        return

    async def async_recognize_intent(call: ServiceCall) -> dict[str, Any]:
        agent = conversation.async_get_agent(hass, HOME_ASSISTANT_AGENT)
        if agent is None:
            raise HomeAssistantError("Home Assistant conversation agent is unavailable")

        recognizer = getattr(agent, "async_recognize_intent", None)
        if not callable(recognizer):
            raise HomeAssistantError(
                "This Home Assistant version does not expose dry-run intent recognition"
            )

        user_input = ConversationInput(
            text=call.data["text"],
            context=Context(),
            conversation_id=None,
            device_id=call.data.get("device_id"),
            satellite_id=None,
            language=call.data.get("language") or hass.config.language,
            agent_id=HOME_ASSISTANT_AGENT,
        )
        try:
            result = await recognizer(user_input, strict_intents_only=True)
        except TypeError:
            result = await recognizer(user_input)

        if result is None:
            return {"matched": False, "intent": None, "slots": {}}

        slots: dict[str, Any] = {}
        for key, entity in result.entities.items():
            slots[key] = {
                "text": getattr(entity, "text", None),
                "value": getattr(entity, "value", None),
            }

        return {
            "matched": not bool(result.unmatched_entities),
            "intent": result.intent.name,
            "slots": slots,
            "unmatched_entities": list(result.unmatched_entities),
        }

    hass.services.async_register(
        DOMAIN,
        SERVICE_RECOGNIZE_INTENT,
        async_recognize_intent,
        schema=RECOGNIZE_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
