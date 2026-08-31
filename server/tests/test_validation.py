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
# S1 CLEANUP — `value` is only meaningful for `type`; every other
# action's `value` is inert at execution time and must be rejected
# rather than silently accepted. Found live: the model emitted
# {"action":"click","element_id":<search box>,"value":"Samsung S24 FE"}
# meaning to type a search query — "click" ignored the value entirely
# and nothing signalled the mismatch. `keypress` is deliberately NOT
# included here — the extension's executor reads the key to press from
# `value` itself (`req.value ?? "Enter"`), so a value there is genuine,
# existing, intended behavior, not a stray field.
# --------------------------------------------------------------------


def test_click_with_value_rejected(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="value is only valid for 'type'"):
        build_validated_action(
            {"action": "click", "element_id": 6, "value": "Samsung S24 FE", "confidence": 0.95},
            checkout_context,
        )


def test_scroll_with_value_rejected(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="value is only valid for 'type'"):
        build_validated_action(
            {"action": "scroll", "direction": "down", "value": "down", "confidence": 0.8},
            checkout_context,
        )


def test_navigate_with_value_rejected(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="value is only valid for 'type'"):
        build_validated_action(
            {
                "action": "navigate",
                "url": "http://localhost:8000/cart",
                "value": "cart",
                "confidence": 0.8,
            },
            checkout_context,
        )


def test_wait_with_value_rejected(checkout_context: SanitizedContext) -> None:
    with pytest.raises(ActionRejected, match="value is only valid for 'type'"):
        build_validated_action(
            {"action": "wait", "amount": 500, "value": "500ms", "confidence": 0.0}, checkout_context
        )


def test_keypress_with_value_still_accepted(checkout_context: SanitizedContext) -> None:
    """Deliberately NOT rejected — see this block's own docstring above.
    Locks in that this cleanup did not regress keypress's real,
    already-wired contract (extension/src/action/executor.ts reads the
    key to press from `value`).
    """
    action = build_validated_action(
        {"action": "keypress", "value": "Enter", "confidence": 0.9}, checkout_context
    )
    assert action.action == "keypress"
    assert action.value == "Enter"


def test_valid_type_with_value_still_accepted(checkout_context: SanitizedContext) -> None:
    """Regression guard: `type` is the one action this cleanup must
    leave completely untouched.
    """
    action = build_validated_action(
        {"action": "type", "element_id": 5, "value": "leave at door", "confidence": 0.8},
        checkout_context,
    )
    assert action.action == "type"
    assert action.value == "leave at door"


def test_valid_type_secret_semantics_unchanged(checkout_context: SanitizedContext) -> None:
    """Regression guard: type_secret's own value_ref-only contract
    (already enforced before this cleanup) must still hold, and this
    cleanup's new check must not fire for it (type_secret rejects value
    via its own dedicated, pre-existing check, not the new generic one).
    """
    action = build_validated_action(
        {"action": "type_secret", "element_id": 4, "value_ref": "[PASSWORD_01]", "confidence": 0.9},
        checkout_context,
    )
    assert action.action == "type_secret"
    assert action.value is None
    assert action.value_ref == "[PASSWORD_01]"

    with pytest.raises(ActionRejected, match="must not carry a literal value"):
        build_validated_action(
            {
                "action": "type_secret",
                "element_id": 4,
                "value": "hunter2",
                "value_ref": "[PASSWORD_01]",
                "confidence": 0.9,
            },
            checkout_context,
        )


def test_valid_click_without_value_still_accepted(checkout_context: SanitizedContext) -> None:
    action = build_validated_action(
        {"action": "click", "element_id": 6, "confidence": 0.95}, checkout_context
    )
    assert action.action == "click"
    assert action.value is None


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


# ======================================================================
# SERVER PHASE S3.1 — click+value rejection against the REAL role
# vocabulary.
#
# The existing test_click_with_value_rejected (above) only ever used
# this suite's fictional "input:text"/"input:email"/etc. role strings —
# never the ARIA-style values the real client actually sends
# (extension/src/perception/domCapture.ts's roleFor(): "textbox" for
# every non-button/checkbox/radio input AND textarea, "combobox" for
# <select>, an explicit page-set role such as "searchbox"/"spinbutton"
# verbatim, "button", "link"). A role-scoped rejection rule was tried
# this phase and found to be a no-op — VALUE_IRRELEVANT_ACTIONS (see its
# comment) already rejects click+value for EVERY role — but that finding
# was only trustworthy once tested against roles that actually occur in
# production. These cases close that real coverage gap.
# ======================================================================


def _role_ctx(elements: list[dict]) -> SanitizedContext:
    return SanitizedContext(
        task_id="t-s3.1", task="search for wireless earbuds", page="Search results",
        url_origin="http://localhost:8000", elements=elements, fields={},
    )


@pytest.mark.parametrize("role", ["textbox", "searchbox", "combobox", "spinbutton", "button", "link"])
def test_click_with_value_rejected_for_every_real_role(role: str) -> None:
    ctx = _role_ctx([{"element_id": 1, "role": role, "label": "Search"}])
    with pytest.raises(ActionRejected, match="value is only valid for 'type'"):
        build_validated_action(
            {"action": "click", "element_id": 1, "value": "wireless earbuds", "confidence": 1.0}, ctx
        )


def test_click_without_value_on_textbox_unaffected() -> None:
    """Ordinary click, no value — must remain completely unaffected."""
    ctx = _role_ctx([{"element_id": 1, "role": "textbox", "label": "Search"}])
    action = build_validated_action({"action": "click", "element_id": 1, "confidence": 1.0}, ctx)
    assert action.action == "click"
    assert action.element_id == 1


def test_type_on_textbox_still_accepted() -> None:
    """The legitimate, correct action a search-box click+value is
    confused with — must be completely unaffected."""
    ctx = _role_ctx([{"element_id": 1, "role": "textbox", "label": "Search"}])
    action = build_validated_action(
        {"action": "type", "element_id": 1, "value": "wireless earbuds", "confidence": 1.0}, ctx
    )
    assert (action.action, action.value) == ("type", "wireless earbuds")


def test_type_secret_on_textbox_still_accepted() -> None:
    ctx = _role_ctx([{"element_id": 1, "role": "textbox", "label": "[PASSWORD_01]"}])
    action = build_validated_action(
        {"action": "type_secret", "element_id": 1, "value_ref": "[PASSWORD_01]", "confidence": 1.0}, ctx
    )
    assert action.action == "type_secret"


def test_scroll_unaffected_on_textbox_role() -> None:
    ctx = _role_ctx([{"element_id": 1, "role": "textbox", "label": "Search"}])
    action = build_validated_action(
        {"action": "scroll", "direction": "down", "confidence": 1.0}, ctx
    )
    assert action.action == "scroll"


def test_navigate_unaffected_on_textbox_role() -> None:
    ctx = _role_ctx([{"element_id": 1, "role": "textbox", "label": "Search"}])
    action = build_validated_action(
        {"action": "navigate", "url": "http://localhost:8000/next", "confidence": 1.0}, ctx
    )
    assert action.action == "navigate"


def test_keypress_with_value_unaffected_on_textbox_role() -> None:
    """keypress + value remains valid regardless of target role."""
    ctx = _role_ctx([{"element_id": 1, "role": "textbox", "label": "Search"}])
    action = build_validated_action(
        {"action": "keypress", "element_id": 1, "value": "Enter", "confidence": 1.0}, ctx
    )
    assert (action.action, action.value) == ("keypress", "Enter")


# ======================================================================
# SERVER PHASE S4 — "type"/"type_secret" on a never-fillable role.
#
# Confirmed live in extension/src/action/executor.ts's
# injectTextIntoElement: a <button>/<a> is a true no-op, but role
# "button" ALSO covers <input type="submit"|"button"|"reset"> (see
# domCapture.ts's roleFor()) — which IS an HTMLInputElement, so `type`
# would silently overwrite that element's `.value`, which for a
# submit/button input IS its visible label text. Not a security hole,
# but a genuine unintended, observable side effect, and exactly the
# "semantically unsafe model response" this validator exists to catch.
# ======================================================================


@pytest.mark.parametrize("role", ["button", "link", "checkbox", "radio"])
def test_type_on_never_fillable_role_rejected(role: str) -> None:
    ctx = _role_ctx([{"element_id": 1, "role": role, "label": "Go"}])
    with pytest.raises(ActionRejected, match="can never be a text-entry target"):
        build_validated_action(
            {"action": "type", "element_id": 1, "value": "hello", "confidence": 1.0}, ctx
        )


@pytest.mark.parametrize("role", ["button", "link", "checkbox", "radio"])
def test_type_secret_on_never_fillable_role_rejected(role: str) -> None:
    ctx = _role_ctx([{"element_id": 1, "role": role, "label": "[EMAIL_01]"}])
    with pytest.raises(ActionRejected, match="can never be a text-entry target"):
        build_validated_action(
            {"action": "type_secret", "element_id": 1, "value_ref": "[EMAIL_01]", "confidence": 1.0}, ctx
        )


def test_type_still_accepted_on_combobox_role() -> None:
    """Deliberately NOT rejected — "combobox"/"searchbox"/"spinbutton"
    are excluded from the denylist on purpose (see NEVER_FILLABLE_ROLES'
    own comment): they can be page-author-set ARIA values whose real
    DOM fillability role alone can't rule out, and a false rejection is
    worse than the narrow gap this check closes."""
    ctx = _role_ctx([{"element_id": 1, "role": "combobox", "label": "Country"}])
    action = build_validated_action(
        {"action": "type", "element_id": 1, "value": "Canada", "confidence": 1.0}, ctx
    )
    assert action.action == "type"


# ======================================================================
# SERVER PHASE S4 — `amount` bounds (scroll pixels / wait milliseconds).
#
# ActionResponse.amount has no Pydantic Field bound, so without this
# check a negative, NaN, or infinite amount reached the client
# unrejected, relying entirely on the extension's OWN clamp
# (`Math.min(amount ?? 1000, 5000)` for wait; nothing at all for
# scroll, which relies on the browser's internal scroll-bounds
# clamping). This project's standing rule is that every field is
# independently re-verified server-side, not left to whatever the
# client currently happens to do with it.
# ======================================================================


def test_wait_with_negative_amount_rejected() -> None:
    ctx = _role_ctx([])
    with pytest.raises(ActionRejected, match="must not be negative"):
        build_validated_action({"action": "wait", "amount": -500, "confidence": 1.0}, ctx)


def test_scroll_with_negative_amount_rejected() -> None:
    ctx = _role_ctx([])
    with pytest.raises(ActionRejected, match="must not be negative"):
        build_validated_action(
            {"action": "scroll", "direction": "down", "amount": -200, "confidence": 1.0}, ctx
        )


def test_wait_with_infinite_amount_rejected() -> None:
    ctx = _role_ctx([])
    with pytest.raises(ActionRejected, match="must be a finite number"):
        build_validated_action({"action": "wait", "amount": float("inf"), "confidence": 1.0}, ctx)


def test_wait_with_nan_amount_rejected() -> None:
    ctx = _role_ctx([])
    with pytest.raises(ActionRejected, match="must be a finite number"):
        build_validated_action({"action": "wait", "amount": float("nan"), "confidence": 1.0}, ctx)


def test_wait_with_non_numeric_amount_rejected() -> None:
    ctx = _role_ctx([])
    with pytest.raises(ActionRejected, match="amount must be a number"):
        build_validated_action({"action": "wait", "amount": "500", "confidence": 1.0}, ctx)


def test_wait_with_zero_amount_still_accepted() -> None:
    """Boundary: zero is a valid, meaningful amount (wait no time /
    scroll no distance) — must not be swept up by the negative check."""
    ctx = _role_ctx([])
    action = build_validated_action({"action": "wait", "amount": 0, "confidence": 1.0}, ctx)
    assert action.amount == 0


def test_scroll_with_large_but_finite_amount_still_accepted() -> None:
    """A large amount is not inherently invalid — only non-finite or
    negative values are; an unusually large but real pixel count must
    still pass through to the client's own scroll-bounds clamping."""
    ctx = _role_ctx([])
    action = build_validated_action(
        {"action": "scroll", "direction": "down", "amount": 999_999, "confidence": 1.0}, ctx
    )
    assert action.amount == 999_999


# ======================================================================
# SERVER PHASE S4 — task/step integrity: the model cannot control
# task_id or step_id. Both are entirely absent from
# ALLOWED_RESPONSE_KEYS, so either one being present at all is already
# caught by validate_response_keys — these tests lock that behavior in
# explicitly rather than leaving it as an implicit side effect.
# ======================================================================


def test_model_supplied_task_id_rejected() -> None:
    ctx = _role_ctx([{"element_id": 1, "role": "button", "label": "Go"}])
    with pytest.raises(ActionRejected, match="unexpected field"):
        build_validated_action(
            {"action": "click", "element_id": 1, "task_id": "attacker-supplied", "confidence": 1.0}, ctx
        )


def test_model_supplied_step_id_rejected() -> None:
    ctx = _role_ctx([{"element_id": 1, "role": "button", "label": "Go"}])
    with pytest.raises(ActionRejected, match="unexpected field"):
        build_validated_action(
            {"action": "click", "element_id": 1, "step_id": 999, "confidence": 1.0}, ctx
        )


def test_task_id_and_step_id_always_derived_from_request_not_model() -> None:
    """Positive half: task_id comes from the context the CLIENT sent;
    step_id is always history length + 1, regardless of anything the
    model could ever claim (it has no field to claim it through)."""
    ctx = SanitizedContext(
        task_id="client-assigned-id", task="do the thing", page="p",
        url_origin="http://localhost:8000",
        elements=[{"element_id": 1, "role": "button", "label": "Go"}], fields={},
        history=[
            {"step": 1, "action": "click", "element_id": 1, "element_label": "Go", "outcome": "success"}
        ],
    )
    action = build_validated_action({"action": "click", "element_id": 1, "confidence": 1.0}, ctx)
    assert action.task_id == "client-assigned-id"
    assert action.step_id == 2
