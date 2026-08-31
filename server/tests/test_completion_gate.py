"""Deterministic completion gating — /complete's evidence precondition.

Motivated by a measured Amazon-shaped failure: with history containing
only "searched" + "opened the product" and NO purchase action,
/complete answered `complete: true` 10/10, so the workflow had no
trustworthy stop signal.

These tests are hermetic — the probe's transport is mocked, so they
assert what the SERVER decides, never what the model happens to say.
Cases the gate cannot settle deterministically are pinned as xfail with
the reason, rather than deleted or weakened.
"""

import asyncio

import httpx
import pytest

from app.llm.completion import CompletionProbe
from app.models.context import SanitizedContext

ORIGIN = "https://www.amazon.in"
TASK = "Search for Samsung Galaxy S24 FE and add the first suitable result to the cart."
TARGET = "Samsung Galaxy S24 FE 5G (Graphite, 128GB)"

PRODUCT_ELEMENTS = [
    {"element_id": 1, "role": "link", "label": "Cart"},
    {"element_id": 2, "role": "link", "label": TARGET},
    {"element_id": 3, "role": "button", "label": "Add to Cart"},
    {"element_id": 4, "role": "button", "label": "Buy Now"},
    {"element_id": 5, "role": "link", "label": "Customers who bought this item also bought: Charger"},
    {"element_id": 6, "role": "button", "label": "Add to Cart"},
]

SEARCHED_AND_OPENED = [
    {"step": 1, "action": "type", "element_id": 9, "element_label": "Search Amazon.in", "outcome": "success"},
    {"step": 2, "action": "click", "element_id": 10, "element_label": "Go", "outcome": "success"},
    {"step": 3, "action": "click", "element_id": 2, "element_label": TARGET, "outcome": "success"},
]


def run(coro):
    return asyncio.run(coro)


def probe_saying(answer: bool) -> CompletionProbe:
    """A probe whose MODEL always says `answer`. Any verdict differing
    from `answer` therefore came from the server's own gate."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"response": '{"complete": %s}' % str(answer).lower()})

    return CompletionProbe(model="test-model", base_url="http://localhost:11434",
                           timeout_s=5.0, transport=httpx.MockTransport(handler))


def ctx(history, elements=None, page=None) -> SanitizedContext:
    return SanitizedContext(
        task_id="gate-test", task=TASK,
        page=page or ("Amazon.in: " + TARGET), url_origin=ORIGIN,
        elements=elements if elements is not None else PRODUCT_ELEMENTS,
        fields={}, history=history, route_hint="/dp/B0CT2PQ1RS",
    )


def step(n, label, outcome, action="click", element_id=3):
    return {"step": n, "action": action, "element_id": element_id,
            "element_label": label, "outcome": outcome}


# ======================================================================
# B — a failed purchase must never read as complete (the gate)
# ======================================================================


def test_B_failed_add_to_cart_is_incomplete_regardless_of_model() -> None:
    """The gate's core guarantee: the model is rigged to say True, and
    the server must still answer False, without consulting it."""
    history = SEARCHED_AND_OPENED + [step(4, "Add to Cart", "failure")]
    result = run(probe_saying(True).judge(ctx(history)))
    assert result.complete is False
    assert result.task_id == "gate-test"


def test_B_failed_purchase_does_not_reach_the_model_at_all() -> None:
    """Cheaper AND safer: a verified failure is settled server-side, so
    the model gets no opportunity to be misled by page text."""

    def never_called(request: httpx.Request) -> httpx.Response:
        raise AssertionError("the model must not be consulted after a verified failure")

    probe = CompletionProbe(model="test-model", base_url="http://localhost:11434",
                            timeout_s=5.0, transport=httpx.MockTransport(never_called))
    history = SEARCHED_AND_OPENED + [step(4, "Add to Cart", "failure")]
    assert run(probe.judge(ctx(history))).complete is False


def test_failure_gate_uses_highest_step_not_array_order() -> None:
    """Out-of-order history must not let a stale success mask the most
    recent failure — same highest-step rule the prompt renderer uses."""
    history = [step(4, "Add to Cart", "failure"), step(3, TARGET, "success")]
    assert run(probe_saying(True).judge(ctx(history))).complete is False


def test_an_earlier_failure_does_not_veto_a_later_success() -> None:
    """The converse: a failure followed by a verified success is NOT
    gated — recovery must still be able to complete."""
    history = [step(4, "Add to Cart", "failure"), step(5, "Add to Cart", "success")]
    assert run(probe_saying(True).judge(ctx(history))).complete is True


# ======================================================================
# C / E — a genuine success stays eligible
# ======================================================================


def test_C_successful_add_to_cart_is_eligible_for_completion() -> None:
    history = SEARCHED_AND_OPENED + [step(4, "Add to Cart", "success")]
    assert run(probe_saying(True).judge(ctx(history))).complete is True


def test_E_unrelated_clicks_after_a_successful_add_do_not_gate_completion() -> None:
    """Completion must not require further product actions, and an
    unrelated click afterwards must not re-open the question."""
    history = SEARCHED_AND_OPENED + [
        step(4, "Add to Cart", "success"),
        step(5, "Customer reviews", "success", element_id=7),
    ]
    assert run(probe_saying(True).judge(ctx(history))).complete is True


def test_D_recommendation_elements_present_do_not_affect_the_gate() -> None:
    """The page carries a second 'Add to Cart' for a recommended item.
    The gate reasons only about verified outcomes, so extra controls on
    the page cannot change the verdict either way."""
    history = SEARCHED_AND_OPENED + [step(4, "Add to Cart", "success")]
    assert run(probe_saying(True).judge(ctx(history))).complete is True
    assert run(probe_saying(False).judge(ctx(history))).complete is False


# ======================================================================
# Cases the gate deliberately does NOT settle — deferred to the model
# ======================================================================


def test_ambiguous_outcome_is_deferred_to_the_model_not_gated() -> None:
    """Ambiguous means the client could not SEE a change, not that none
    happened. Gating it would break SM1/SM2, where a step verified
    ambiguous but the page states the task is done — the endpoint has
    0 false negatives today and this keeps it that way.
    """
    history = SEARCHED_AND_OPENED + [step(4, "Add to Cart", "ambiguous")]
    assert run(probe_saying(True).judge(ctx(history))).complete is True
    assert run(probe_saying(False).judge(ctx(history))).complete is False


def test_empty_history_is_deferred_to_the_model_not_gated() -> None:
    """M1 ('turn on dark mode' on a page already showing Dark mode: ON)
    is legitimately complete with no history at all."""
    assert run(probe_saying(True).judge(ctx([]))).complete is True


@pytest.mark.xfail(
    strict=False,
    reason="MODEL LIMITATION (CP1/K1 class): search+open with all-success history and no "
           "purchase action. No deterministic signal separates this from a genuine completion "
           "— history records only (step, action, element_id, label, outcome), and every entry "
           "here is 'success'. Distinguishing 'opened the product' from 'added it' is semantic, "
           "and the 7B model answers True. Pinned rather than gated, because every gate that "
           "would catch it also breaks SM1/SM2/M1.",
)
def test_A_search_and_open_only_should_be_incomplete() -> None:
    """The originally-reported false positive. Uses the real model path
    only in the sense that the mocked model returns what the live one
    measurably returns here (True, 10/10)."""
    assert run(probe_saying(True).judge(ctx(SEARCHED_AND_OPENED))).complete is False


@pytest.mark.xfail(
    strict=False,
    reason="MODEL LIMITATION: an ambiguous purchase with no confirming page text. Gating "
           "ambiguous outcomes would introduce false negatives on SM1/SM2 (see the deferral "
           "test above), so this is left to the model's page-text judgement.",
)
def test_F_ambiguous_add_never_false_positives() -> None:
    history = SEARCHED_AND_OPENED + [step(4, "Add to Cart", "ambiguous")]
    assert run(probe_saying(True).judge(ctx(history))).complete is False
