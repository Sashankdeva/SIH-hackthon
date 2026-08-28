"""Shared fixtures for the reasoning-pipeline tests.

No test in the normal suite requires a running Ollama — the HTTP layer
is driven through httpx.MockTransport. Only tests/test_integration_ollama.py
talks to a real model, and it skips itself when none is reachable.
"""

import json

import httpx
import pytest

from app.models.context import SanitizedContext

CHECKOUT_ORIGIN = "http://localhost:8000"


@pytest.fixture
def checkout_context() -> SanitizedContext:
    """A realistic sanitized page: two links, redacted name/email/password
    fields, a plain (non-sensitive) field, and a submit button.
    """
    return SanitizedContext(
        task_id="task-1",
        task="place the order",
        page="Mock Checkout",
        url_origin=CHECKOUT_ORIGIN,
        elements=[
            {"element_id": 1, "role": "link", "label": "Privacy test page"},
            {"element_id": 2, "role": "input:text", "label": "[PERSON_NAME_01]"},
            {"element_id": 3, "role": "input:email", "label": "[EMAIL_01]"},
            {"element_id": 4, "role": "input:password", "label": "[PASSWORD_01]"},
            {"element_id": 5, "role": "input:text", "label": "Shipping note"},
            {"element_id": 6, "role": "button", "label": "Place Order"},
        ],
        fields={
            "2": "[PERSON_NAME_01]",
            "3": "[EMAIL_01]",
            "4": "[PASSWORD_01]",
        },
    )


def ollama_transport(
    *, response_text: str | None = None, status_code: int = 200, envelope: object | None = None
) -> httpx.MockTransport:
    """A MockTransport standing in for Ollama's /api/generate.

    `response_text` is what the model "said". `envelope` overrides the
    whole JSON body, for testing malformed envelopes.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if status_code != 200:
            return httpx.Response(status_code, json={"error": "simulated"})
        if envelope is not None:
            return httpx.Response(200, json=envelope)
        return httpx.Response(200, json={"response": response_text})

    return httpx.MockTransport(handler)


def action_json(**overrides: object) -> str:
    """A well-formed action, with fields overridden per test."""
    action = {
        "action": "click",
        "element_id": 6,
        "value": None,
        "value_ref": None,
        "direction": None,
        "amount": None,
        "url": None,
        "confidence": 0.9,
    }
    action.update(overrides)
    return json.dumps(action)
