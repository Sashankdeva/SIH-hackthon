"""Phase 2 — API contract hardening for /reason.

The rule under test: the contract must be deterministic and safe enough
for multiple independent, untrusted extension clients — not just the
one client this project was built alongside. Every case here is a
request or response shape, not a reasoning-quality question (that's
test_prompt.py / benchmarks/).

Failure envelope, uniform across every rejection reason:
    {"error": <code>, "detail": <human message>, "task_id": <str|null>}

| code               | status | meaning                                            |
|--------------------|--------|-----------------------------------------------------|
| invalid_request    | 422    | request didn't parse: malformed JSON, missing/wrong-typed fields, bad enum values |
| context_rejected   | 422    | request parsed, but fields aren't sanitized (not a redaction token) |
| action_rejected    | 422    | the MODEL's proposed action failed deterministic validation |
| model_output_invalid | 502  | model answered with something unusable as JSON      |
| model_unavailable  | 503    | Ollama unreachable, model missing, or timed out     |
| request_too_large  | 413    | body exceeded the configured size limit             |
| context_too_large  | 413    | rendered PROMPT (post-parse) exceeded the configured num_ctx/num_predict budget — see SERVER PHASE S6.1 |
| internal_error     | 500    | unanticipated server-side failure                   |

A success is always exactly the ActionResponse shape; a failure never
carries an "action" key. See app/llm/errors.py.
"""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.llm.client import OllamaReasoningClient
from app.main import app
from app.models.action import ActionResponse
from app.routes import reason as reason_route
from tests.conftest import action_json, ollama_transport

client = TestClient(app)


def base_payload(**overrides: object) -> dict:
    body = {
        "task_id": "task-1",
        "task": "place the order",
        "page": "Mock Checkout",
        "url_origin": "http://localhost:8000",
        "elements": [
            {"element_id": 1, "role": "input:text", "label": "[PERSON_NAME_01]"},
            {"element_id": 2, "role": "input:password", "label": "[PASSWORD_01]"},
            {"element_id": 6, "role": "button", "label": "Place Order"},
        ],
        "fields": {"1": "[PERSON_NAME_01]", "2": "[PASSWORD_01]"},
    }
    body.update(overrides)
    return body


@pytest.fixture
def ollama_backend(monkeypatch):
    """Swap the module-level client for one on a mock transport —
    identical fixture to test_reason_endpoint.py's, duplicated here
    rather than imported so this file reads standalone."""

    def use(transport: httpx.AsyncBaseTransport) -> None:
        monkeypatch.setattr(
            reason_route,
            "_client",
            OllamaReasoningClient(
                model="test-model", base_url="http://localhost:11434", timeout_s=5.0, transport=transport
            ),
        )

    return use


def assert_envelope(response, *, status: int, code: str) -> dict:
    assert response.status_code == status
    body = response.json()
    assert body["error"] == code, body
    assert "detail" in body and isinstance(body["detail"], str) and body["detail"]
    assert "task_id" in body
    assert "action" not in body, "a failure must never carry an action"
    return body


# ======================================================================
# VALID
# ======================================================================


def test_valid_normal_request(ollama_backend) -> None:
    ollama_backend(ollama_transport(response_text=action_json(element_id=6)))
    response = client.post("/reason", json=base_payload())
    assert response.status_code == 200
    data = response.json()
    # Response conforms exactly to ActionResponse — no extra, no missing.
    assert set(data.keys()) == set(ActionResponse.model_fields.keys())
    assert data["action"] == "click"
    assert data["element_id"] == 6
    assert data["task_id"] == "task-1"
    assert data["step_id"] == 1


def test_valid_request_with_history(ollama_backend) -> None:
    ollama_backend(ollama_transport(response_text=action_json(element_id=6)))
    payload = base_payload(
        history=[
            {
                "step": 1,
                "action": "type_secret",
                "element_id": 1,
                "element_label": "[PERSON_NAME_01]",
                "outcome": "success",
            }
        ]
    )
    response = client.post("/reason", json=payload)
    assert response.status_code == 200
    # step_id reflects history length + 1 — a multi-step client's next
    # request naturally advances without the server holding any state.
    assert response.json()["step_id"] == 2


def test_valid_request_with_multiple_elements(ollama_backend) -> None:
    ollama_backend(ollama_transport(response_text=action_json(element_id=6)))
    payload = base_payload(
        elements=[
            {"element_id": i, "role": "input:text", "label": f"Field {i}"} for i in range(1, 21)
        ]
        + [{"element_id": 6, "role": "button", "label": "Place Order"}],
        fields={},
    )
    response = client.post("/reason", json=payload)
    assert response.status_code == 200


def test_valid_type_secret_token_reference(ollama_backend) -> None:
    ollama_backend(
        ollama_transport(response_text=action_json(action="type_secret", element_id=2, value=None, value_ref="[PASSWORD_01]"))
    )
    response = client.post("/reason", json=base_payload())
    assert response.status_code == 200
    data = response.json()
    assert data["action"] == "type_secret"
    assert data["value_ref"] == "[PASSWORD_01]"
    assert data["value"] is None, "type_secret must never carry a literal value alongside value_ref"


# ======================================================================
# INVALID REQUEST — never reaches reasoning, always invalid_request/422
# ======================================================================


def test_missing_task_returns_invalid_request() -> None:
    payload = base_payload()
    del payload["task"]
    response = client.post("/reason", json=payload)
    assert_envelope(response, status=422, code="invalid_request")


def test_missing_task_id_returns_invalid_request() -> None:
    payload = base_payload()
    del payload["task_id"]
    response = client.post("/reason", json=payload)
    assert_envelope(response, status=422, code="invalid_request")


def test_missing_elements_returns_invalid_request() -> None:
    """elements is now a required key (tightened to match the JSON
    schema and the extension's serializer, which always sends it —
    see app/models/context.py)."""
    payload = base_payload()
    del payload["elements"]
    response = client.post("/reason", json=payload)
    assert_envelope(response, status=422, code="invalid_request")


def test_missing_fields_returns_invalid_request() -> None:
    payload = base_payload()
    del payload["fields"]
    response = client.post("/reason", json=payload)
    assert_envelope(response, status=422, code="invalid_request")


def test_malformed_elements_wrong_type_returns_invalid_request() -> None:
    payload = base_payload(elements=[{"element_id": "not-an-int", "role": "button"}])
    response = client.post("/reason", json=payload)
    assert_envelope(response, status=422, code="invalid_request")


def test_malformed_elements_not_a_list_returns_invalid_request() -> None:
    payload = base_payload(elements={"element_id": 1, "role": "button"})
    response = client.post("/reason", json=payload)
    assert_envelope(response, status=422, code="invalid_request")


def test_malformed_elements_missing_required_subfield_returns_invalid_request() -> None:
    """CapturedElement requires role — an element without one is malformed."""
    payload = base_payload(elements=[{"element_id": 1}])
    response = client.post("/reason", json=payload)
    assert_envelope(response, status=422, code="invalid_request")


def test_invalid_action_structure_extra_field_returns_invalid_request() -> None:
    """extra='forbid' on SanitizedContext rejects a field the schema
    doesn't define — the request-side half of the same discipline
    ActionResponse applies to what the model emits."""
    payload = base_payload(unexpected_field="should not be here")
    response = client.post("/reason", json=payload)
    assert_envelope(response, status=422, code="invalid_request")


def test_malformed_history_invalid_outcome_enum_returns_invalid_request() -> None:
    payload = base_payload(
        history=[{"step": 1, "action": "click", "element_id": 6, "element_label": None, "outcome": "definitely-not-a-real-outcome"}]
    )
    response = client.post("/reason", json=payload)
    assert_envelope(response, status=422, code="invalid_request")


def test_malformed_history_missing_required_subfield_returns_invalid_request() -> None:
    """StepRecord requires step, action, outcome — 'outcome' missing here."""
    payload = base_payload(history=[{"step": 1, "action": "click", "element_id": 6}])
    response = client.post("/reason", json=payload)
    assert_envelope(response, status=422, code="invalid_request")


def test_malformed_history_step_below_minimum_returns_invalid_request() -> None:
    payload = base_payload(
        history=[{"step": 0, "action": "click", "element_id": None, "element_label": None, "outcome": "success"}]
    )
    response = client.post("/reason", json=payload)
    assert_envelope(response, status=422, code="invalid_request")


def test_malformed_json_returns_invalid_request() -> None:
    response = client.post(
        "/reason", content=b"{not valid json at all", headers={"content-type": "application/json"}
    )
    assert_envelope(response, status=422, code="invalid_request")


def test_invalid_request_task_id_echoed_when_recoverable() -> None:
    """Even a request that fails validation should let the client tie
    the refusal back to its task, when the body parsed far enough to
    show a task_id — mirrors the existing guarantee for reasoning
    failures (test_error_response_carries_task_id)."""
    payload = base_payload(task_id="task-broken-one")
    del payload["task"]
    response = client.post("/reason", json=payload)
    body = assert_envelope(response, status=422, code="invalid_request")
    assert body["task_id"] == "task-broken-one"


def test_unsanitized_context_returns_context_rejected() -> None:
    """Distinct from action_rejected: this is the CLIENT's payload
    failing the privacy check, before reasoning ever runs."""
    payload = base_payload(fields={"1": "person@example.com"})
    response = client.post("/reason", json=payload)
    body = assert_envelope(response, status=422, code="context_rejected")
    assert body["task_id"] == "task-1"


def test_unsanitized_context_wrapped_email_returns_context_rejected() -> None:
    payload = base_payload(fields={"1": "[person@example.com]"})
    response = client.post("/reason", json=payload)
    assert_envelope(response, status=422, code="context_rejected")


# ======================================================================
# OVERSIZED REQUEST
# ======================================================================


def test_oversized_request_returns_413_via_content_length() -> None:
    limit = load_settings().max_request_body_bytes
    # task itself is capped at 500 chars by SanitizedContext, so inflate
    # via a giant (still schema-valid-shaped) elements list instead.
    payload = base_payload(
        elements=[{"element_id": i, "role": "input:text", "label": "x" * 200} for i in range(1, 2000)]
    )
    body_bytes = json.dumps(payload).encode("utf-8")
    assert len(body_bytes) > limit, "test setup must actually exceed the configured limit"
    response = client.post(
        "/reason", content=body_bytes, headers={"content-type": "application/json"}
    )
    assert_envelope(response, status=413, code="request_too_large")


def test_oversized_prompt_returns_413_via_context_too_large_not_wire_size(monkeypatch) -> None:
    """SERVER PHASE S7 — the S6.1 prompt-level guard, verified end to
    end through the real HTTP contract (S6.1 only tested it at the
    client/probe level). Short labels keep the WIRE payload comfortably
    under MAX_REQUEST_BODY_BYTES (64 KiB) — this must trip
    ContextTooLarge specifically, a DIFFERENT failure than
    request_too_large, and never reach Ollama at all (the mock
    transport raises if it is).
    """

    def never_call(request: httpx.Request) -> httpx.Response:
        raise AssertionError("Ollama must never be called for an oversized prompt")

    monkeypatch.setattr(
        reason_route,
        "_client",
        OllamaReasoningClient(
            model="test-model", base_url="http://localhost:11434", timeout_s=5.0,
            transport=httpx.MockTransport(never_call),
        ),
    )

    payload = base_payload(
        elements=[{"element_id": i, "role": "button", "label": f"Option {i}"} for i in range(1, 701)]
    )
    body_bytes = json.dumps(payload).encode("utf-8")
    limit = load_settings().max_request_body_bytes
    assert len(body_bytes) < limit, "test setup must stay UNDER the wire-size limit to isolate this check"

    response = client.post("/reason", json=payload)
    body = assert_envelope(response, status=413, code="context_too_large")
    assert "budget" in body["detail"] or "token" in body["detail"]


def test_request_at_the_limit_is_not_rejected_for_size(ollama_backend) -> None:
    """A boundary check: the limit must not be so tight it rejects a
    normal, if slightly larger, legitimate payload."""
    ollama_backend(ollama_transport(response_text=action_json(element_id=6)))
    payload = base_payload(
        elements=[{"element_id": i, "role": "input:text", "label": f"Field {i}"} for i in range(1, 51)]
        + [{"element_id": 6, "role": "button", "label": "Place Order"}]
    )
    response = client.post("/reason", json=payload)
    assert response.status_code != 413


# ======================================================================
# RESPONSE FAILURES — model/reasoning side
# ======================================================================


def test_invalid_model_output_returns_model_output_invalid(ollama_backend) -> None:
    ollama_backend(ollama_transport(response_text="not json at all"))
    response = client.post("/reason", json=base_payload())
    assert_envelope(response, status=502, code="model_output_invalid")


def test_model_unavailable_returns_model_unavailable(ollama_backend) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    ollama_backend(httpx.MockTransport(refuse))
    response = client.post("/reason", json=base_payload())
    assert_envelope(response, status=503, code="model_unavailable")


def test_model_timeout_returns_model_unavailable(ollama_backend) -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow", request=request)

    ollama_backend(httpx.MockTransport(timeout))
    response = client.post("/reason", json=base_payload())
    assert_envelope(response, status=503, code="model_unavailable")


def test_invented_element_id_returns_action_rejected(ollama_backend) -> None:
    """The model referencing an element_id the client never supplied —
    the 'invalid element ID' case from the model-output side, as
    opposed to the request-schema side covered above."""
    ollama_backend(ollama_transport(response_text=action_json(element_id=999)))
    response = client.post("/reason", json=base_payload())
    assert_envelope(response, status=422, code="action_rejected")


# ======================================================================
# INTERNAL ERROR — never leaks implementation details
# ======================================================================


def test_unexpected_exception_returns_generic_internal_error(monkeypatch) -> None:
    """Starlette's ServerErrorMiddleware always re-raises after invoking
    a custom Exception handler (by design — so a real ASGI server logs
    it while a test client can choose to surface it, per the middleware's
    own comment). The 500 response is still correctly built and sent
    either way; raise_server_exceptions=False here just lets this test
    see it instead of the re-raised exception itself.
    """
    unsafe_client = TestClient(app, raise_server_exceptions=False)

    async def boom(context):
        raise RuntimeError("a very specific internal detail that must never reach the client")

    monkeypatch.setattr(reason_route._client, "propose_action", boom)
    response = unsafe_client.post("/reason", json=base_payload())
    body = assert_envelope(response, status=500, code="internal_error")
    assert "very specific internal detail" not in body["detail"]
    assert "RuntimeError" not in body["detail"]
    assert "Traceback" not in body["detail"]
