"""Element availability (`disabled`) on the sanitized-context contract.

The client already derives disabled state from the native `disabled`
property, `aria-disabled`, and `fieldset[disabled]` inheritance
(extension/src/perception/domCapture.ts) but currently drops it in
buildSanitizedContext. These tests cover the SERVER half: accepting the
field, defaulting it, and rendering it as fact in the prompt.

Scope note: `disabled` is state, not instruction. No prompt rule tells
the model what to do about a disabled control, and app/llm/validation.py
is deliberately unchanged — a model that targets a disabled element is
NOT rejected. Blocking that deterministically would be a behavioural
policy change, and it would also be unsafe to rely on: absence of the
marker means "not known to be disabled", never "known to be enabled"
(see below), so a validator built on it would refuse real actions
whenever a client under-reports.
"""

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.llm.prompt import build_prompt
from app.main import app
from app.models.context import CapturedElement, SanitizedContext

client = TestClient(app)

ORIGIN = "http://localhost:8000"


def ctx(elements: list[dict]) -> SanitizedContext:
    return SanitizedContext(
        task_id="t-availability",
        task="do the thing",
        page="Test page",
        url_origin=ORIGIN,
        elements=elements,
        fields={},
    )


def wire_payload(elements: list[dict]) -> dict:
    return {
        "task_id": "t-availability",
        "task": "do the thing",
        "page": "Test page",
        "url_origin": ORIGIN,
        "elements": elements,
        "fields": {},
    }


# ======================================================================
# MODEL — accepting and defaulting the field
# ======================================================================


def test_disabled_true_is_accepted() -> None:
    el = CapturedElement(element_id=1, role="button", label="Submit", disabled=True)
    assert el.disabled is True


def test_disabled_false_is_accepted() -> None:
    el = CapturedElement(element_id=1, role="button", label="Submit", disabled=False)
    assert el.disabled is False


def test_missing_disabled_defaults_to_false() -> None:
    """Backward compatibility: every client shipped before this field
    existed omits it, and must keep working."""
    el = CapturedElement(element_id=1, role="button", label="Submit")
    assert el.disabled is False


@pytest.mark.parametrize("bad", ["maybe", None, 2, [], {}])
def test_invalid_disabled_type_is_rejected(bad) -> None:
    """Note `None` is rejected too — the schema types this as boolean,
    not ["boolean", "null"], so an explicit null is a contract violation
    rather than a way to say "unknown". Omit the key instead."""
    with pytest.raises(ValidationError):
        CapturedElement(element_id=1, role="button", disabled=bad)


@pytest.mark.parametrize(
    "value,expected",
    [(True, True), (False, False), ("true", True), ("false", False), (1, True), (0, False)],
)
def test_documented_coercions(value, expected) -> None:
    """Pydantic's lax mode coerces these. Pinned as a characterization
    test: a future switch to strict mode would break clients sending
    "true"/1, so the change should be deliberate rather than silent.
    """
    assert CapturedElement(element_id=1, role="button", disabled=value).disabled is expected


# ======================================================================
# PROMPT — factual rendering
# ======================================================================


def test_prompt_marks_a_disabled_element() -> None:
    prompt = build_prompt(ctx([
        {"element_id": 1, "role": "button", "label": "Add to Cart", "disabled": True},
    ]))
    assert "- id=1 role=button label='Add to Cart' disabled=true" in prompt


def test_prompt_omits_the_marker_for_enabled_elements() -> None:
    """Enabled is the default and the common case; stating it on every
    line would add tokens to every prompt to express the default."""
    prompt = build_prompt(ctx([
        {"element_id": 1, "role": "button", "label": "Add to Cart", "disabled": False},
    ]))
    assert "- id=1 role=button label='Add to Cart'" in prompt
    assert "disabled" not in prompt.split("Interactive elements")[1].split("Valid element_id")[0]


def test_prompt_is_byte_identical_when_nothing_is_disabled() -> None:
    """The whole point of rendering only-when-true: a context with no
    disabled elements produces exactly the prompt it produced before this
    field existed, so the benchmark comparison isolates one variable.
    """
    elements = [
        {"element_id": 1, "role": "input:text", "label": "Name"},
        {"element_id": 2, "role": "button", "label": "Save"},
    ]
    without_field = build_prompt(ctx(elements))
    with_explicit_false = build_prompt(ctx([{**e, "disabled": False} for e in elements]))
    assert without_field == with_explicit_false


def test_prompt_marks_only_the_disabled_element_in_a_mixed_list() -> None:
    prompt = build_prompt(ctx([
        {"element_id": 1, "role": "button", "label": "128GB"},
        {"element_id": 2, "role": "button", "label": "Add to Cart", "disabled": True},
        {"element_id": 3, "role": "link", "label": "Back"},
    ]))
    assert "- id=1 role=button label='128GB'\n" in prompt
    assert "- id=2 role=button label='Add to Cart' disabled=true\n" in prompt
    assert "- id=3 role=link label='Back'\n" in prompt


def test_prompt_adds_no_rule_about_disabled_elements() -> None:
    """State, not guidance. If a rule about disabled controls ever gets
    added, it must be measured first — this test is the tripwire."""
    prompt = build_prompt(ctx([
        {"element_id": 1, "role": "button", "label": "Add to Cart", "disabled": True},
    ]))
    rules = prompt.split("Hard rules:")[1].split("Security rules")[0].lower()
    assert "disabled" not in rules, "a rule mentioning disabled was added without measurement"


# ======================================================================
# HTTP — end-to-end contract, forwards and backwards
# ======================================================================


def test_endpoint_accepts_payload_with_disabled() -> None:
    response = client.post("/reason", json=wire_payload([
        {"element_id": 1, "role": "button", "label": "Submit", "disabled": True},
    ]))
    assert response.status_code == 200


def test_endpoint_accepts_legacy_payload_without_disabled() -> None:
    """A client that has not been updated must be unaffected."""
    response = client.post("/reason", json=wire_payload([
        {"element_id": 1, "role": "button", "label": "Submit"},
    ]))
    assert response.status_code == 200


def test_endpoint_rejects_invalid_disabled_type() -> None:
    response = client.post("/reason", json=wire_payload([
        {"element_id": 1, "role": "button", "label": "Submit", "disabled": "maybe"},
    ]))
    assert response.status_code == 422
    assert response.json()["error"] == "invalid_request"


def test_disabled_does_not_leak_into_the_action_response() -> None:
    """ActionResponse is unchanged by this phase — the field is input
    only, and must not appear on the way back out."""
    response = client.post("/reason", json=wire_payload([
        {"element_id": 1, "role": "button", "label": "Submit", "disabled": True},
    ]))
    assert response.status_code == 200
    assert "disabled" not in response.json()
