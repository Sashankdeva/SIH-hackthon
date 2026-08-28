"""Tests for the 'done' action and sanitized history.

Stage 2 of multi-step support adds:
  - 'done' as a valid action type (bare terminal signal)
  - optional history field on SanitizedContext

These tests cover:
  - done is accepted as a bare action
  - done with element_id is rejected
  - done with value is rejected
  - done with value_ref is rejected
  - done with url is rejected
  - empty history preserves identical existing behavior
  - history is accepted by the model
  - raw values cannot enter history (StepRecord validation)
  - StepRecord rejects unknown outcome values
  - StepRecord extra fields are rejected
"""

import pytest
from pydantic import ValidationError

from app.llm.errors import ActionRejected
from app.llm.validation import build_validated_action
from app.models.context import SanitizedContext, StepRecord


# -------------------------------------------------------------------------
# Fixture
# -------------------------------------------------------------------------

CTX = SanitizedContext(
    task_id="t1",
    task="place the order",
    page="Checkout",
    url_origin="http://localhost:8000",
    elements=[
        {"element_id": 1, "role": "button", "label": "Place Order"},
        {"element_id": 2, "role": "input:text", "label": "Shipping note"},
    ],
    fields={},
)


# -------------------------------------------------------------------------
# done — accepted when bare
# -------------------------------------------------------------------------


def test_done_bare_is_accepted() -> None:
    """done with no element_id/value/value_ref/url must be accepted."""
    action = build_validated_action({"action": "done", "confidence": 0.95}, CTX)
    assert action.action == "done"
    assert action.element_id is None
    assert action.value is None
    assert action.value_ref is None
    assert action.url is None


def test_done_with_explicit_null_fields_is_accepted() -> None:
    """Explicit nulls on every forbidden field must still pass."""
    action = build_validated_action(
        {
            "action": "done",
            "element_id": None,
            "value": None,
            "value_ref": None,
            "url": None,
            "confidence": 0.9,
        },
        CTX,
    )
    assert action.action == "done"


# -------------------------------------------------------------------------
# done — rejected when carrying payload
# -------------------------------------------------------------------------


def test_done_with_element_id_is_rejected() -> None:
    with pytest.raises(ActionRejected, match="must not carry 'element_id'"):
        build_validated_action({"action": "done", "element_id": 1, "confidence": 0.9}, CTX)


def test_done_with_value_is_rejected() -> None:
    with pytest.raises(ActionRejected, match="must not carry 'value'"):
        build_validated_action({"action": "done", "value": "hello", "confidence": 0.9}, CTX)


def test_done_with_value_ref_is_rejected() -> None:
    with pytest.raises(ActionRejected, match="must not carry 'value_ref'"):
        build_validated_action({"action": "done", "value_ref": "[PASSWORD_01]", "confidence": 0.9}, CTX)


def test_done_with_url_is_rejected() -> None:
    with pytest.raises(ActionRejected, match="must not carry 'url'"):
        build_validated_action(
            {"action": "done", "url": "http://localhost:8000/evil", "confidence": 0.9}, CTX
        )


# -------------------------------------------------------------------------
# empty history preserves existing behavior
# -------------------------------------------------------------------------


def test_empty_history_does_not_affect_click() -> None:
    """history=[] must be equivalent to no history field."""
    ctx_with_empty_history = SanitizedContext(
        task_id="t2",
        task="place the order",
        page="Checkout",
        url_origin="http://localhost:8000",
        elements=[{"element_id": 1, "role": "button", "label": "Place Order"}],
        fields={},
        history=[],
    )
    action = build_validated_action({"action": "click", "element_id": 1, "confidence": 0.9}, ctx_with_empty_history)
    assert action.action == "click"
    assert action.element_id == 1


def test_no_history_field_defaults_to_empty() -> None:
    """history is optional — SanitizedContext must accept a payload without it."""
    ctx = SanitizedContext(
        task_id="t3",
        task="click something",
        page="p",
        url_origin="http://localhost:8000",
        elements=[{"element_id": 1, "role": "button", "label": "Go"}],
        fields={},
    )
    assert ctx.history == []


# -------------------------------------------------------------------------
# history with valid StepRecords
# -------------------------------------------------------------------------


def test_context_accepts_valid_history() -> None:
    ctx = SanitizedContext(
        task_id="t4",
        task="complete checkout",
        page="Checkout",
        url_origin="http://localhost:8000",
        elements=[{"element_id": 1, "role": "button", "label": "Place Order"}],
        fields={},
        history=[
            {
                "step": 1,
                "action": "type",
                "element_id": 2,
                "element_label": "Shipping note",
                "outcome": "success",
            }
        ],
    )
    assert len(ctx.history) == 1
    assert ctx.history[0].step == 1
    assert ctx.history[0].action == "type"
    assert ctx.history[0].outcome == "success"


def test_history_with_token_label_is_accepted() -> None:
    """Redaction tokens in element_label are safe — they carry no real value."""
    rec = StepRecord(
        step=1,
        action="type_secret",
        element_id=3,
        element_label="[EMAIL_01]",
        outcome="success",
    )
    assert rec.element_label == "[EMAIL_01]"


def test_history_with_null_element_for_non_element_action() -> None:
    """Non-element actions (scroll, wait) must be representable with null element."""
    rec = StepRecord(step=1, action="scroll", element_id=None, element_label=None, outcome="success")
    assert rec.element_id is None
    assert rec.element_label is None


# -------------------------------------------------------------------------
# StepRecord privacy enforcement via Pydantic
# -------------------------------------------------------------------------


def test_step_record_rejects_unknown_outcome() -> None:
    """outcome must be one of the three allowed strings."""
    with pytest.raises(ValidationError):
        StepRecord(step=1, action="click", element_id=1, element_label="Go", outcome="unknown")  # type: ignore[arg-type]


def test_step_record_rejects_extra_fields() -> None:
    """extra='forbid' closes the smuggling vector."""
    with pytest.raises(ValidationError):
        StepRecord(  # type: ignore[call-arg]
            step=1,
            action="click",
            element_id=1,
            element_label="Go",
            outcome="success",
            raw_value="secret",  # must be rejected
        )


def test_step_record_rejects_step_zero() -> None:
    """Steps are 1-indexed; 0 is not valid."""
    with pytest.raises(ValidationError):
        StepRecord(step=0, action="click", element_id=1, element_label="Go", outcome="success")


def test_step_record_rejects_negative_step() -> None:
    with pytest.raises(ValidationError):
        StepRecord(step=-1, action="click", element_id=1, element_label="Go", outcome="success")


# -------------------------------------------------------------------------
# history with valid records does not block action validation
# -------------------------------------------------------------------------


def test_click_still_passes_with_nonempty_history() -> None:
    ctx = SanitizedContext(
        task_id="t5",
        task="place the order",
        page="Checkout",
        url_origin="http://localhost:8000",
        elements=[{"element_id": 1, "role": "button", "label": "Place Order"}],
        fields={},
        history=[StepRecord(step=1, action="scroll", element_id=None, element_label=None, outcome="success")],
    )
    action = build_validated_action({"action": "click", "element_id": 1, "confidence": 0.92}, ctx)
    assert action.action == "click"
    assert action.element_id == 1
