"""Deterministic validation layer — the actual security boundary.

These exercise app.llm.validation directly. Nothing here depends on a
model: the point is that these rules hold regardless of what the model
says, because the prompt is a request and page content is attacker-
influenced.

Contract note: validation REFUSES by raising ActionRejected. It never
returns a substitute action. An earlier revision answered every failure
with a fabricated `wait`, which made "the model chose to do nothing"
indistinguishable from "validation caught an attack".
"""

import pytest

from app.llm.errors import ActionRejected
from app.llm.validation import build_validated_action
from app.models.context import SanitizedContext

# --------------------------------------------------------------------
# SUCCESS: every action type the schema allows
# --------------------------------------------------------------------


def test_valid_click(checkout_context: SanitizedContext) -> None:
    action = build_validated_action(
        {"action": "click", "element_id": 6, "confidence": 0.95}, checkout_context
    )
    assert action.action == "click"
    assert action.element_id == 6
    assert action.task_id == checkout_context.task_id


def test_valid_type(checkout_context: SanitizedContext) -> None:
    action = build_validated_action(
        {"action": "type", "element_id": 5, "value": "leave at door", "confidence": 0.8},
        checkout_context,
    )
    assert action.action == "type"
    assert action.value == "leave at door"


def test_valid_scroll_keeps_parameters(checkout_context: SanitizedContext) -> None:
    action = build_validated_action(
        {"action": "scroll", "direction": "down", "amount": 600, "confidence": 0.8}, checkout_context
    )
    assert (action.action, action.direction, action.amount) == ("scroll", "down", 600)


def test_valid_type_secret(checkout_context: SanitizedContext) -> None:
    action = build_validated_action(
        {"action": "type_secret", "element_id": 4, "value_ref": "[PASSWORD_01]", "confidence": 0.9},
        checkout_context,
    )
    assert action.action == "type_secret"
    assert action.element_id == 4
    assert action.value is None, "the real secret must never appear in the response"


def test_valid_type_secret_on_non_password_field(checkout_context: SanitizedContext) -> None:
    """Local fill is not password-only: name/email/address resolve in the
    extension too, and the server never sees any of those values either.
    """
    action = build_validated_action(
        {"action": "type_secret", "element_id": 3, "value_ref": "[EMAIL_01]", "confidence": 0.9},
        checkout_context,
    )
    assert action.element_id == 3


def test_valid_navigation_same_origin(checkout_context: SanitizedContext) -> None:
    action = build_validated_action(
        {"action": "navigate", "url": "http://localhost:8000/cart", "confidence": 0.8},
        checkout_context,
    )
    assert action.url == "http://localhost:8000/cart"


def test_valid_wait(checkout_context: SanitizedContext) -> None:
    action = build_validated_action(
        {"action": "wait", "amount": 500, "confidence": 0.0}, checkout_context
    )
    assert action.action == "wait"


# --------------------------------------------------------------------
# SECURITY
# --------------------------------------------------------------------


def test_rejects_invented_element_id(checkout_context: SanitizedContext) -> None:
    """The model may only target elements the CLIENT supplied."""
    with pytest.raises(ActionRejected, match="not supplied in the context"):
        build_validated_action({"action": "click", "element_id": 999, "confidence": 0.9}, checkout_context)


def test_rejects_element_action_without_target(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="requires an element_id"):
        build_validated_action({"action": "click", "element_id": None, "confidence": 0.9}, checkout_context)


def test_rejects_raw_card_like_value(checkout_context: SanitizedContext) -> None:
    """A long digit run is card/phone/ID-shaped; refuse to type it."""
    with pytest.raises(ActionRejected, match="long digit sequence"):
        build_validated_action(
            {"action": "type", "element_id": 5, "value": "4242424242424242", "confidence": 0.9},
            checkout_context,
        )


def test_rejects_raw_pii_in_value(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="raw email"):
        build_validated_action(
            {"action": "type", "element_id": 5, "value": "victim@example.com", "confidence": 0.9},
            checkout_context,
        )


def test_rejects_token_misuse_in_value(checkout_context: SanitizedContext) -> None:
    """Putting the token in `value` would type the literal text
    "[EMAIL_01]" into a real form field.
    """
    with pytest.raises(ActionRejected, match="redaction token"):
        build_validated_action(
            {"action": "type", "element_id": 5, "value": "[EMAIL_01]", "confidence": 0.9},
            checkout_context,
        )


def test_rejects_secret_field_mismatch(checkout_context: SanitizedContext) -> None:
    """element_id=3 is the EMAIL field; the token is the PASSWORD's.
    Each half is individually valid — together they mean "type the
    password into the email box" and submit it in the clear.
    """
    with pytest.raises(ActionRejected, match="does not belong to element"):
        build_validated_action(
            {"action": "type_secret", "element_id": 3, "value_ref": "[PASSWORD_01]", "confidence": 0.9},
            checkout_context,
        )


def test_rejects_type_secret_on_unredacted_field(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected):
        build_validated_action(
            {"action": "type_secret", "element_id": 5, "value_ref": "Shipping note", "confidence": 0.9},
            checkout_context,
        )


def test_rejects_off_origin_navigation(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="leaves origin"):
        build_validated_action(
            {"action": "navigate", "url": "https://evil.example.com", "confidence": 0.9}, checkout_context
        )


def test_rejects_javascript_url(checkout_context: SanitizedContext) -> None:
    """The extension performs navigate as `location.href = url`, so a
    javascript: URL is script execution, not navigation.
    """
    with pytest.raises(ActionRejected, match="http/https"):
        build_validated_action(
            {"action": "navigate", "url": "javascript:alert(document.cookie)", "confidence": 0.9},
            checkout_context,
        )


def test_rejects_navigate_without_url(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="requires a url"):
        build_validated_action({"action": "navigate", "url": None, "confidence": 0.9}, checkout_context)


def test_rejects_arbitrary_javascript_in_value(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="code-like"):
        build_validated_action(
            {
                "action": "type",
                "element_id": 5,
                "value": "<script>fetch('//evil')</script>",
                "confidence": 0.9,
            },
            checkout_context,
        )


def test_rejects_unexpected_fields(checkout_context: SanitizedContext) -> None:
    """Extra keys mean the output isn't the shape we asked for. Silently
    dropping them (the old behaviour) hides model drift, and would hide a
    smuggled instruction.
    """
    with pytest.raises(ActionRejected, match="unexpected field"):
        build_validated_action(
            {"action": "click", "element_id": 6, "confidence": 0.9, "execute_js": "alert(1)"},
            checkout_context,
        )


def test_rejects_disallowed_action_type(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="disallowed action"):
        build_validated_action({"action": "eval_javascript", "confidence": 0.9}, checkout_context)


def test_rejects_out_of_range_confidence(checkout_context: SanitizedContext) -> None:
    """Pydantic's own schema check is the final gate."""
    with pytest.raises(ActionRejected, match="schema validation"):
        build_validated_action({"action": "click", "element_id": 6, "confidence": 5.0}, checkout_context)


def test_rejects_non_numeric_confidence(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="not a number"):
        build_validated_action(
            {"action": "click", "element_id": 6, "confidence": "very sure"}, checkout_context
        )


# --------------------------------------------------------------------
# REGRESSION: the T7 family, found by the reasoning evaluation.
#
# Asked to "enter my email", the model answered
#   {"action":"type","element_id":<email field>,"value":null,
#    "value_ref":"[EMAIL_01]"}
# on 3/3 runs, and validation ACCEPTED it. The extension executes `type`
# as `el.value = req.value ?? ""`, so a request to FILL the field would
# have CLEARED it. Each defect below is refused independently, so the
# guarantee holds even if the prompt regresses.
# --------------------------------------------------------------------


def test_A_rejects_type_on_redacted_field_with_null_value(checkout_context: SanitizedContext) -> None:
    """The exact output the live model produced."""
    with pytest.raises(ActionRejected, match="redaction token"):
        build_validated_action(
            {"action": "type", "element_id": 3, "value": None, "value_ref": "[EMAIL_01]", "confidence": 1.0},
            checkout_context,
        )


def test_B_rejects_type_on_redacted_field_with_empty_value(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="redaction token"):
        build_validated_action(
            {"action": "type", "element_id": 3, "value": "", "confidence": 0.9}, checkout_context
        )


def test_C_rejects_type_on_normal_element_with_null_value(checkout_context: SanitizedContext) -> None:
    """Element 5 is an ordinary field — clearing it is still destructive."""
    with pytest.raises(ActionRejected, match="non-empty value"):
        build_validated_action(
            {"action": "type", "element_id": 5, "value": None, "confidence": 0.9}, checkout_context
        )


def test_D_rejects_type_on_normal_element_with_empty_value(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="non-empty value"):
        build_validated_action(
            {"action": "type", "element_id": 5, "value": "   ", "confidence": 0.9}, checkout_context
        )


def test_E_rejects_value_ref_on_type(checkout_context: SanitizedContext) -> None:
    """value_ref on `type` means the model conflated it with type_secret."""
    with pytest.raises(ActionRejected, match="only valid for type_secret"):
        build_validated_action(
            {"action": "type", "element_id": 5, "value": "hello", "value_ref": "[EMAIL_01]", "confidence": 0.9},
            checkout_context,
        )


def test_F_rejects_value_ref_on_click(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="only valid for type_secret"):
        build_validated_action(
            {"action": "click", "element_id": 6, "value_ref": "[EMAIL_01]", "confidence": 0.9},
            checkout_context,
        )


def test_F2_rejects_value_ref_on_scroll_and_navigate(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="only valid for type_secret"):
        build_validated_action(
            {"action": "scroll", "direction": "down", "value_ref": "[EMAIL_01]", "confidence": 0.9},
            checkout_context,
        )
    with pytest.raises(ActionRejected, match="only valid for type_secret"):
        build_validated_action(
            {
                "action": "navigate",
                "url": "http://localhost:8000/x",
                "value_ref": "[EMAIL_01]",
                "confidence": 0.9,
            },
            checkout_context,
        )


def test_G_valid_type_with_real_value_still_passes(checkout_context: SanitizedContext) -> None:
    action = build_validated_action(
        {"action": "type", "element_id": 5, "value": "leave at reception", "confidence": 0.9},
        checkout_context,
    )
    assert action.action == "type"
    assert action.value == "leave at reception"
    assert action.value_ref is None


def test_H_valid_type_secret_still_passes(checkout_context: SanitizedContext) -> None:
    action = build_validated_action(
        {"action": "type_secret", "element_id": 4, "value_ref": "[PASSWORD_01]", "confidence": 0.9},
        checkout_context,
    )
    assert action.action == "type_secret"
    assert action.value_ref == "[PASSWORD_01]"
    assert action.value is None


def test_I_valid_click_without_value_ref_still_passes(checkout_context: SanitizedContext) -> None:
    action = build_validated_action(
        {"action": "click", "element_id": 6, "confidence": 0.95}, checkout_context
    )
    assert action.action == "click"
    assert action.value_ref is None


def test_redacted_detection_handles_embedded_token(checkout_context: SanitizedContext) -> None:
    """A label like "Email [EMAIL_01]" is still a redacted field —
    matching on `search` rather than the whole label closes the gap where
    a decorated label would be treated as ordinary and cleared.
    """
    ctx = SanitizedContext(
        task_id="t",
        task="enter my email",
        page="p",
        url_origin="http://localhost:8000",
        elements=[{"element_id": 1, "role": "input:email", "label": "Email [EMAIL_01]"}],
        fields={"1": "Email [EMAIL_01]"},
    )
    with pytest.raises(ActionRejected, match="redaction token"):
        build_validated_action({"action": "type", "element_id": 1, "value": "x", "confidence": 0.9}, ctx)


# --------------------------------------------------------------------
# REGRESSION: the C3/H3 family, found by the 32-case benchmark.
#
# Asked to write plain text into an ORDINARY field sitting among
# token-labelled ones, the model reached for type_secret and supplied a
# token that did not belong to the target:
#   C3  value_ref="[DELIVERY_NOTE]"  (invented — exists nowhere)
#   H3  value_ref="[PASSWORD_01]"    (borrowed from another element)
# H3 is the dangerous one: had it been accepted, the extension would
# have typed the user's password into a gift-message field, which such
# sites display or email onward.
# --------------------------------------------------------------------


def test_rejects_type_secret_on_ordinary_field_with_borrowed_token(
    checkout_context: SanitizedContext,
) -> None:
    """H3 exactly: an ordinary element, wearing another element's token."""
    with pytest.raises(ActionRejected, match="does not belong to element"):
        build_validated_action(
            {"action": "type_secret", "element_id": 5, "value_ref": "[PASSWORD_01]", "confidence": 0.9},
            checkout_context,
        )


def test_rejects_type_secret_on_ordinary_field_with_invented_token(
    checkout_context: SanitizedContext,
) -> None:
    """C3 exactly: a token that exists nowhere in the context."""
    with pytest.raises(ActionRejected, match="does not belong to element"):
        build_validated_action(
            {"action": "type_secret", "element_id": 5, "value_ref": "[DELIVERY_NOTE]", "confidence": 0.9},
            checkout_context,
        )


def test_rejects_type_secret_with_invented_token_on_redacted_field(
    checkout_context: SanitizedContext,
) -> None:
    """A token may only be used with the element whose label carries it —
    even when the target really is a redacted field.
    """
    with pytest.raises(ActionRejected, match="does not belong to element"):
        build_validated_action(
            {"action": "type_secret", "element_id": 3, "value_ref": "[INVENTED_99]", "confidence": 0.9},
            checkout_context,
        )


def test_ordinary_field_accepts_plain_type(checkout_context: SanitizedContext) -> None:
    """The positive half of rule 10 — element 5 is not token-labelled."""
    action = build_validated_action(
        {"action": "type", "element_id": 5, "value": "happy birthday", "confidence": 0.9},
        checkout_context,
    )
    assert (action.action, action.element_id, action.value) == ("type", 5, "happy birthday")
    assert action.value_ref is None
