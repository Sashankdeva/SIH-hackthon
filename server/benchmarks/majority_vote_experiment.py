"""EXPERIMENT ONLY — majority-vote reliability study for action reasoning.

Not production code. Nothing in app/ imports this. Motivated by the
stability investigation that found G1 ("scroll down") flipping between
`click` and `scroll` within a single continuous run at temperature 0,
16/20 click vs 4/20 scroll — direct evidence against treating
temperature=0 as deterministic.

This script compares, per case:
  Strategy A — one call, the production path unchanged.
  Strategy B — three independent calls to the SAME production path,
               with a deterministic majority rule over the vote key.

Every result (single-call and each of the three votes) already passed
the REAL build_validated_action — client.propose_action() (the
production path, called unmodified here) runs it internally as the
final step before returning. A vote that fails validation surfaces here
as a ReasoningError, not a value, and is tallied as its own outcome
rather than silently dropped — a case where the majority forms from
{ActionRejected, ActionRejected, valid_action} is exactly the kind of
result this experiment needs to show, not hide. "Preserve safety" is
therefore measured as a property of the existing pipeline, not
re-implemented or bypassed by this script.

    cd server
    PYTHONPATH=. python -m benchmarks.majority_vote_experiment
"""

from __future__ import annotations

import asyncio
import collections
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from app.llm.client import OllamaReasoningClient
from app.llm.completion import CompletionProbe
from app.llm.errors import ReasoningError
from app.models.context import SanitizedContext
from benchmarks.completion_dataset import ALL_COMPLETION_CASES
from benchmarks.completion_eval import to_context as completion_ctx
from benchmarks.dataset import AMBIGUOUS, DETERMINISTIC
from benchmarks.dataset_extended import ADVERSARIAL, MULTISTEP
from benchmarks.runner import make_context

RESULTS_DIR = Path(__file__).parent / "results"

#: The minimum required set: G1/G2 (known unstable), C1 (prior
#: regression case), I3 (known persistent failure), three multi-step
#: cases, four adversarial cases, and four normal click/type/navigation
#: cases spanning the remaining action types.
CASE_IDS = [
    "G1", "G2",                      # scrolling — known within-run instability
    "C1", "C2",                      # type_secret — token binding
    "C3",                            # plain type
    "I3",                            # ambiguous — known persistent failure
    "A1",                            # navigation
    "D1",                            # checkout click
    "L1", "L2", "L3",                # multi-step wizard
    "O1", "O2", "O3", "O4",          # adversarial
]

SINGLE_REPEATS = 5   # Strategy A: independent single calls, for its own baseline
VOTE_TRIALS = 5       # Strategy B: independent trials, each = 3 fresh calls

ALL_CASES = {c["id"]: c for c in DETERMINISTIC + AMBIGUOUS + MULTISTEP + ADVERSARIAL}


def vote_key(action) -> tuple:
    """Canonical tuple two actions must match on to count as 'the same
    vote'. Covers action type, target element id, and the parameters
    that carry the action's actual effect for the action types in this
    dataset (scroll's direction, navigate's url) — per the brief's
    'action type, target element ID, relevant action parameters'.
    """
    return (action.action, action.element_id, action.direction, action.url)


def outcome_of(action) -> str:
    return f"{action.action}/{action.element_id}"


async def call_once(client: OllamaReasoningClient, ctx: SanitizedContext) -> dict:
    """One real inference call through the PRODUCTION path, validated
    through the PRODUCTION validator. Returns a uniform record whether
    it succeeded or was refused — a refusal is itself an outcome to
    tally, not something to hide from the vote.
    """
    started = time.perf_counter()
    try:
        action = await client.propose_action(ctx)
        latency_ms = (time.perf_counter() - started) * 1000
        return {
            "ok": True,
            "action": action,
            "key": vote_key(action),
            "outcome": outcome_of(action),
            "confidence": action.confidence,
            "latency_ms": latency_ms,
        }
    except ReasoningError as exc:
        latency_ms = (time.perf_counter() - started) * 1000
        return {
            "ok": False,
            "action": None,
            "key": ("ERROR", exc.code),
            "outcome": f"ERROR:{exc.code}",
            "confidence": None,
            "latency_ms": latency_ms,
        }


def is_acceptable(action_type, element_id, case: dict) -> bool:
    return [action_type, element_id] in case["acceptable"]


async def run_case(client: OllamaReasoningClient, case: dict) -> dict:
    cid = case["id"]
    print(f"  {cid} ({case['category']}) {case['task']!r} ...", flush=True)

    # ---- Strategy A: single-call baseline, SINGLE_REPEATS independent runs ----
    single_records = []
    for i in range(SINGLE_REPEATS):
        ctx = make_context(case, run_index=1000 + i)  # unique task_id per call
        rec = await call_once(client, ctx)
        single_records.append(rec)

    # ---- Strategy B: VOTE_TRIALS independent trials, 3 concurrent calls each ----
    trial_records = []
    for t in range(VOTE_TRIALS):
        ctxs = [make_context(case, run_index=2000 + t * 3 + j) for j in range(3)]
        votes = await asyncio.gather(*(call_once(client, c) for c in ctxs))
        keys = [v["key"] for v in votes]
        counts = collections.Counter(keys)
        winner, winner_count = counts.most_common(1)[0]
        majority_key = winner if winner_count >= 2 else None
        majority_vote = next((v for v in votes if v["key"] == majority_key), None) if majority_key else None

        trial_records.append({
            "trial": t,
            "votes": votes,
            "unanimous": len(counts) == 1,
            "has_majority": majority_key is not None,
            "majority_outcome": majority_vote["outcome"] if majority_vote else None,
            "majority_action": majority_vote["action"] if majority_vote else None,
            "wall_ms": max(v["latency_ms"] for v in votes),  # concurrent dispatch
            "sum_ms": sum(v["latency_ms"] for v in votes),   # sequential-equivalent cost
        })

    return {"case": case, "single": single_records, "trials": trial_records}


async def call_completion_once(probe: CompletionProbe, ctx: SanitizedContext) -> dict:
    """Same shape as call_once, for the /complete path — ML1 is a
    completion case, not an action case, so it needs its own client."""
    started = time.perf_counter()
    try:
        result = await probe.judge(ctx)
        latency_ms = (time.perf_counter() - started) * 1000
        return {"ok": True, "key": (result.complete,), "outcome": str(result.complete),
                "confidence": None, "latency_ms": latency_ms}
    except ReasoningError as exc:
        latency_ms = (time.perf_counter() - started) * 1000
        return {"ok": False, "key": ("ERROR", exc.code), "outcome": f"ERROR:{exc.code}",
                "confidence": None, "latency_ms": latency_ms}


async def run_completion_case(probe: CompletionProbe, case: dict) -> dict:
    print(f"  {case['id']} (completion) {case['task']!r} ...", flush=True)
    single_records = [await call_completion_once(probe, completion_ctx(case, 1000 + i))
                       for i in range(SINGLE_REPEATS)]

    trial_records = []
    for t in range(VOTE_TRIALS):
        ctxs = [completion_ctx(case, 2000 + t * 3 + j) for j in range(3)]
        votes = await asyncio.gather(*(call_completion_once(probe, c) for c in ctxs))
        keys = [v["key"] for v in votes]
        counts = collections.Counter(keys)
        winner, winner_count = counts.most_common(1)[0]
        majority_key = winner if winner_count >= 2 else None
        majority_vote = next((v for v in votes if v["key"] == majority_key), None) if majority_key else None
        trial_records.append({
            "trial": t, "votes": votes, "unanimous": len(counts) == 1,
            "has_majority": majority_key is not None,
            "majority_outcome": majority_vote["outcome"] if majority_vote else None,
            "wall_ms": max(v["latency_ms"] for v in votes),
            "sum_ms": sum(v["latency_ms"] for v in votes),
        })
    return {"case": case, "single": single_records, "trials": trial_records}


async def main_async(out_path: Path) -> None:
    client = OllamaReasoningClient()
    print(f"model={client.model}  cases={len(CASE_IDS)}  "
          f"single_repeats={SINGLE_REPEATS}  vote_trials={VOTE_TRIALS}\n")

    results = []
    for cid in CASE_IDS:
        case = ALL_CASES[cid]
        results.append(await run_case(client, case))

    probe = CompletionProbe()
    ml1_case = next(c for c in ALL_COMPLETION_CASES if c["id"] == "ML1")
    completion_result = await run_completion_case(probe, ml1_case)

    # ---- Serialize (ActionResponse objects aren't JSON-native) ----
    def serialize_action(a):
        if a is None:
            return None
        return {"action": a.action, "element_id": a.element_id, "direction": a.direction,
                "url": a.url, "value": a.value, "value_ref": a.value_ref, "confidence": a.confidence}

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": client.model,
        "single_repeats": SINGLE_REPEATS,
        "vote_trials": VOTE_TRIALS,
        "results": [
            {
                "id": r["case"]["id"],
                "category": r["case"]["category"],
                "task": r["case"]["task"],
                "acceptable": r["case"]["acceptable"],
                "single": [
                    {**{k: v for k, v in rec.items() if k != "action"}, "action": serialize_action(rec["action"])}
                    for rec in r["single"]
                ],
                "trials": [
                    {
                        "trial": t["trial"],
                        "votes": [
                            {**{k: v for k, v in rec.items() if k != "action"},
                             "action": serialize_action(rec["action"])}
                            for rec in t["votes"]
                        ],
                        "unanimous": t["unanimous"],
                        "has_majority": t["has_majority"],
                        "majority_outcome": t["majority_outcome"],
                        "majority_action": serialize_action(t["majority_action"]),
                        "wall_ms": t["wall_ms"],
                        "sum_ms": t["sum_ms"],
                    }
                    for t in r["trials"]
                ],
            }
            for r in results
        ],
        "completion_case": {
            "id": completion_result["case"]["id"],
            "task": completion_result["case"]["task"],
            "expected": completion_result["case"]["expected"],
            "single": [{k: v for k, v in rec.items()} for rec in completion_result["single"]],
            "trials": [
                {"trial": t["trial"], "votes": t["votes"], "unanimous": t["unanimous"],
                 "has_majority": t["has_majority"], "majority_outcome": t["majority_outcome"],
                 "wall_ms": t["wall_ms"], "sum_ms": t["sum_ms"]}
                for t in completion_result["trials"]
            ],
        },
    }

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    print(f"\n-> {out_path}")


def main() -> None:
    asyncio.run(main_async(RESULTS_DIR / "majority_vote_experiment.json"))


if __name__ == "__main__":
    main()
