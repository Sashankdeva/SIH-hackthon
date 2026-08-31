"""Safe current-field-state on the sanitized-context contract.

Closes a measured end-to-end failure. The real trace was:

    step 1  click the search box            -> ok
    step 2  type the query                  -> ok, verified success
    step 3  type the SAME query again       -> repeat loop, task halted
    step 4  (never reached in that run)

Cause: the context carries element role + label but never element
VALUES, so step 3's context was indistinguishable from step 2's and the
model could not observe that the field was now filled. Two prompt-only
fixes that tried to reason from history alone were measured and BOTH
failed (0/12 on the target case, while regressing an unrelated
redaction case) — see app/llm/prompt.py's "Tried and reverted" notes.
This adds the missing current-state signal instead.

The privacy mechanism here is the CLOSED ENUM, not merely a type
annotation: "empty" | "nonempty" | "redacted" are the only strings that
validate, so no raw field value can traverse this field even from a
hostile or buggy client.
"""

import pytest
from pydantic import ValidationError

from app.llm.prompt import build_prompt
from app.models.context import CapturedElement, SanitizedContext

ORIGIN = "http://localhost:8000"

SEARCH_LABEL = "Search for products, brands and more"


def ctx(elements: list[dict], **overrides) -> SanitizedContext:
    base = dict(
        task_id="t-value-state",
        task="search for a product and add it to the cart",
        page="Online Store",
        url_origin=ORIGIN,
        elements=elements,
        fields={},
    )
    base.update(overrides)
    return SanitizedContext(**base)


# ======================================================================
# MODEL — accepting, rejecting, defaulting
# ======================================================================


@pytest.mark.parametrize("state", ["empty", "nonempty", "redacted"])
def test_every_declared_state_is_accepted(state: str) -> None:
    el = CapturedElement(element_id=1, role="textbox", label=SEARCH_LABEL, value_state=state)
    assert el.value_state == state


def test_absent_value_state_defaults_to_none_not_empty() -> None:
    """Absence is NOT a claim of emptiness — it means the client does not
    report field state at all. Same convention `disabled` uses, and the
    reason the prompt renders this only when present. Every client built
    before this field existed omits it and must keep working."""
    el = CapturedElement(element_id=1, role="textbox", label=SEARCH_LABEL)
    assert el.value_state is None


@pytest.mark.parametrize(
    "bad",
    [
        "Samsung Galaxy S24 FE",   # a real query — the exact leak this prevents
        "hunter2",                 # a real password
        "EMPTY", "Nonempty", "",   # near-misses: the enum is exact
        "filled", "true", "null",
        1, 0, True, [], {},
    ],
)
def test_anything_that_is_not_a_declared_state_is_rejected(bad) -> None:
    """The closed enum IS the privacy boundary: a raw value cannot ride
    in this field even if a client tries, because no other string
    validates. Rejected by the model layer, before reasoning runs."""
    with pytest.raises(ValidationError):
        CapturedElement(element_id=1, role="textbox", label=SEARCH_LABEL, value_state=bad)


def test_explicit_null_is_accepted_as_unreported() -> None:
    el = CapturedElement(element_id=1, role="textbox", label=SEARCH_LABEL, value_state=None)
    assert el.value_state is None


# ======================================================================
# PROMPT — factual rendering, only when present
# ======================================================================


def test_state_is_rendered_on_the_element_line() -> None:
    prompt = build_prompt(ctx([
        {"element_id": 1, "role": "textbox", "label": SEARCH_LABEL, "value_state": "nonempty"},
    ]))
    assert f"- id=1 role=textbox label={SEARCH_LABEL!r} value_state=nonempty" in prompt


def test_prompt_is_byte_identical_when_no_element_reports_state() -> None:
    """A client that does not report field state must produce exactly the
    prompt it produced before this field existed — so the benchmark
    comparison isolates one variable."""
    elements = [
        {"element_id": 1, "role": "textbox", "label": SEARCH_LABEL},
        {"element_id": 2, "role": "button", "label": "Search"},
    ]
    without_field = build_prompt(ctx(elements))
    with_explicit_none = build_prompt(ctx([{**e, "value_state": None} for e in elements]))
    assert without_field == with_explicit_none
    assert "value_state" not in without_field.split("Interactive elements")[1].split("Valid element_id")[0]


def test_disabled_and_value_state_render_together() -> None:
    prompt = build_prompt(ctx([
        {"element_id": 1, "role": "textbox", "label": SEARCH_LABEL,
         "disabled": True, "value_state": "nonempty"},
    ]))
    assert "disabled=true value_state=nonempty" in prompt


def test_prompt_explains_that_state_is_current_and_content_is_hidden() -> None:
    """The instruction must convey three things without naming any task
    or site: the marker means already-filled, the content is never
    disclosed, and absence is not a claim of emptiness."""
    prompt = build_prompt(ctx([
        {"element_id": 1, "role": "textbox", "label": SEARCH_LABEL, "value_state": "nonempty"},
    ]))
    rule_8 = next(line for line in prompt.splitlines() if line.startswith("8."))
    assert "already holds text right now" in rule_8
    assert "never shown what that text is" in rule_8
    assert "not a claim that it is empty" in rule_8
    assert "does not need filling again" in rule_8


def test_state_instruction_names_no_site_task_or_action_sequence() -> None:
    """Anti-overfit + no hardcoded sequence: rule 8 must not name a site,
    a product, a task word, or prescribe "type then press Enter"."""
    prompt = build_prompt(ctx([{"element_id": 1, "role": "textbox", "label": SEARCH_LABEL,
                                "value_state": "nonempty"}]))
    rule_8 = next(line for line in prompt.splitlines() if line.startswith("8.")).lower()
    for banned in ("samsung", "amazon", "flipkart", "travel", "galaxy",
                   "press enter", "keypress", "submit button", "search button"):
        assert banned not in rule_8, f"rule 8 mentions {banned!r} — it must stay generic"


# ======================================================================
# THE ACTUAL FAILURE — the step-2 -> step-3 transition
# ======================================================================


def test_the_failing_transition_is_now_visibly_different_to_the_model() -> None:
    """The root cause, stated as a test: BEFORE this field, the context
    the model saw at step 3 (query already typed) was byte-identical to
    the one at step 2 (field still blank), so no amount of prompt
    wording could have distinguished them. Now they differ.
    """
    before = [
        {"element_id": 1, "role": "textbox", "label": SEARCH_LABEL, "value_state": "empty"},
        {"element_id": 2, "role": "button", "label": "Search"},
    ]
    after = [
        {"element_id": 1, "role": "textbox", "label": SEARCH_LABEL, "value_state": "nonempty"},
        {"element_id": 2, "role": "button", "label": "Search"},
    ]
    prompt_before = build_prompt(ctx(before))
    prompt_after = build_prompt(ctx(after))

    assert prompt_before != prompt_after, "the two page states must not look identical"
    assert "value_state=empty" in prompt_before
    assert "value_state=nonempty" in prompt_after

    # And without the field, they WOULD be identical — the bug itself.
    stripped = [{k: v for k, v in e.items() if k != "value_state"} for e in before]
    stripped_after = [{k: v for k, v in e.items() if k != "value_state"} for e in after]
    assert build_prompt(ctx(stripped)) == build_prompt(ctx(stripped_after))


# ======================================================================
# PRIVACY — no raw value can reach the prompt through this field
# ======================================================================


def test_no_raw_value_reaches_the_prompt_for_an_ordinary_field() -> None:
    prompt = build_prompt(ctx([
        {"element_id": 1, "role": "textbox", "label": SEARCH_LABEL, "value_state": "nonempty"},
    ]))
    assert "Samsung" not in prompt
    assert "nonempty" in prompt


def test_no_secret_reaches_the_prompt_for_a_redacted_field() -> None:
    """A token-labelled (secret) field reports state only. The token is
    already the label — the SECRET itself has no representation here at
    all, and `redacted` discloses nothing beyond 'has content'."""
    prompt = build_prompt(ctx(
        [{"element_id": 1, "role": "textbox", "label": "[PASSWORD_01]", "value_state": "redacted"}],
        fields={"1": "[PASSWORD_01]"},
    ))
    assert "hunter2" not in prompt
    assert "value_state=redacted" in prompt
    assert "[PASSWORD_01]" in prompt  # the token may appear; the secret may not


def test_a_client_cannot_smuggle_a_secret_through_the_state_field() -> None:
    """End-to-end statement of the enum's purpose, at the context level
    rather than the element level."""
    with pytest.raises(ValidationError):
        ctx([{"element_id": 1, "role": "textbox", "label": "[PASSWORD_01]",
              "value_state": "hunter2-the-real-password"}])


def test_value_state_does_not_leak_into_the_action_response() -> None:
    """Input-only field: it must not appear on the way back out."""
    from app.models.action import ActionResponse

    assert "value_state" not in ActionResponse.model_fields
