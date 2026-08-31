"""SERVER PHASE S2 — reasoning context quality.

Deterministic tests for the server-side CONTEXT RENDERING layer
(app/llm/prompt.py, app/llm/completion_prompt.py) — no live model calls,
matching every other rendering test in this suite. Covers the concrete
defect found and fixed this phase (history rendered in array order
rather than chronological/step order) plus canary coverage for the
audit's other correctness/size checks that had no prior dedicated test.
"""

from app.llm.completion_prompt import build_completion_prompt
from app.llm.prompt import build_prompt
from app.models.context import CapturedElement, SanitizedContext, StepRecord

ORIGIN = "http://localhost:8000"


def _ctx(elements=None, history=None, fields=None, page="Checkout") -> SanitizedContext:
    return SanitizedContext(
        task_id="t",
        task="place the order",
        page=page,
        url_origin=ORIGIN,
        elements=elements or [],
        fields=fields or {},
        history=history or [],
    )


# ---------------------------------------------------------------------
# History ordering — the concrete defect this phase fixed
# ---------------------------------------------------------------------


def test_reason_prompt_renders_history_in_step_order_not_array_order() -> None:
    """A hand-built OUT-OF-ORDER history (3, 1, 2) must render as 1, 2, 3.
    Nothing in SanitizedContext/StepRecord enforces the client sends
    history pre-sorted — the renderer must not trust array position.
    """
    ctx = _ctx(
        history=[
            StepRecord(step=3, action="click", element_id=3, element_label="Third", outcome="success"),
            StepRecord(step=1, action="click", element_id=1, element_label="First", outcome="failure"),
            StepRecord(step=2, action="type", element_id=2, element_label="Second", outcome="ambiguous"),
        ]
    )
    prompt = build_prompt(ctx)
    history_section = prompt.split("Steps already completed:")[1].split("Interactive elements")[0]
    first_pos = history_section.index("Step 1:")
    second_pos = history_section.index("Step 2:")
    third_pos = history_section.index("Step 3:")
    assert first_pos < second_pos < third_pos


def test_complete_prompt_renders_history_in_step_order_not_array_order() -> None:
    ctx = _ctx(
        history=[
            StepRecord(step=3, action="click", element_id=3, element_label="Third", outcome="success"),
            StepRecord(step=1, action="click", element_id=1, element_label="First", outcome="failure"),
            StepRecord(step=2, action="type", element_id=2, element_label="Second", outcome="ambiguous"),
        ]
    )
    prompt = build_completion_prompt(ctx)
    lines = [l for l in prompt.splitlines() if l.strip().startswith(("1.", "2.", "3."))]
    assert lines == sorted(lines, key=lambda l: int(l.strip().split(".")[0]))


def test_complete_prompt_most_recent_action_uses_highest_step_not_last_array_element() -> None:
    """The exact defect found live: array[-1] was step 2 ('ambiguous')
    while step 3 (the real most recent) was 'success'. `/complete`
    answering with the wrong outcome here could directly skew a
    completion verdict.
    """
    ctx = _ctx(
        history=[
            StepRecord(step=3, action="click", element_id=3, element_label="Third", outcome="success"),
            StepRecord(step=1, action="click", element_id=1, element_label="First", outcome="failure"),
            StepRecord(step=2, action="type", element_id=2, element_label="Second", outcome="ambiguous"),
        ]
    )
    prompt = build_completion_prompt(ctx)
    recent_line = next(l for l in prompt.splitlines() if l.startswith("Most recent action"))
    assert "click" in recent_line
    assert "success" in recent_line
    assert "ambiguous" not in recent_line


def test_history_already_in_order_renders_identically_to_before() -> None:
    """Regression guard: the sort must be a no-op for every existing
    test's already-ordered history (every one of them builds history
    1, 2, 3, ... — confirmed by inspection before adding this fix).
    """
    ctx = _ctx(
        history=[
            StepRecord(step=1, action="click", element_id=1, element_label="First", outcome="success"),
            StepRecord(step=2, action="click", element_id=2, element_label="Second", outcome="success"),
        ]
    )
    prompt = build_prompt(ctx)
    assert prompt.index("Step 1:") < prompt.index("Step 2:")


# ---------------------------------------------------------------------
# Duplicate labels — must remain distinguishable via element_id
# ---------------------------------------------------------------------


def test_duplicate_labels_remain_distinguishable_by_element_id() -> None:
    ctx = _ctx(
        elements=[
            CapturedElement(element_id=1, role="button", label="Add to cart"),
            CapturedElement(element_id=2, role="button", label="Add to cart"),
        ]
    )
    prompt = build_prompt(ctx)
    assert "id=1 role=button label='Add to cart'" in prompt
    assert "id=2 role=button label='Add to cart'" in prompt


# ---------------------------------------------------------------------
# Current-vs-history demarcation
# ---------------------------------------------------------------------


def test_current_elements_and_history_are_clearly_separated_sections() -> None:
    ctx = _ctx(
        elements=[CapturedElement(element_id=1, role="button", label="Confirm")],
        history=[StepRecord(step=1, action="click", element_id=2, element_label="Old button", outcome="success")],
    )
    prompt = build_prompt(ctx)
    history_idx = prompt.index("Steps already completed:")
    elements_idx = prompt.index("Interactive elements")
    assert history_idx < elements_idx, "history must be presented before, and clearly separate from, current state"
    # The history's OWN target (element 2, no longer necessarily present)
    # must not be confused with the CURRENT valid id list (element 1 only).
    assert "Valid element_id values: [1]" in prompt


# ---------------------------------------------------------------------
# Prompt size scaling — deterministic measurement, no live model
# ---------------------------------------------------------------------


def test_prompt_size_scales_with_element_count_and_stays_within_a_sane_bound() -> None:
    """Canary for the S2 audit's own measurement: at 500 simple elements
    the rendered /reason prompt is tens of thousands of characters —
    large enough that MAX_REQUEST_BODY_BYTES (which bounds the WIRE
    payload) does not by itself bound the rendered PROMPT size. This
    locks in the measured order of magnitude so a future change that
    silently balloons per-element rendering cost is caught.
    """
    elements = [CapturedElement(element_id=i, role="button", label=f"Option {i}") for i in range(500)]
    ctx = _ctx(elements=elements)
    prompt = build_prompt(ctx)
    # Measured directly (500 short-label elements): ~27.8k chars. Bounds
    # are loose on purpose — this is a canary for a 10x-scale regression
    # in per-element rendering cost, not a tight size contract.
    assert 15_000 < len(prompt) < 50_000


def test_prompt_size_scales_with_history_count() -> None:
    history = [
        StepRecord(step=i + 1, action="click", element_id=i, element_label=f"Step {i}", outcome="success")
        for i in range(100)
    ]
    ctx = _ctx(history=history)
    prompt = build_prompt(ctx)
    assert len(prompt) > 10_000
