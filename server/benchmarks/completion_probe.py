"""EXPERIMENT — a dedicated binary task-completion probe.

NOT production code. Nothing in app/ imports this, and it does not touch
the action prompt, the ActionResponse schema, or any production module.
It exists to answer one question with measurement rather than opinion:

    the model emits `done` 0/235 times as one of eight action types —
    but can it answer "is this task complete?" as a standalone yes/no?

Those are different asks. `done` competes against seven concrete actions
that all look more useful; a binary question has no such competition.
Whether that difference matters is exactly what this measures.

    cd server
    PYTHONPATH=. python -m benchmarks.completion_probe --repeats 5

The probe deliberately uses its OWN minimal prompt and its OWN strict
schema. Reusing the action prompt would reintroduce the competition the
experiment is trying to remove.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import json
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from app.config import load_settings
from benchmarks.completion_dataset import ALL_COMPLETION_CASES

RESULTS_DIR = Path(__file__).parent / "results"

#: Strict output contract. Grammar-constrained by Ollama, so the model
#: cannot answer with prose, a third value, or extra keys.
COMPLETION_SCHEMA = {
    "type": "object",
    "properties": {"complete": {"type": "boolean"}},
    "required": ["complete"],
    "additionalProperties": False,
}


def build_completion_prompt(case: dict) -> str:
    """Minimal binary prompt.

    Contains no rule about what "complete" means for any particular kind
    of task — stating such rules would be the task-specific hardcoding
    this phase forbids. It supplies facts (task, history, last outcome,
    current page) and asks one question.
    """
    if case["history"]:
        history_lines = "\n".join(
            f"  {h['step']}. {h['action']} on {h['label']!r} -> {h['outcome']}"
            for h in case["history"]
        )
    else:
        history_lines = "  (nothing has been done yet)"

    elements = "\n".join(
        f"  - {el['role']}: {el['label']!r}" for el in case["elements"]
    ) or "  (no interactive elements)"

    if case["last_action"]:
        last = f"{case['last_action']} -> verification: {case['last_outcome']}"
    else:
        last = "(no action has been taken)"

    return f"""You judge whether a user's requested task is now fully complete.

THE USER ASKED: {case['task']}

Steps performed so far:
{history_lines}

Most recent action: {last}

The page now shows: {case['page']}
Interactive elements now on the page:
{elements}

Considering ONLY whether the user's stated task above is fully done,
answer with JSON: {{"complete": true}} or {{"complete": false}}."""


async def ask(client: httpx.AsyncClient, base_url: str, model: str, prompt: str) -> dict:
    started = time.perf_counter()
    response = await client.post(
        f"{base_url}/api/generate",
        json={
            "model": model,
            "prompt": prompt,
            "format": COMPLETION_SCHEMA,
            "stream": False,
            "options": {"temperature": 0.0},
        },
    )
    latency_ms = (time.perf_counter() - started) * 1000
    payload = response.json()
    raw = payload.get("response", "")
    try:
        parsed = json.loads(raw)
        answer = parsed.get("complete")
        answer = answer if isinstance(answer, bool) else None
    except (json.JSONDecodeError, AttributeError):
        answer = None
    return {
        "answer": answer,
        "raw": raw,
        "latency_ms": latency_ms,
        "prompt_tokens": payload.get("prompt_eval_count"),
        "output_tokens": payload.get("eval_count"),
    }


async def main_async(repeats: int, out_path: Path) -> None:
    settings = load_settings()
    print(f"model={settings.ollama_model}  repeats={repeats}  temperature=0.0")
    print(f"cases={len(ALL_COMPLETION_CASES)}\n")

    records: list[dict] = []
    async with httpx.AsyncClient(timeout=settings.ollama_timeout_s) as http:
        for case in ALL_COMPLETION_CASES:
            prompt = build_completion_prompt(case)
            answers, latencies = [], []
            ptoks = None
            for run in range(1, repeats + 1):
                res = await ask(http, settings.ollama_base_url, settings.ollama_model, prompt)
                answers.append(res["answer"])
                latencies.append(res["latency_ms"])
                ptoks = res["prompt_tokens"]
                records.append({
                    "id": case["id"], "category": case["category"], "run": run,
                    "task": case["task"], "expected": case["expected"],
                    "answer": res["answer"], "latency_ms": round(res["latency_ms"]),
                    "prompt_tokens": res["prompt_tokens"], "output_tokens": res["output_tokens"],
                })

            stable = len(set(answers)) == 1
            exp = case["expected"]
            if exp is None:
                verdict = f"n/a (ambiguous)  answers={answers}"
            else:
                hits = sum(1 for a in answers if a == exp)
                verdict = f"{hits}/{repeats} correct"
                if hits < repeats:
                    wrong = "FALSE POSITIVE" if exp is False else "false negative"
                    verdict += f"  <- {wrong}"
            print(f"{case['id']:<5}{case['category']:<20}exp={str(exp):<6}"
                  f"{verdict:<38}{'stable' if stable else 'UNSTABLE':<9}"
                  f"{round(statistics.mean(latencies))}ms  {ptoks}tok")

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": settings.ollama_model,
        "repeats": repeats,
        "temperature": 0.0,
        "records": records,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    print(f"\nrecords: {len(records)} -> {out_path}")
    summarise(records, repeats)


def summarise(records: list[dict], repeats: int) -> None:
    scored = [r for r in records if r["expected"] is not None]
    unparseable = sum(1 for r in records if r["answer"] is None)

    correct = sum(1 for r in scored if r["answer"] == r["expected"])
    # False positive: said complete when it was NOT. The failure that
    # tells a user their order went through when it didn't.
    fp = sum(1 for r in scored if r["expected"] is False and r["answer"] is True)
    fn = sum(1 for r in scored if r["expected"] is True and r["answer"] is False)
    neg = sum(1 for r in scored if r["expected"] is False)
    pos = sum(1 for r in scored if r["expected"] is True)

    by_case: dict[str, list] = collections.defaultdict(list)
    for r in records:
        by_case[r["id"]].append(r["answer"])
    unstable = [cid for cid, ans in by_case.items() if len(set(ans)) > 1]

    lat = [r["latency_ms"] for r in records]
    toks = [r["prompt_tokens"] for r in records if r["prompt_tokens"]]

    print("\n" + "=" * 60)
    print("COMPLETION PROBE SUMMARY")
    print("=" * 60)
    print(f"  scored records (excl. ambiguous) : {len(scored)}")
    print(f"  accuracy                         : {round(100*correct/len(scored),1)}%")
    print(f"  FALSE POSITIVES (said complete   : {fp}/{neg}  ({round(100*fp/neg,1)}% of incomplete cases)")
    print("                   when it wasn't)")
    print(f"  false negatives                  : {fn}/{pos}  ({round(100*fn/pos,1)}% of complete cases)")
    print(f"  unparseable / non-boolean        : {unparseable}")
    print(f"  stability                        : {len(by_case)-len(unstable)}/{len(by_case)} cases identical across {repeats} runs")
    if unstable:
        print(f"  unstable cases                   : {unstable}")
    print(f"  latency mean/median/max          : {round(statistics.mean(lat))}/"
          f"{round(statistics.median(lat))}/{max(lat)} ms")
    if toks:
        print(f"  prompt tokens min/mean/max       : {min(toks)}/{round(statistics.mean(toks))}/{max(toks)}")

    print("\n  per-category accuracy:")
    cats: dict[str, list] = collections.defaultdict(list)
    for r in scored:
        cats[r["category"]].append(r["answer"] == r["expected"])
    for cat, hits in sorted(cats.items()):
        print(f"    {cat:<22}{sum(hits)}/{len(hits)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--out", type=Path, default=RESULTS_DIR / "completion_probe.json")
    args = parser.parse_args()
    asyncio.run(main_async(args.repeats, args.out))


if __name__ == "__main__":
    main()
