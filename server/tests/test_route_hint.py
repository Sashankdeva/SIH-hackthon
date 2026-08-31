"""SERVER/SHARED CONTRACT PHASE S2.1 — route_hint navigation context.

The server had url_origin but nothing to distinguish /search from
/product/123 from /cart — Qwen could not tell those apart. route_hint
closes that gap: the CURRENT page's pathname only, never a full URL.
The client supplies the structural route; the server independently
validates its shape (never trusting the client); the prompt renders it
as one factual line.

Scope note, same discipline as test_element_availability.py: route_hint
is state, not instruction. No rule anywhere tells the model what a
route MEANS — inferring "this is a checkout page" from the path would
be exactly the semantic guessing this phase forbids.
"""

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.llm.prompt import build_prompt
from app.main import app
from app.models.context import SanitizedContext

client = TestClient(app)

ORIGIN = "http://localhost:8000"


def ctx(route_hint: str | None = None, **overrides: object) -> SanitizedContext:
    fields = {
        "task_id": "t-route",
        "task": "do the thing",
        "page": "Test page",
        "url_origin": ORIGIN,
        "elements": [],
        "fields": {},
        "route_hint": route_hint,
    }
    fields.update(overrides)
    return SanitizedContext(**fields)


def wire_payload(route_hint: str | None = None, **overrides: object) -> dict:
    body = {
        "task_id": "t-route",
        "task": "do the thing",
        "page": "Test page",
        "url_origin": ORIGIN,
        "elements": [],
        "fields": {},
    }
    if route_hint is not None:
        body["route_hint"] = route_hint
    body.update(overrides)
    return body


# ======================================================================
# MODEL — accepting, bounding, and rejecting the field
# ======================================================================


def test_valid_route_hint_is_accepted() -> None:
    assert ctx(route_hint="/search").route_hint == "/search"


def test_root_route_hint_is_accepted() -> None:
    assert ctx(route_hint="/").route_hint == "/"


def test_missing_route_hint_defaults_to_none() -> None:
    """Backward compatibility: every client shipped before this field
    existed omits it, and must keep working. None means 'unknown' — the
    server must never substitute '/' or any other guessed value."""
    context = SanitizedContext(
        task_id="t", task="do the thing", page="p", url_origin=ORIGIN, elements=[], fields={}
    )
    assert context.route_hint is None


@pytest.mark.parametrize(
    "bad",
    [
        "no-leading-slash",
        "https://evil.example.com/phish",
        "//evil.example.com/phish",
        "/has\nnewline",
        "/has\rcarriage",
        "/has\ttab",
        "",
    ],
)
def test_malformed_route_hint_is_rejected(bad) -> None:
    with pytest.raises(ValidationError):
        ctx(route_hint=bad)


def test_route_hint_over_length_bound_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ctx(route_hint="/" + "a" * 300)


def test_route_hint_at_length_bound_is_accepted() -> None:
    long_path = "/" + "a" * 199  # 200 chars total
    assert ctx(route_hint=long_path).route_hint == long_path


@pytest.mark.parametrize("bad_type", [1, 1.5, True, [], {}])
def test_invalid_route_hint_type_is_rejected(bad_type) -> None:
    with pytest.raises(ValidationError):
        ctx(route_hint=bad_type)


def test_route_hint_does_not_disturb_other_fields() -> None:
    context = ctx(route_hint="/checkout", task="place the order")
    assert context.task == "place the order"
    assert context.page == "Test page"
    assert context.url_origin == ORIGIN
    assert context.elements == []
    assert context.fields == {}
    assert context.history == []


# ======================================================================
# PROMPT — factual rendering, only-when-present
# ======================================================================


def test_prompt_renders_the_current_route() -> None:
    prompt = build_prompt(ctx(route_hint="/search"))
    assert "Current route: /search" in prompt


def test_prompt_route_line_sits_between_origin_and_task_id() -> None:
    prompt = build_prompt(ctx(route_hint="/cart"))
    origin_idx = prompt.index("Origin:")
    route_idx = prompt.index("Current route: /cart")
    task_id_idx = prompt.index("Task ID:")
    assert origin_idx < route_idx < task_id_idx


def test_prompt_is_byte_identical_when_route_hint_is_absent() -> None:
    """The whole point of only-when-present rendering: a context without
    route_hint produces exactly the prompt it produced before this field
    existed, so no existing benchmark result is invalidated."""
    without_field = build_prompt(ctx(route_hint=None))
    without_field_no_key = build_prompt(
        SanitizedContext(task_id="t-route", task="do the thing", page="Test page", url_origin=ORIGIN, elements=[], fields={})
    )
    assert without_field == without_field_no_key
    assert "Current route" not in without_field


def test_prompt_adds_no_rule_about_routes() -> None:
    """State, not guidance — mirrors test_element_availability.py's
    identical tripwire for `disabled`. If a rule referencing route_hint
    or inferring page semantics from it is ever added, it must be
    measured first; this test catches it landing without measurement."""
    prompt = build_prompt(ctx(route_hint="/checkout"))
    rules = prompt.split("Hard rules:")[1].split("Security rules")[0].lower()
    assert "route" not in rules


# ======================================================================
# HTTP — end-to-end contract, forwards and backwards
# ======================================================================


def test_endpoint_accepts_payload_with_route_hint() -> None:
    response = client.post("/reason", json=wire_payload(route_hint="/search"))
    assert response.status_code == 200


def test_endpoint_accepts_legacy_payload_without_route_hint() -> None:
    """A client that has not been updated must be unaffected."""
    response = client.post("/reason", json=wire_payload())
    assert response.status_code == 200


def test_endpoint_rejects_malformed_route_hint() -> None:
    response = client.post("/reason", json=wire_payload(route_hint="https://evil.example.com/phish"))
    assert response.status_code == 422
    assert response.json()["error"] == "invalid_request"


def test_endpoint_rejects_oversized_route_hint() -> None:
    response = client.post("/reason", json=wire_payload(route_hint="/" + "a" * 300))
    assert response.status_code == 422
    assert response.json()["error"] == "invalid_request"


def test_route_hint_does_not_leak_into_the_action_response() -> None:
    response = client.post("/reason", json=wire_payload(route_hint="/checkout"))
    assert response.status_code == 200
    assert "route_hint" not in response.json()


# ======================================================================
# /complete — deliberately unchanged, documented decision
# ======================================================================


def test_completion_prompt_does_not_render_route_hint() -> None:
    """/complete's own docstring forbids task-kind-specific rules — a
    route is exactly the kind of per-site signal that would violate its
    established minimalism, and this phase forbids the Qwen experiments
    that could measure whether it would even help. Deferred to S3."""
    from app.llm.completion_prompt import build_completion_prompt

    prompt = build_completion_prompt(ctx(route_hint="/checkout"))
    assert "route" not in prompt.lower()
