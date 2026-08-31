"""The 21-case completion dataset, promoted to a live regression suite.

Skips automatically when Ollama or the model is unavailable, so the
normal suite stays hermetic — same guard as test_integration_ollama.py.

One repeat per case here (~13s); the 5-repeat statistical protocol lives
in benchmarks/completion_eval.py. This suite exists to catch a
REGRESSION — a case that used to pass and stopped — not to re-measure
accuracy.

CHARACTERIZATION, not aspiration: CP1 and ML1 are pinned as currently
FAILING.

CP1: the probe answers `complete: true` for "add the item to the cart
and go to checkout" when only the first clause is done, because the
page ("Cart — 1 item", with a "Checkout" button) carries the vocabulary
of the unmet clause. That was isolated by varying only the page text —
rename it "Basket" with a "Continue to payment" button and the same
structure is judged correctly — so it is a genuine model failure, not a
flaw in the case. A compound-task clause-counting prompt rule was tried
against it during S5 (fixed CP1, but regressed the mirror-image CP2
from 10/10 to 0/10 and did not generalize to a 3-clause case) and was
reverted — see app/llm/completion_prompt.py's own "tried and reverted"
comment.

ML1's history is the more interesting one — a genuine cross-session
INSTABILITY, not a fixed defect, and worth recording in full because it
changes what "characterized" can honestly mean for this endpoint:
  - Before S1: silently failing, unpinned, uncharacterized.
  - S5: found, characterized, pinned alongside CP1 (10/10 wrong).
  - S6.1: after setting explicit num_ctx=16384/num_predict=200,
    measured 10/10 CORRECT on two independent runs. ML1's own prompt
    (no elements, empty history) was never anywhere near the
    ~2050-token truncation ceiling that phase actually targeted, so
    this was recorded as an unexplained, not-fully-understood side
    effect — and UNPINNED per this file's protocol, with that caveat
    stated explicitly rather than the fix being over-claimed.
  - S7: the very next full-suite run (same code, no changes to
    completion_prompt.py or the num_ctx/num_predict values since S6.1)
    measured 10/10 WRONG again — a full reversion, re-confirmed with a
    fresh independent 10x sample.
Each individual sample is internally stable (10/10 agreement within
itself) — this is NOT the usual within-run temp=0 wobble documented
elsewhere in this project (e.g. /reason's G1 case). It is a DIFFERENT
kind of instability: consistent WITHIN a process's lifetime, but not
consistent ACROSS separate launches/model-reload events. The most
plausible explanation, unconfirmed: some aspect of Ollama's loaded
runtime state (KV-cache memory layout, batching/kernel selection) that
can differ between model loads is influencing this specific borderline
case, independent of any code change here. RE-PINNED rather than left
unpinned on the strength of one favorable sample — this is exactly the
lesson this pin protocol exists to enforce.

Pinned failing rather than deleted: removing a failing test to improve
a score hides the defects this endpoint actually has.
"""

import asyncio

import httpx
import pytest

from app.config import load_settings
from app.llm.completion import CompletionProbe
from app.llm.errors import ReasoningError
from benchmarks.completion_dataset import ALL_COMPLETION_CASES
from benchmarks.completion_eval import to_context

_settings = load_settings()


def _ollama_available() -> bool:
    try:
        response = httpx.get(f"{_settings.ollama_base_url}/api/tags", timeout=2.0)
        if response.status_code != 200:
            return False
        names = {m.get("name") for m in response.json().get("models", [])}
        return _settings.ollama_model in names
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _ollama_available(),
    reason=f"Ollama with model {_settings.ollama_model!r} not reachable at {_settings.ollama_base_url}",
)

#: Cases the probe is currently measured to get WRONG. Pinned so the
#: suite is honest about the known defect and so a future fix is
#: detected (the test flips to an unexpected pass) rather than assumed.
KNOWN_FAILING = {"CP1", "ML1"}

#: Underspecified by construction — no answer is defensibly "right", so
#: these assert only that a verdict is produced at all.
AMBIGUOUS = {case["id"] for case in ALL_COMPLETION_CASES if case["expected"] is None}

SCORED = [c for c in ALL_COMPLETION_CASES if c["expected"] is not None and c["id"] not in KNOWN_FAILING]


def judge(case: dict) -> bool:
    probe = CompletionProbe()
    return asyncio.run(probe.judge(to_context(case, 1))).complete


@pytest.mark.parametrize("case", SCORED, ids=[c["id"] for c in SCORED])
def test_completion_verdict_matches_ground_truth(case: dict) -> None:
    assert judge(case) is case["expected"], (
        f"{case['id']} ({case['category']}): expected complete={case['expected']} "
        f"for task {case['task']!r} on page {case['page']!r}"
    )


@pytest.mark.parametrize("case", [c for c in ALL_COMPLETION_CASES if c["id"] in AMBIGUOUS],
                         ids=sorted(AMBIGUOUS))
def test_ambiguous_cases_still_produce_a_boolean(case: dict) -> None:
    """No right answer, but the contract must still hold."""
    assert isinstance(judge(case), bool)


@pytest.mark.xfail(strict=True, reason="known vocabulary-overlap false positive — see module docstring")
def test_known_vocabulary_overlap_false_positive_cp1() -> None:
    """Pinned characterization. `strict=True` means this FAILS the suite
    if it ever starts passing — the fix must be accompanied by removing
    the pin and re-running the 5-repeat benchmark, not left to drift.
    CP1 has been reproducibly wrong on every sample taken across S5,
    S6.1, and S7 — `strict=True` is appropriate because its failure
    direction has, so far, never actually changed.
    """
    case = next(c for c in ALL_COMPLETION_CASES if c["id"] == "CP1")
    assert judge(case) is False, "CP1 now passes — unpin it and re-benchmark"


@pytest.mark.xfail(
    strict=False,
    reason="cross-session instability, not a stable failure — see module docstring's ML1 history",
)
def test_known_cross_session_instability_ml1() -> None:
    """Deliberately NOT strict=True, unlike CP1 above: ML1 has been
    observed both 10/10 wrong (S5, S7) and 10/10 right (S6.1) on
    different process launches with IDENTICAL code — a strict pin would
    itself flip between failing-as-expected and XPASS-failure every time
    this case's underlying instability resolves the other way, which is
    exactly the kind of test-suite noise a strict pin exists to prevent
    for a REAL, stable defect. This just records that ML1 remains
    excluded from SCORED and unreliable in either direction; do not
    tighten this to strict=True without first observing many consecutive
    stable samples across separate process launches, not just one.
    """
    case = next(c for c in ALL_COMPLETION_CASES if c["id"] == "ML1")
    assert judge(case) is False, "ML1 is unreliable — see module docstring, not a bug in this test"


def test_no_case_produces_complete_true_on_a_failure() -> None:
    """Fail-closed, live: an unreachable model yields an error, never a
    completion verdict."""
    probe = CompletionProbe(base_url="http://127.0.0.1:1", timeout_s=2.0)
    case = ALL_COMPLETION_CASES[0]
    with pytest.raises(ReasoningError):
        asyncio.run(probe.judge(to_context(case, 1)))
