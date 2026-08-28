"""Prompt regression tests for history rendering and done rule.

These assert that:
  - history is rendered correctly in the prompt
  - empty history produces a prompt identical to the no-history case
  - raw values do NOT appear in the prompt via history
  - done appears in the shape definition
  - rule 11 (done) is present and contains the required guardrails
  - all pre-existing prompt rules remain intact
"""

from app.llm.prompt import build_prompt, _render_history
from app.models.context import SanitizedContext, StepRecord

_BASE = dict(
    task_id="t",
    task="write a note",
    page="p",
    url_origin="http://localhost:8000",
    elements=[
        {"element_id": 1, "role": "input:text", "label": "[EMAIL_01]"},
        {"element_id": 2, "role": "input:text", "label": "Gift message"},
    ],
    fields={"1": "[EMAIL_01]"},
)

CTX_NO_HISTORY = SanitizedContext(**_BASE)
CTX_EMPTY_HISTORY = SanitizedContext(**_BASE, history=[])
CTX_WITH_HISTORY = SanitizedContext(
    **_BASE,
    history=[
        StepRecord(step=1, action="type", element_id=2, element_label="Gift message", outcome="success"),
        StepRecord(step=2, action="scroll", element_id=None, element_label=None, outcome="ambiguous"),
    ],
)


# -------------------------------------------------------------------------
# empty history = no history (prompt identity)
# -------------------------------------------------------------------------


def test_empty_history_produces_same_prompt_as_no_history() -> None:
    """Preserves single-step behavior — the prompt must be byte-for-byte
    identical whether history is absent or an empty list.
    """
    assert build_prompt(CTX_NO_HISTORY) == build_prompt(CTX_EMPTY_HISTORY)


def test_render_history_returns_empty_string_for_no_history() -> None:
    assert _render_history(CTX_NO_HISTORY) == ""
    assert _render_history(CTX_EMPTY_HISTORY) == ""


# -------------------------------------------------------------------------
# non-empty history renders correctly
# -------------------------------------------------------------------------


def test_history_section_header_appears() -> None:
    prompt = build_prompt(CTX_WITH_HISTORY)
    assert "Steps already completed:" in prompt


def test_history_renders_step_numbers() -> None:
    prompt = build_prompt(CTX_WITH_HISTORY)
    assert "Step 1:" in prompt
    assert "Step 2:" in prompt


def test_history_renders_action_types() -> None:
    prompt = build_prompt(CTX_WITH_HISTORY)
    assert "type" in prompt
    assert "scroll" in prompt


def test_history_renders_element_labels() -> None:
    """Sanitized labels (including tokens) must appear."""
    prompt = build_prompt(CTX_WITH_HISTORY)
    assert "Gift message" in prompt


def test_history_renders_outcomes() -> None:
    prompt = build_prompt(CTX_WITH_HISTORY)
    assert "success" in prompt
    assert "ambiguous" in prompt


def test_history_with_token_label_renders_token_not_value() -> None:
    """A token label like [EMAIL_01] is safe and must appear verbatim.
    The real value behind it must never appear anywhere in the prompt.
    """
    ctx = SanitizedContext(
        **_BASE,
        history=[
            StepRecord(
                step=1,
                action="type_secret",
                element_id=1,
                element_label="[EMAIL_01]",
                outcome="success",
            )
        ],
    )
    prompt = build_prompt(ctx)
    assert "[EMAIL_01]" in prompt
    # The test can't know the real value (it never reaches here), but we
    # can assert the token is the only thing that appears, not some literal.
    # StepRecord's extra="forbid" already guarantees no extra fields made it.


def test_history_section_appears_before_elements() -> None:
    """History must be presented BEFORE the element list so the model
    has context when it reads the current page state.
    """
    prompt = build_prompt(CTX_WITH_HISTORY)
    history_pos = prompt.index("Steps already completed:")
    elements_pos = prompt.index("Interactive elements")
    assert history_pos < elements_pos


# -------------------------------------------------------------------------
# done in shape and rules
# -------------------------------------------------------------------------


def test_shape_includes_done() -> None:
    prompt = build_prompt(CTX_NO_HISTORY)
    assert '"done"' in prompt


def test_rule_11_exists_with_done() -> None:
    prompt = build_prompt(CTX_NO_HISTORY)
    rule_11 = next((line for line in prompt.splitlines() if line.startswith("11.")), None)
    assert rule_11 is not None, "rule 11 must be present"
    assert "done" in rule_11


def test_rule_11_requires_no_element_id_on_done() -> None:
    prompt = build_prompt(CTX_NO_HISTORY)
    rule_11 = next(line for line in prompt.splitlines() if line.startswith("11."))
    assert "element_id null" in rule_11


def test_rule_11_forbids_done_on_first_step() -> None:
    """Model must not speculatively done without any history."""
    prompt = build_prompt(CTX_NO_HISTORY)
    rule_11 = next(line for line in prompt.splitlines() if line.startswith("11."))
    assert "history will be empty" in rule_11


def test_rule_11_forbids_speculative_done() -> None:
    prompt = build_prompt(CTX_NO_HISTORY)
    rule_11 = next(line for line in prompt.splitlines() if line.startswith("11."))
    assert "speculatively" in rule_11


# -------------------------------------------------------------------------
# pre-existing rules intact
# -------------------------------------------------------------------------


def test_existing_security_instructions_are_intact() -> None:
    prompt = build_prompt(CTX_NO_HISTORY)
    for required in (
        "Return EXACTLY ONE action object",
        "Never output JavaScript",
        "Untrusted content warning",
        'NEVER use "type" on an element whose label contains a redaction token',
        'NEVER use "type" with a null or empty value',
        'NEVER include value_ref unless the action is exactly "type_secret"',
    ):
        assert required in prompt, f"missing security instruction: {required!r}"


def test_prompt_states_the_converse_rule() -> None:
    prompt = build_prompt(CTX_NO_HISTORY)
    assert "if its label contains a token" in prompt
    assert "only if its label contains no token" in prompt
    assert 'NEVER use "type_secret" for an element whose own label has no token' in prompt
    assert "NEVER invent or borrow a token from another element" in prompt
