"""Paired A/B probe: does the `disabled` marker change model behaviour?

The core benchmark cannot answer this — none of its 32 cases contain a
disabled element, and prompts for them are byte-identical before and
after the field was added. So this probe supplies the missing variable.

Method: each scenario is run TWICE against the real model with contexts
that differ in EXACTLY one respect — whether the gated control carries
`disabled=true`. Everything else (task, labels, ids, roles, order) is
identical, so a behavioural difference is attributable to the marker
alone.

    cd server
    PYTHONPATH=. python -m benchmarks.availability_probe --repeats 5

Scenarios are generic UI shapes — a primary action gated behind a
prerequisite — not a product, site, or workflow. Each also has a CONTROL
variant where nothing is disabled, to check the marker does not cause
over-avoidance of a control that is genuinely available.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import time

from app.config import load_settings
from app.llm.client import OllamaReasoningClient
from app.llm.errors import ReasoningError
from app.models.context import SanitizedContext

ORIGIN = "http://localhost:8000"

#: Each scenario: the page, the task, the id of the gated control, and
#: the ids that are legitimate next steps while it is gated.
SCENARIOS = [
    {
        "id": "AV1-options",
        "task": "add the item to the cart",
        "page": "Product detail",
        "gated_id": 4,
        "good_ids": [1, 2, 3],
        "elements": [
            {"element_id": 1, "role": "button", "label": "128GB"},
            {"element_id": 2, "role": "button", "label": "256GB"},
            {"element_id": 3, "role": "button", "label": "512GB"},
            {"element_id": 4, "role": "button", "label": "Add to Cart"},
            {"element_id": 5, "role": "link", "label": "Back to listing"},
        ],
    },
    {
        "id": "AV2-form",
        "task": "submit the form",
        "page": "Contact form",
        "gated_id": 3,
        "good_ids": [1, 2],
        "elements": [
            {"element_id": 1, "role": "input:text", "label": "Full name"},
            {"element_id": 2, "role": "input:text", "label": "Message"},
            {"element_id": 3, "role": "button", "label": "Submit"},
            {"element_id": 4, "role": "link", "label": "Cancel"},
        ],
    },
    {
        "id": "AV3-wizard",
        "task": "continue to the next step",
        "page": "Setup wizard",
        "gated_id": 3,
        "good_ids": [1, 2],
        "elements": [
            {"element_id": 1, "role": "button", "label": "Standard plan"},
            {"element_id": 2, "role": "button", "label": "Premium plan"},
            {"element_id": 3, "role": "button", "label": "Next"},
            {"element_id": 4, "role": "link", "label": "Back"},
        ],
    },
]


def make_ctx(scenario: dict, mark_disabled: bool, run: int) -> SanitizedContext:
    elements = []
    for el in scenario["elements"]:
        item = dict(el)
        if mark_disabled and item["element_id"] == scenario["gated_id"]:
            item["disabled"] = True
        elements.append(item)
    return SanitizedContext(
        task_id=f"avprobe-{scenario['id']}-{'marked' if mark_disabled else 'unmarked'}-r{run}",
        task=scenario["task"],
        page=scenario["page"],
        url_origin=ORIGIN,
        elements=elements,
        fields={},
    )


async def run_variant(client: OllamaReasoningClient, scenario: dict, marked: bool, repeats: int) -> dict:
    picks: list[str] = []
    latencies: list[float] = []
    for run in range(1, repeats + 1):
        ctx = make_ctx(scenario, marked, run)
        t0 = time.perf_counter()
        try:
            action = await client.propose_action(ctx)
            picks.append(f"{action.action}/{action.element_id}")
        except ReasoningError as exc:
            picks.append(f"REFUSED:{exc.code}")
        latencies.append((time.perf_counter() - t0) * 1000)

    gated = f"click/{scenario['gated_id']}"
    hit_gated = sum(1 for p in picks if p == gated)
    hit_good = sum(1 for p in picks if p.startswith("click/") and
                   p.split("/")[1].isdigit() and int(p.split("/")[1]) in scenario["good_ids"])
    return {
        "picks": picks,
        "distribution": dict(collections.Counter(picks)),
        "chose_gated": hit_gated,
        "chose_prerequisite": hit_good,
        "mean_ms": round(sum(latencies) / len(latencies)),
    }


async def main_async(repeats: int) -> None:
    settings = load_settings()
    client = OllamaReasoningClient(settings=settings)
    print(f"model={settings.ollama_model}  repeats={repeats}\n")
    print(f"{'scenario':<14}{'variant':<12}{'chose gated':<13}{'chose prereq':<14}{'distribution'}")
    print("-" * 88)

    totals = {"unmarked_gated": 0, "marked_gated": 0, "n": 0}
    for scenario in SCENARIOS:
        for marked in (False, True):
            res = await run_variant(client, scenario, marked, repeats)
            label = "disabled=true" if marked else "unmarked"
            print(f"{scenario['id']:<14}{label:<12}{res['chose_gated']}/{repeats:<11}"
                  f"{res['chose_prerequisite']}/{repeats:<12}{res['distribution']}")
            if marked:
                totals["marked_gated"] += res["chose_gated"]
            else:
                totals["unmarked_gated"] += res["chose_gated"]
        totals["n"] += repeats
        print()

    print("-" * 88)
    print(f"gated control chosen  WITHOUT marker: {totals['unmarked_gated']}/{totals['n']}")
    print(f"gated control chosen  WITH    marker: {totals['marked_gated']}/{totals['n']}")

    # CONTROL: nothing disabled anywhere — the primary action is genuinely
    # available and SHOULD be chosen. Guards against over-avoidance.
    print("\nCONTROL (nothing disabled; the gated control is legitimately the right answer):")
    control = {
        "id": "AV-control",
        "task": "submit the form",
        "page": "Contact form (already filled in)",
        "gated_id": 3,
        "good_ids": [3],
        "elements": [
            {"element_id": 1, "role": "input:text", "label": "Full name (completed)"},
            {"element_id": 2, "role": "input:text", "label": "Message (completed)"},
            {"element_id": 3, "role": "button", "label": "Submit"},
            {"element_id": 4, "role": "link", "label": "Cancel"},
        ],
    }
    res = await run_variant(client, control, False, repeats)
    print(f"  chose Submit (id 3): {res['chose_gated']}/{repeats}   distribution: {res['distribution']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    asyncio.run(main_async(args.repeats))


if __name__ == "__main__":
    main()
