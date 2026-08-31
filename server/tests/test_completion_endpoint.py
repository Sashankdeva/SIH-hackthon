"""POST /complete — contract, security, and fail-closed behaviour.

Hermetic: every model response here is a mock, so these assert what the
SERVER guarantees regardless of what the model says. Whether the real
model judges correctly is a separate question, measured by
tests/test_completion_regression_live.py and benchmarks/completion_eval.py.

The governing rule under test is FAIL CLOSED: `complete: true` may only
ever reach a client from a model that answered, whose answer parsed, and
whose answer was a real JSON boolean. Every other path must be an error.
A wrong "your task is finished" is the failure that actually harms a
user, so most of this file is about the ways that must not happen.
"""

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.llm.completion import CompletionProbe
from app.llm.errors import ModelOutputInvalid, ModelUnavailable
from app.main import app
from app.models.completion import CompletionResponse
from app.models.context import SanitizedContext, StepRecord
from app.routes import complete as complete_route

client = TestClient(app)
ORIGIN = "http://localhost:8000"


def run(coro):
    return asyncio.run(coro)


def completion_transport(*, answer_json: str | None = None, status_code: int = 200,
                         envelope: object | None = None) -> httpx.MockTransport:
    """Stands in for Ollama's /api/generate for the completion probe."""

    def handler(request: httpx.Request) -> httpx.Response:
        if status_code != 200:
            return httpx.Response(status_code, json={"error": "simulated"})
        if envelope is not None:
            return httpx.Response(200, json=envelope)
        return httpx.Response(200, json={"response": answer_json})

    return httpx.MockTransport(handler)


def probe_with(transport: httpx.AsyncBaseTransport) -> CompletionProbe:
    return CompletionProbe(
        model="test-model", base_url="http://localhost:11434", timeout_s=5.0, transport=transport
    )


@pytest.fixture
def mock_probe(monkeypatch):
    """Swap the module-level probe for one on a mock transport."""

    def use(transport: httpx.AsyncBaseTransport) -> None:
        monkeypatch.setattr(complete_route, "_probe", probe_with(transport))

    return use


def payload(**overrides) -> dict:
    body = {
        "task_id": "task-complete-1",
        "task": "sign out",
        "page": "Signed out",
        "url_origin": ORIGIN,
        "elements": [{"element_id": 1, "role": "link", "label": "Sign in"}],
        "fields": {},
        "history": [
            {"step": 1, "action": "click", "element_id": 2,
             "element_label": "Sign out", "outcome": "success"}
        ],
    }
    body.update(overrides)
    return body


def ctx(**overrides) -> SanitizedContext:
    base = dict(
        task_id="task-complete-1", task="sign out", page="Signed out", url_origin=ORIGIN,
        elements=[{"element_id": 1, "role": "link", "label": "Sign in"}], fields={},
        history=[StepRecord(step=1, action="click", element_label="Sign out", outcome="success")],
    )
    base.update(overrides)
    return SanitizedContext(**base)


# ======================================================================
# RESPONSE SCHEMA — exact fields, task_id derived from the request
# ======================================================================


def test_response_has_exactly_two_fields(mock_probe) -> None:
    mock_probe(completion_transport(answer_json='{"complete": true}'))
    response = client.post("/complete", json=payload())
    assert response.status_code == 200
    assert set(response.json().keys()) == {"complete", "task_id"}


def test_response_never_carries_action_fields(mock_probe) -> None:
    """This is not an ActionResponse. Nothing in it is executable."""
    mock_probe(completion_transport(answer_json='{"complete": true}'))
    body = client.post("/complete", json=payload()).json()
    for forbidden in ("action", "element_id", "value", "value_ref", "url", "confidence", "step_id"):
        assert forbidden not in body


def test_task_id_is_derived_from_the_request(mock_probe) -> None:
    mock_probe(completion_transport(answer_json='{"complete": true}'))
    body = client.post("/complete", json=payload(task_id="task-xyz-999")).json()
    assert body["task_id"] == "task-xyz-999"


def test_model_cannot_supply_its_own_task_id(mock_probe) -> None:
    """A model that could set task_id could attribute a completion
    verdict to a task the user never ran. The schema forbids the field,
    and the probe rejects it rather than dropping it silently."""
    mock_probe(completion_transport(answer_json='{"complete": true, "task_id": "attacker-chosen"}'))
    response = client.post("/complete", json=payload(task_id="the-real-task"))
    assert response.status_code == 502
    assert response.json()["error"] == "model_output_invalid"


def test_completion_response_model_forbids_extra_fields() -> None:
    with pytest.raises(ValueError):
        CompletionResponse(complete=True, task_id="t", extra="nope")


# ======================================================================
# CLEARLY COMPLETE / INCOMPLETE — the server relays the verdict verbatim
# ======================================================================


@pytest.mark.parametrize("verdict", [True, False])
def test_server_relays_the_model_verdict(mock_probe, verdict) -> None:
    mock_probe(completion_transport(answer_json=f'{{"complete": {str(verdict).lower()}}}'))
    body = client.post("/complete", json=payload()).json()
    assert body["complete"] is verdict


@pytest.mark.parametrize(
    "task,page,history",
    [
        ("go to the settings page", "Settings",
         [{"step": 1, "action": "click", "element_label": "Settings", "outcome": "success"}]),
        ("fill in my email address", "Sign up",
         [{"step": 1, "action": "type_secret", "element_label": "[EMAIL_01]", "outcome": "success"}]),
        ("choose the large size", "Product detail",
         [{"step": 1, "action": "click", "element_label": "Large", "outcome": "success"}]),
        ("subscribe to the newsletter", "Thanks! You are now subscribed.",
         [{"step": 1, "action": "click", "element_label": "Subscribe", "outcome": "ambiguous"}]),
    ],
    ids=["navigation", "form", "selection", "semantic"],
)
def test_completion_shapes_are_accepted_end_to_end(mock_probe, task, page, history) -> None:
    """Navigation / form / selection / semantic completions all travel
    the same contract — none needs a special case server-side."""
    mock_probe(completion_transport(answer_json='{"complete": true}'))
    response = client.post("/complete", json=payload(task=task, page=page, history=history))
    assert response.status_code == 200
    assert response.json()["complete"] is True


def test_task_not_started_has_empty_history_and_is_accepted(mock_probe) -> None:
    mock_probe(completion_transport(answer_json='{"complete": false}'))
    response = client.post("/complete", json=payload(history=[]))
    assert response.status_code == 200
    assert response.json()["complete"] is False


def test_multi_step_history_reaches_the_prompt(mock_probe) -> None:
    """Compound tasks depend on the model seeing every prior step."""
    from app.llm.completion_prompt import build_completion_prompt

    prompt = build_completion_prompt(ctx(
        task="add the item to the cart and go to checkout",
        history=[
            StepRecord(step=1, action="click", element_label="Add to cart", outcome="success"),
            StepRecord(step=2, action="click", element_label="Checkout", outcome="success"),
        ],
    ))
    assert "1. click on 'Add to cart' -> success" in prompt
    assert "2. click on 'Checkout' -> success" in prompt


# ======================================================================
# SERVER PHASE S5 — history outcome fidelity and stale history
# ======================================================================


def test_failed_and_ambiguous_outcomes_render_their_exact_word() -> None:
    """The only prior test for history rendering uses all-success steps.
    "failure" and "ambiguous" must reach the prompt as their own literal
    words too — the model has no other way to distinguish them."""
    from app.llm.completion_prompt import build_completion_prompt

    prompt = build_completion_prompt(ctx(
        task="submit the form",
        history=[
            StepRecord(step=1, action="click", element_label="Submit", outcome="failure"),
            StepRecord(step=2, action="click", element_label="Submit", outcome="ambiguous"),
        ],
    ))
    assert "1. click on 'Submit' -> failure" in prompt
    assert "2. click on 'Submit' -> ambiguous" in prompt
    assert "Most recent action: click -> verification: ambiguous" in prompt


def test_stale_or_unrelated_history_is_rendered_verbatim_not_filtered() -> None:
    """No relevance heuristic exists anywhere in this pipeline — a
    history entry that has nothing to do with the current task (e.g. an
    unrelated prior action) still reaches the prompt exactly as supplied.
    Filtering "irrelevant" steps would itself be a task-specific
    heuristic, which this endpoint is built to avoid; the model, not the
    server, is responsible for judging relevance."""
    from app.llm.completion_prompt import build_completion_prompt

    prompt = build_completion_prompt(ctx(
        task="update my shipping address",
        history=[
            StepRecord(step=1, action="click", element_label="Apply discount code", outcome="success"),
        ],
    ))
    assert "1. click on 'Apply discount code' -> success" in prompt
    assert "update my shipping address" in prompt


# ======================================================================
# FAIL CLOSED — no failure may produce complete: true
# ======================================================================


def test_model_unavailable_returns_503_not_complete(mock_probe) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    mock_probe(httpx.MockTransport(refuse))
    response = client.post("/complete", json=payload())
    assert response.status_code == 503
    assert response.json()["error"] == "model_unavailable"
    assert "complete" not in response.json()


def test_timeout_returns_503_not_complete(mock_probe) -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow", request=request)

    mock_probe(httpx.MockTransport(slow))
    response = client.post("/complete", json=payload())
    assert response.status_code == 503
    assert response.json()["error"] == "model_unavailable"
    assert "complete" not in response.json()


@pytest.mark.parametrize(
    "bad_output",
    [
        "not json at all",
        '{"complete": ',
        '"true"',
        "[]",
        '[{"complete": true}]',
        "{}",
        '{"finished": true}',
        '{"complete": "true"}',
        '{"complete": 1}',
        '{"complete": null}',
        '{"complete": true, "reason": "because"}',
    ],
    ids=["prose", "truncated", "bare-string", "empty-array", "array", "empty-object",
         "wrong-key", "string-true", "int-one", "null", "extra-field"],
)
def test_malformed_completion_output_never_yields_complete(mock_probe, bad_output) -> None:
    """Each of these must raise, not coerce. `{"complete": 1}` is the
    subtle one — isinstance(True, int) is True in Python, so a bare
    truthiness check would have let 1 through as a verdict."""
    mock_probe(completion_transport(answer_json=bad_output))
    response = client.post("/complete", json=payload())
    assert response.status_code == 502
    assert response.json()["error"] == "model_output_invalid"
    assert "complete" not in response.json()


def test_empty_model_response_returns_502(mock_probe) -> None:
    mock_probe(completion_transport(answer_json="   "))
    response = client.post("/complete", json=payload())
    assert response.status_code == 502


def test_ollama_envelope_without_response_key_returns_502(mock_probe) -> None:
    mock_probe(completion_transport(envelope={"unexpected": "shape"}))
    assert client.post("/complete", json=payload()).status_code == 502


def test_model_not_pulled_returns_503(mock_probe) -> None:
    mock_probe(completion_transport(status_code=404))
    response = client.post("/complete", json=payload())
    assert response.status_code == 503
    assert response.json()["error"] == "model_unavailable"


def test_no_failure_path_returns_a_complete_field(mock_probe) -> None:
    """The summarising guarantee: across every failure mode, the word
    'complete' never appears in a response body."""
    failures = [
        completion_transport(answer_json="prose"),
        completion_transport(status_code=500),
        completion_transport(status_code=404),
        completion_transport(envelope={"nope": 1}),
        completion_transport(answer_json='{"complete": "yes"}'),
    ]
    for transport in failures:
        mock_probe(transport)
        body = client.post("/complete", json=payload()).json()
        assert "complete" not in body, body
        assert body["task_id"] == "task-complete-1"


# ======================================================================
# SECURITY / PRIVACY — same boundary as /reason
# ======================================================================


def test_unsanitized_context_is_rejected_before_the_model(mock_probe) -> None:
    """A raw field value must be refused by the shared context
    validator, and the model must never be consulted at all."""
    called = False

    def spy(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json={"response": '{"complete": true}'})

    mock_probe(httpx.MockTransport(spy))
    response = client.post("/complete", json=payload(fields={"1": "person@example.com"}))
    assert response.status_code == 422
    assert response.json()["error"] == "context_rejected"
    assert called is False, "the model was consulted despite an unsanitized payload"


def test_wrapped_email_is_rejected(mock_probe) -> None:
    mock_probe(completion_transport(answer_json='{"complete": true}'))
    response = client.post("/complete", json=payload(fields={"1": "[person@example.com]"}))
    assert response.status_code == 422
    assert response.json()["error"] == "context_rejected"


def test_unexpected_request_field_is_rejected() -> None:
    """extra='forbid' on SanitizedContext — a client cannot smuggle a
    raw field alongside the sanitized ones."""
    response = client.post("/complete", json=payload(cookies="session=abc123"))
    assert response.status_code == 422
    assert response.json()["error"] == "invalid_request"


def test_prompt_contains_only_tokens_never_raw_values() -> None:
    from app.llm.completion_prompt import build_completion_prompt

    prompt = build_completion_prompt(ctx(
        task="log in",
        elements=[
            {"element_id": 1, "role": "textbox", "label": "[PASSWORD_01]"},
            {"element_id": 2, "role": "button", "label": "Sign in"},
        ],
        fields={"1": "[PASSWORD_01]"},
    ))
    assert "[PASSWORD_01]" in prompt
    for canary in ("hunter2", "victim@example.com", "4242424242424242"):
        assert canary not in prompt


def test_completion_prompt_offers_no_actions() -> None:
    """The whole reason this prompt is separate: no action enum, so the
    completion judgement never competes with seven concrete actions."""
    from app.llm.completion_prompt import build_completion_prompt

    prompt = build_completion_prompt(ctx())
    for action_word in ("type_secret", "element_id", "value_ref", "keypress", "confidence"):
        assert action_word not in prompt


# ======================================================================
# STATELESSNESS
# ======================================================================


def test_identical_requests_do_not_accumulate_state(mock_probe) -> None:
    mock_probe(completion_transport(answer_json='{"complete": false}'))
    first = client.post("/complete", json=payload()).json()
    second = client.post("/complete", json=payload()).json()
    assert first == second


def test_probe_judge_returns_request_task_id_directly() -> None:
    probe = probe_with(completion_transport(answer_json='{"complete": true}'))
    result = run(probe.judge(ctx(task_id="unit-level-id")))
    assert isinstance(result, CompletionResponse)
    assert result.task_id == "unit-level-id"
    assert result.complete is True


def test_probe_raises_typed_errors_not_values() -> None:
    with pytest.raises(ModelOutputInvalid):
        run(probe_with(completion_transport(answer_json="nonsense")).judge(ctx()))
    with pytest.raises(ModelUnavailable):
        run(probe_with(completion_transport(status_code=503)).judge(ctx()))


# ======================================================================
# /reason ISOLATION
# ======================================================================


def test_reason_endpoint_is_unaffected() -> None:
    """/complete must not have changed /reason's contract."""
    response = client.post("/reason", json={
        "task_id": "t", "task": "submit the form", "page": "p", "url_origin": ORIGIN,
        "elements": [{"element_id": 1, "role": "button", "label": "Submit"}], "fields": {},
    })
    assert response.status_code == 200
    assert "action" in response.json()
    assert "complete" not in response.json()


# ======================================================================
# SERVER PHASE S6.1 — /complete gets the SAME explicit num_ctx/
# num_predict and pre-flight oversize guard /reason does. Its own
# prompt is usually much smaller, but it renders the SAME current
# elements list /reason does (see app/llm/completion_prompt.py's
# _render_elements), so a large page carries the identical risk.
# ======================================================================


def test_completion_num_ctx_and_num_predict_are_explicitly_sent(mock_probe) -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"response": '{"complete": true}'})

    mock_probe(httpx.MockTransport(handler))
    response = client.post("/complete", json=payload())
    assert response.status_code == 200

    options = captured.get("options", {})
    assert "num_ctx" in options
    assert "num_predict" in options
    assert isinstance(options["num_ctx"], int) and options["num_ctx"] > 4096


def test_completion_probe_num_ctx_defaults_from_settings() -> None:
    from app.config import load_settings

    settings = load_settings()
    default_probe = CompletionProbe(model="test-model", base_url="http://localhost:11434", timeout_s=5.0)
    assert default_probe.num_ctx == settings.ollama_num_ctx
    assert default_probe.num_predict == settings.ollama_num_predict

    overridden_probe = CompletionProbe(
        model="test-model", base_url="http://localhost:11434", timeout_s=5.0,
        num_ctx=1234, num_predict=12,
    )
    assert overridden_probe.num_ctx == 1234
    assert overridden_probe.num_predict == 12


def test_completion_oversized_context_fails_explicitly_before_any_ollama_call() -> None:
    from app.llm.errors import ContextTooLarge

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("Ollama must never be called for an oversized prompt")

    probe = probe_with(httpx.MockTransport(handler))
    huge_ctx = ctx(
        elements=[{"element_id": i + 1, "role": "button", "label": f"Option {i + 1}"} for i in range(2000)],
        history=[],
    )
    with pytest.raises(ContextTooLarge, match="over the configured budget"):
        run(probe.judge(huge_ctx))


    # SERVER PHASE S7 note: unlike /reason, there is no HTTP-level
    # sibling test for this — measured directly, /complete's much
    # leaner template (no rules/security/examples block) means its
    # per-element wire-JSON representation is consistently LARGER than
    # its per-element PROMPT contribution. Every combination tried
    # (elements alone, elements + a long history) hit
    # MAX_REQUEST_BODY_BYTES (request_too_large, 413) at or before the
    # point the rendered prompt would cross the num_ctx budget — so
    # context_too_large is not independently reachable for /complete
    # through the real HTTP endpoint with a uniform-shaped payload; the
    # existing wire-size limit is the practically-binding guard for this
    # endpoint. This is a reassuring structural property, not a gap:
    # /reason genuinely needs the newer prompt-level check (its larger
    # fixed template means a SMALLER wire payload can still render over
    # budget — see test_api_contract.py's HTTP-level test), /complete's
    # own compact shape means the existing check already covers it in
    # practice. The probe-level test above still proves the guard code
    # itself is correct and shared by both endpoints.
