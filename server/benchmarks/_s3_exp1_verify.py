"""One-off verification script for SERVER PHASE S3 experiment 1.

Not part of the permanent benchmark suite (underscore-prefixed, not
imported by runner.py). Exists only to settle whether rule 12 (the
scroll-vs-click fix) causally destabilized case C2, or whether that was
independent temp=0 noise the N=3 frozen baseline just hadn't surfaced
yet. Runs C2 (the case that wobbled) and G1/G2 (the cases rule 12 fixed)
10x each, under the CURRENT prompt (with rule 12) and under the
ORIGINAL prompt (rule 12 stripped back out via a module-level patch, not
a file edit) — same process, same Ollama connection, so nothing else
differs between the two conditions.
"""

import asyncio
import json

from app.config import load_settings
from app.llm import prompt as prompt_mod
from app.llm.client import OllamaReasoningClient
from app.llm.validation import build_validated_action
from app.llm.errors import ReasoningError
from app.models.context import SanitizedContext
from benchmarks.dataset import FORM_FILLING, SCROLLING

ORIGINAL_RULES = prompt_mod._RULES
WITHOUT_RULE_12 = ORIGINAL_RULES.split('\n12. If the task literally')[0] + '"""'

CASES = {c["id"]: c for c in FORM_FILLING + SCROLLING}
TARGETS = ["C2", "G1", "G2"]


def make_ctx(case, i):
    return SanitizedContext(
        task_id=f"verify-{case['id']}-{i}", task=case["task"], page=case.get("page", "Benchmark page"),
        url_origin="http://localhost:8000", elements=case["elements"], fields=case["fields"],
    )


async def run_condition(label: str, repeats: int) -> dict:
    client = OllamaReasoningClient(settings=load_settings())
    results = {cid: [] for cid in TARGETS}
    for cid in TARGETS:
        case = CASES[cid]
        for i in range(repeats):
            ctx = make_ctx(case, i)
            raw = await client._generate(prompt_mod.build_prompt(ctx))
            data = None
            try:
                data = client._parse_json(raw)
                action = build_validated_action(data, ctx)
                acc, tgt = action.action, action.element_id
                ok = [acc, tgt] in case["acceptable"]
            except ReasoningError:
                acc = data.get("action") if data else None
                tgt = data.get("element_id") if data else None
                ok = False
            results[cid].append((acc, tgt, ok))
        print(f"{label} {cid}: {results[cid]}")
    return results


async def main():
    repeats = 10
    print(f"=== WITH rule 12 (current file), {repeats}x each ===")
    with_rule = await run_condition("WITH", repeats)

    prompt_mod._RULES = WITHOUT_RULE_12
    print(f"\n=== WITHOUT rule 12 (patched back out), {repeats}x each ===")
    without_rule = await run_condition("WITHOUT", repeats)
    prompt_mod._RULES = ORIGINAL_RULES

    def stability(results):
        out = {}
        for cid, runs in results.items():
            pairs = {(a, t) for a, t, ok in runs}
            correct = sum(1 for a, t, ok in runs if ok)
            out[cid] = {"distinct_outputs": len(pairs), "correct": correct, "of": len(runs)}
        return out

    summary = {"with_rule_12": stability(with_rule), "without_rule_12": stability(without_rule)}
    print("\n" + json.dumps(summary, indent=1))
    with open("benchmarks/results/s3_exp1_verify.json", "w", encoding="utf-8") as f:
        json.dump({"with_rule_12": with_rule, "without_rule_12": without_rule, "summary": summary}, f, indent=1)


if __name__ == "__main__":
    asyncio.run(main())
