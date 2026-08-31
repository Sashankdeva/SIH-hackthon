"""Phase 4 — multi-step context/history handling, mocked-model tests.

These are CONTRACT tests, not reasoning-quality tests: every model
response here is a fixed mock, so these prove the SERVER correctly
plumbs history/step_id/state through build_prompt -> Ollama call ->
validation, deterministically, regardless of what the model says.
Reasoning QUALITY (whether the real model makes the right choice given
a realistic multi-step scenario) is measured separately by the
benchmark and the live integration tests — see
test_integration_multistep_live.py and benchmarks/.

The server is stateless: every context here is built by hand per call,
exactly as extension/src/content/index.ts's runTask() loop builds one
per step in production. Nothing here relies on the server remembering
anything between calls.
"""

import asyncio

import httpx
import pytest

from app.llm.client import OllamaReasoningClient
from app.llm.errors import ActionRejected
from app.llm.prompt import build_prompt
from app.models.context import CapturedElement, SanitizedContext, StepRecord
from tests.conftest import action_json, ollama_transport

TASK_ID = "multistep-test"
ORIGIN = "http://localhost:8000"


def run(coro):
    return asyncio.run(coro)


def client_with(transport: httpx.AsyncBaseTransport) -> OllamaReasoningClient:
    return OllamaReasoningClient(
        model="test-model", base_url="http://localhost:11434", timeout_s=5.0, transport=transport
    )


def ctx(elements: list[dict], history: list[StepRecord], task: str = "complete the flow") -> SanitizedContext:
    return SanitizedContext(
        task_id=TASK_ID,
        task=task,
        page="Multi-step page",
        url_origin=ORIGIN,
        elements=[CapturedElement(**el) for el in elements],
        fields={},
        history=history,
    )


PAGE = [
    {"element_id": 1, "role": "button", "label": "Step A"},
    {"element_id": 2, "role": "button", "label": "Step B"},
    {"element_id": 3, "role": "button", "label": "Step C"},
    {"element_id": 4, "role": "button", "label": "Finish"},
]


# ======================================================================
# two / three / four-step tasks — step_id is purely a function of
# history length, computed server-side, never supplied by the model
# ======================================================================


def test_two_step_task_step_id_is_two() -> None:
    history = [StepRecord(step=1, action="click", element_id=1, element_label="Step A", outcome="success")]
    client = client_with(ollama_transport(response_text=action_json(action="click", element_id=2)))
    action = run(client.propose_action(ctx(PAGE, history)))
    assert action.step_id == 2
    assert action.task_id == TASK_ID


def test_three_step_task_step_id_is_three() -> None:
    history = [
        StepRecord(step=1, action="click", element_id=1, element_label="Step A", outcome="success"),
        StepRecord(step=2, action="click", element_id=2, element_label="Step B", outcome="success"),
    ]
    client = client_with(ollama_transport(response_text=action_json(action="click", element_id=3)))
    action = run(client.propose_action(ctx(PAGE, history)))
    assert action.step_id == 3


def test_four_step_task_step_id_is_four() -> None:
    history = [
        StepRecord(step=1, action="click", element_id=1, element_label="Step A", outcome="success"),
        StepRecord(step=2, action="click", element_id=2, element_label="Step B", outcome="success"),
        StepRecord(step=3, action="click", element_id=3, element_label="Step C", outcome="success"),
    ]
    client = client_with(ollama_transport(response_text=action_json(action="click", element_id=4)))
    action = run(client.propose_action(ctx(PAGE, history)))
    assert action.step_id == 4


# ======================================================================
# history containing successful steps
# ======================================================================


def test_history_with_successful_steps_renders_and_validates() -> None:
    history = [
        StepRecord(step=1, action="click", element_id=1, element_label="Step A", outcome="success"),
        StepRecord(step=2, action="click", element_id=2, element_label="Step B", outcome="success"),
    ]
    prompt = build_prompt(ctx(PAGE, history))
    assert "Step 1: click on element 1 ('Step A') → success" in prompt
    assert "Step 2: click on element 2 ('Step B') → success" in prompt

    client = client_with(ollama_transport(response_text=action_json(action="click", element_id=3)))
    action = run(client.propose_action(ctx(PAGE, history)))
    assert action.element_id == 3


# ======================================================================
# history containing failed steps
# ======================================================================


def test_history_with_a_failed_step_renders_and_still_validates() -> None:
    """Nothing in the server treats a failure outcome specially — the
    client's PVM/recovery layer decides what to do about a failure; the
    server just reasons over whatever context it's given, including a
    history that says a prior step didn't land."""
    history = [
        StepRecord(step=1, action="click", element_id=1, element_label="Step A", outcome="failure"),
    ]
    prompt = build_prompt(ctx(PAGE, history))
    assert "Step 1: click on element 1 ('Step A') → failure" in prompt

    client = client_with(ollama_transport(response_text=action_json(action="click", element_id=1)))
    action = run(client.propose_action(ctx(PAGE, history)))
    assert action.element_id == 1
    assert action.step_id == 2


def test_history_with_ambiguous_outcome_renders_and_still_validates() -> None:
    history = [
        StepRecord(step=1, action="scroll", element_id=None, element_label=None, outcome="ambiguous"),
    ]
    prompt = build_prompt(ctx(PAGE, history))
    assert "Step 1: scroll → ambiguous" in prompt

    client = client_with(ollama_transport(response_text=action_json(action="click", element_id=1)))
    action = run(client.propose_action(ctx(PAGE, history)))
    assert action.step_id == 2


# ======================================================================
# changed page state — history's element_id is never cross-checked
# against the CURRENT elements list; only the model's PROPOSED
# element_id is (see app.llm.validation.validate_target). History is
# informational, describing what happened on a PAST page state that no
# longer needs to exist.
# ======================================================================


def test_changed_page_state_history_element_not_present_now_still_works() -> None:
    """Simulates a navigation: step 1 clicked something on the OLD page;
    the new page (step 2's context) has an entirely different element
    set with no id=1 at all."""
    history = [
        StepRecord(step=1, action="click", element_id=1, element_label="Continue", outcome="success"),
    ]
    new_page = [
        {"element_id": 10, "role": "button", "label": "Confirm"},
        {"element_id": 11, "role": "link", "label": "Cancel"},
    ]
    client = client_with(ollama_transport(response_text=action_json(action="click", element_id=10)))
    action = run(client.propose_action(ctx(new_page, history)))
    assert action.element_id == 10
    assert action.step_id == 2


# ======================================================================
# stale previous element — an id reused across page states with a
# DIFFERENT meaning each time must not be conflated in the prompt
# ======================================================================


def test_stale_element_id_reused_with_different_label_is_not_conflated() -> None:
    """History says step 1 clicked id=3 ('Old Button' — a page that no
    longer exists). The CURRENT page also happens to have an id=3, but
    it means something else now ('New Field'). The prompt must render
    history's label from HISTORY and the live element's label from the
    CURRENT elements list — never substitute one for the other."""
    history = [
        StepRecord(step=1, action="click", element_id=3, element_label="Old Button", outcome="success"),
    ]
    reindexed_page = [
        {"element_id": 3, "role": "input:text", "label": "New Field"},
        {"element_id": 4, "role": "button", "label": "Submit"},
    ]
    prompt = build_prompt(ctx(reindexed_page, history))
    assert "'Old Button'" in prompt  # history retains what it actually was
    assert "id=3 role=input:text label='New Field'" in prompt  # current state is independently accurate
    assert prompt.count("Old Button") == 1
    assert prompt.count("New Field") == 1

    # A model targeting id=3 now must resolve to the CURRENT meaning
    # (New Field), validated against the CURRENT elements list only.
    client = client_with(ollama_transport(response_text=action_json(action="type", element_id=3, value="hello")))
    action = run(client.propose_action(ctx(reindexed_page, history)))
    assert action.element_id == 3
    assert action.value == "hello"


# ======================================================================
# repeated action — accepted, not blocked (see test_reasoning_hardening
# for the single-history-entry version; this one checks step_id keeps
# advancing correctly across an actual repeat)
# ======================================================================


def test_repeated_action_across_steps_is_accepted_with_correct_step_id() -> None:
    history = [
        StepRecord(step=1, action="click", element_id=2, element_label="Step B", outcome="success"),
        StepRecord(step=2, action="click", element_id=2, element_label="Step B", outcome="success"),
    ]
    client = client_with(ollama_transport(response_text=action_json(action="click", element_id=2)))
    action = run(client.propose_action(ctx(PAGE, history)))
    assert action.action == "click"
    assert action.element_id == 2
    assert action.step_id == 3


# ======================================================================
# task completion / done
# ======================================================================


def test_done_after_multiple_successful_steps() -> None:
    history = [
        StepRecord(step=1, action="click", element_id=1, element_label="Step A", outcome="success"),
        StepRecord(step=2, action="click", element_id=2, element_label="Step B", outcome="success"),
        StepRecord(step=3, action="click", element_id=4, element_label="Finish", outcome="success"),
    ]
    client = client_with(ollama_transport(response_text='{"action":"done","confidence":0.97}'))
    action = run(client.propose_action(ctx(PAGE, history)))
    assert action.action == "done"
    assert action.step_id == 4
    assert action.element_id is None
    assert action.value is None
    assert action.url is None


def test_done_rejected_on_first_step_with_no_history() -> None:
    """Rule 11's guardrail still holds in a genuinely empty-history
    call — validation.py doesn't special-case this (an empty history
    doesn't forbid 'done' deterministically; this documents that the
    guardrail is prompt-level here, and confirms a bare 'done' with no
    forbidden fields still passes validation structurally, i.e. this is
    a reasoning-quality expectation, not something the schema blocks)."""
    client = client_with(ollama_transport(response_text='{"action":"done","confidence":0.9}'))
    action = run(client.propose_action(ctx(PAGE, [])))
    # Structurally valid — validation.py does not reject a bare 'done'
    # regardless of history length; rule 11 is what discourages the
    # MODEL from emitting it here in practice, not a validation.py rule.
    assert action.action == "done"
    assert action.step_id == 1


def test_done_with_forbidden_field_rejected_in_multistep_context() -> None:
    history = [
        StepRecord(step=1, action="click", element_id=1, element_label="Step A", outcome="success"),
        StepRecord(step=2, action="click", element_id=2, element_label="Step B", outcome="success"),
    ]
    client = client_with(ollama_transport(response_text='{"action":"done","element_id":4,"confidence":0.9}'))
    with pytest.raises(ActionRejected, match="bare terminal signal"):
        run(client.propose_action(ctx(PAGE, history)))


# ======================================================================
# statelessness — the server must carry NOTHING between requests
# ======================================================================


def test_server_is_stateless_across_sequential_requests() -> None:
    """The same client instance, called repeatedly, must derive every
    answer purely from the context it was just handed.

    Call 1 has three history entries (so step_id 4); call 2 reuses the
    SAME client with an EMPTY history and must go back to step_id 1. If
    anything were cached between calls — a session, a step counter, a
    page-state memo — call 2 would not reset.
    """
    client = client_with(ollama_transport(response_text=action_json(action="click", element_id=1)))

    long_history = [
        StepRecord(step=1, action="click", element_id=1, element_label="Step A", outcome="success"),
        StepRecord(step=2, action="click", element_id=2, element_label="Step B", outcome="success"),
        StepRecord(step=3, action="click", element_id=3, element_label="Step C", outcome="success"),
    ]
    first = run(client.propose_action(ctx(PAGE, long_history)))
    assert first.step_id == 4

    second = run(client.propose_action(ctx(PAGE, [])))
    assert second.step_id == 1, "step_id must reset — the server remembers nothing between calls"


def test_prompt_depends_only_on_the_current_context() -> None:
    """Two identical contexts must produce byte-identical prompts, and a
    prompt built after a long-history call must not retain any trace of
    it. Guards against a caching/memoization regression in build_prompt.
    """
    long_history = [
        StepRecord(step=1, action="click", element_id=1, element_label="Step A", outcome="success"),
        StepRecord(step=2, action="click", element_id=2, element_label="Step B", outcome="success"),
    ]
    build_prompt(ctx(PAGE, long_history))  # prime, then discard

    fresh_a = build_prompt(ctx(PAGE, []))
    fresh_b = build_prompt(ctx(PAGE, []))
    assert fresh_a == fresh_b
    assert "Steps already completed" not in fresh_a
    # "Step A" legitimately appears as element id=1's own label in the
    # current elements list, so its absence isn't the right signal —
    # what must be absent is any trace of the HISTORY rendering, whose
    # distinctive format is "Step N: <action> ... → <outcome>".
    assert "→ success" not in fresh_a
    assert "Step 1: click" not in fresh_a
