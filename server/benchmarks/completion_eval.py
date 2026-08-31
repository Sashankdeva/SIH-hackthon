"""Benchmark the PRODUCTION completion probe.

completion_probe.py measured a hypothesis with its own inline prompt.
This measures what actually ships: it calls app.llm.completion's
CompletionProbe.judge() through app.llm.completion_prompt, so the number
reported describes the deployed code path rather than a reimplementation
of it.

Same dataset, same repeat count, same temperature as the experiment, so
the two figures are directly comparable:

    cd server
    PYTHONPATH=. python -m benchmarks.completion_eval --repeats 5
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path

from app.config import load_settings
from app.llm.completion import CompletionProbe
from app.llm.errors import ReasoningError
from app.models.context import SanitizedContext, StepRecord
from benchmarks.completion_dataset import ALL_COMPLETION_CASES
from benchmarks.completion_probe import summarise

RESULTS_DIR = Path(__file__).parent / "results"
ORIGIN = "http://localhost:8000"


def to_context(case: dict, run: int) -> SanitizedContext:
    """Map a dataset case onto the real SanitizedContext contract.

    The dataset predates this endpoint and stores history entries with a
    plain `label`; StepRecord calls that `element_label`. Mapping here
    rather than rewriting the dataset keeps the experiment and the
    production run measuring the same cases.
    """
    history = [
        StepRecord(
            step=h["step"],
            action=h["action"],
            element_id=None,
            element_label=h.get("label"),
            outcome=h["outcome"],
        )
        for h in case["history"]
    ]
    return SanitizedContext(
        task_id=f"complete-{case['id']}-r{run}",
        task=case["task"],
        page=case["page"],
        url_origin=ORIGIN,
        elements=case["elements"],
        fields={},
        history=history,
    )


async def main_async(repeats: int, out_path: Path, cases: list[dict] | None = None) -> None:
    settings = load_settings()
    probe = CompletionProbe(settings=settings)
    cases = cases if cases is not None else ALL_COMPLETION_CASES
    print(f"model={probe.model}  repeats={repeats}  temperature=0.0  (PRODUCTION path)")
    print(f"cases={len(cases)}\n")

    records: list[dict] = []
    for case in cases:
        answers, latencies = [], []
        for run in range(1, repeats + 1):
            ctx = to_context(case, run)
            started = time.perf_counter()
            try:
                result = await probe.judge(ctx)
                answer = result.complete
                # The endpoint's own guarantee, asserted per call rather
                # than trusted: task_id comes from the request.
                assert result.task_id == ctx.task_id, "task_id was not derived from the request"
            except ReasoningError as exc:
                answer = None
                print(f"  {case['id']} run {run}: REFUSED {exc.code}: {exc.reason}")
            latency_ms = (time.perf_counter() - started) * 1000
            answers.append(answer)
            latencies.append(latency_ms)
            records.append({
                "id": case["id"], "category": case["category"], "run": run,
                "task": case["task"], "expected": case["expected"], "answer": answer,
                "latency_ms": round(latency_ms),
                # Token counts are not exposed through the production
                # path (the probe returns a model, not an envelope), so
                # they are recorded as null rather than guessed.
                "prompt_tokens": None, "output_tokens": None,
            })

        exp = case["expected"]
        stable = len(set(answers)) == 1
        if exp is None:
            verdict = f"n/a (ambiguous)  answers={answers}"
        else:
            hits = sum(1 for a in answers if a == exp)
            verdict = f"{hits}/{repeats} correct"
            if hits < repeats:
                verdict += "  <- FALSE POSITIVE" if exp is False else "  <- false negative"
        print(f"{case['id']:<5}{case['category']:<20}exp={str(exp):<6}"
              f"{verdict:<38}{'stable' if stable else 'UNSTABLE':<9}"
              f"{round(statistics.mean(latencies))}ms")

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": probe.model,
        "repeats": repeats,
        "temperature": 0.0,
        "path": "production (app.llm.completion.CompletionProbe)",
        "records": records,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    print(f"\nrecords: {len(records)} -> {out_path}")

    lat = [r["latency_ms"] for r in records]
    ordered = sorted(lat)
    p95 = ordered[min(int(round(0.95 * len(ordered) + 0.5)) - 1, len(ordered) - 1)]
    summarise(records, repeats)
    print(f"  P95 latency                      : {p95} ms")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--out", type=Path, default=RESULTS_DIR / "completion_production.json")
    parser.add_argument("--s5", action="store_true",
                        help="use ALL_COMPLETION_CASES + the SERVER PHASE S5 additions "
                             "(benchmarks/completion_dataset_s5.py) instead of the base dataset")
    args = parser.parse_args()
    cases = None
    if args.s5:
        from benchmarks.completion_dataset_s5 import S5_NEW_CASES

        cases = list(ALL_COMPLETION_CASES) + S5_NEW_CASES
    asyncio.run(main_async(args.repeats, args.out, cases))


if __name__ == "__main__":
    main()
