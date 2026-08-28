"""HTTP contract for /reason.

The rule under test: a failure must never be HTTP 200 with an action.
The extension has to be able to distinguish "the model deliberately
chose to wait" from "the server could not produce a trustworthy answer",
and a 200 with a synthetic `wait` makes those identical.
"""

import httpx
import pytest
from fastapi.testclient import TestClient

from app.llm.client import OllamaReasoningClient
from app.main import app
from app.routes import reason as reason_route
from tests.conftest import action_json, ollama_transport

client = TestClient(app)


def payload(**overrides: object) -> dict:
    body = {
        "task_id": "task-1",
        "task": "place the order",
        "page": "Mock Checkout",
        "url_origin": "http://localhost:8000",
        "elements": [{"element_id": 6, "role": "button", "label": "Place Order"}],
        "fields": {},
    }
    body.update(overrides)
    return body


@pytest.fixture
def ollama_backend(monkeypatch):
    """Swap the module-level client for one on a mock transport."""

    def use(transport: httpx.AsyncBaseTransport) -> None:
        monkeypatch.setattr(
            reason_route,
            "_client",
            OllamaReasoningClient(
                model="test-model", base_url="http://localhost:11434", timeout_s=5.0, transport=transport
            ),
        )

    return use


def test_success_returns_200_and_action(ollama_backend) -> None:
    ollama_backend(ollama_transport(response_text=action_json()))
    response = client.post("/reason", json=payload())
    assert response.status_code == 200
    assert response.json()["action"] == "click"


def test_model_unavailable_returns_503(ollama_backend) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    ollama_backend(httpx.MockTransport(refuse))
    response = client.post("/reason", json=payload())
    assert response.status_code == 503
    assert response.json()["error"] == "model_unavailable"


def test_malformed_model_output_returns_502(ollama_backend) -> None:
    ollama_backend(ollama_transport(response_text="not json at all"))
    response = client.post("/reason", json=payload())
    assert response.status_code == 502
    assert response.json()["error"] == "model_output_invalid"


def test_security_rejection_returns_422(ollama_backend) -> None:
    ollama_backend(ollama_transport(response_text=action_json(element_id=999)))
    response = client.post("/reason", json=payload())
    assert response.status_code == 422
    assert response.json()["error"] == "action_rejected"


def test_failure_never_returns_a_fabricated_action(ollama_backend) -> None:
    """The regression this whole change exists for."""
    ollama_backend(ollama_transport(response_text="prose, not an action"))
    response = client.post("/reason", json=payload())
    assert response.status_code != 200
    assert "action" not in response.json()


def test_error_response_carries_task_id(ollama_backend) -> None:
    """The client must be able to tie a refusal to the task it asked about."""
    ollama_backend(ollama_transport(status_code=500))
    response = client.post("/reason", json=payload(task_id="task-xyz"))
    assert response.json()["task_id"] == "task-xyz"
