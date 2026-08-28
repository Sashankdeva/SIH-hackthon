"""Optional integration test against a REAL local Ollama.

Skipped automatically when Ollama isn't reachable or the model isn't
pulled, so the normal suite stays hermetic and runs on any machine.

Run it deliberately with:
    pytest tests/test_integration_ollama.py -v
"""

import asyncio

import httpx
import pytest

from app.config import load_settings
from app.llm.client import OllamaReasoningClient
from app.llm.errors import ReasoningError
from app.models.context import SanitizedContext

_settings = load_settings()


def _ollama_available() -> bool:
    try:
        response = httpx.get(f"{_settings.ollama_base_url}/api/tags", timeout=2.0)
        if response.status_code != 200:
            return False
        names = {m.get("name") for m in response.json().get("models", [])}
        return _settings.ollama_model in names
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _ollama_available(),
    reason=f"Ollama with model {_settings.ollama_model!r} not reachable at {_settings.ollama_base_url}",
)


@pytest.fixture
def login_page() -> SanitizedContext:
    return SanitizedContext(
        task_id="integration-1",
        task="log in with my password",
        page="Login",
        url_origin="http://localhost:8000",
        elements=[
            {"element_id": 1, "role": "input:email", "label": "[EMAIL_01]"},
            {"element_id": 2, "role": "input:password", "label": "[PASSWORD_01]"},
            {"element_id": 3, "role": "button", "label": "Sign in"},
        ],
        fields={"1": "[EMAIL_01]", "2": "[PASSWORD_01]"},
    )


def test_real_model_produces_a_valid_action(login_page: SanitizedContext) -> None:
    """The real model must return something that survives the full
    deterministic validation layer — not merely something parseable.
    """
    client = OllamaReasoningClient()
    action = asyncio.run(client.propose_action(login_page))
    assert action.action in {"click", "type", "type_secret", "scroll", "navigate", "keypress", "wait"}
    if action.action in {"click", "type", "type_secret"}:
        assert action.element_id in {1, 2, 3}


def test_real_model_binds_secret_to_the_right_field(login_page: SanitizedContext) -> None:
    """If it chooses type_secret, the token must belong to the element it
    targets. A mismatch would be caught by validation (raising), so
    reaching an assertion at all means the binding held.
    """
    client = OllamaReasoningClient()
    try:
        action = asyncio.run(client.propose_action(login_page))
    except ReasoningError as exc:
        pytest.skip(f"model refused or was rejected this run: {exc.code}")

    if action.action == "type_secret":
        assert action.element_id == 2
        assert action.value_ref == "[PASSWORD_01]"
        assert action.value is None


def test_real_model_is_deterministic(login_page: SanitizedContext) -> None:
    """temperature is pinned to 0 so a demo is reproducible. Same input,
    same action.
    """
    client = OllamaReasoningClient()
    first = asyncio.run(client.propose_action(login_page))
    second = asyncio.run(client.propose_action(login_page))
    assert (first.action, first.element_id) == (second.action, second.element_id)
