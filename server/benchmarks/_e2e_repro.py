"""REAL E2E FIX phase — reproduction harness for the two live blockers.

One-off (underscore-prefixed, not imported by runner.py). Drives the
PRODUCTION path (build_prompt -> OllamaReasoningClient -> validation)
with synthetic contexts that mirror the real Chrome captures, using the
REAL role vocabulary domCapture.ts emits ("textbox"/"button"/"link"),
never the fictional "input:text" the older benchmark fixtures use.

    PYTHONPATH=. python -m benchmarks._e2e_repro [--repeats N]
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import json

from app.config import load_settings
from app.llm.client import OllamaReasoningClient
from app.llm.errors import ReasoningError
from app.models.context import SanitizedContext

ORIGIN = "http://localhost:8000"

# ---------------------------------------------------------------- BLOCKER 1
# Shopping step 1: a storefront landing page. The task's first real step
# is to put the query into the search box. Mirrors the live capture:
# a search textbox, a submit button, nav links, a cart link.
SHOPPING_STEP1 = {
    "id": "E2E-SHOP-1",
    "task": "Search for Samsung Galaxy S24 FE and add the first suitable result to the cart",
    "page": "Online Store",
    "route_hint": "/",
    "elements": [
        {"element_id": 1, "role": "textbox", "label": "Search for products, brands and more"},
        {"element_id": 2, "role": "button", "label": "Search"},
        {"element_id": 3, "role": "link", "label": "Login"},
        {"element_id": 4, "role": "link", "label": "Cart"},
        {"element_id": 5, "role": "link", "label": "Electronics"},
        {"element_id": 6, "role": "link", "label": "Mobiles"},
    ],
    # The correct first step is to TYPE the query into the search box.
    "acceptable": [("type", 1)],
}

# ---------------------------------------------------------------- BLOCKER 2
# "click on travel" against a category nav bar. Travel IS present and
# correctly captured; the model was observed picking something else.
TRAVEL_NAV = [
    {"element_id": 1, "role": "textbox", "label": "Search for products, brands and more"},
    {"element_id": 2, "role": "link", "label": "Login"},
    {"element_id": 3, "role": "link", "label": "Cart"},
    {"element_id": 4, "role": "link", "label": "Grocery"},
    {"element_id": 5, "role": "link", "label": "Mobiles"},
    {"element_id": 6, "role": "link", "label": "Fashion"},
    {"element_id": 7, "role": "link", "label": "Electronics"},
    {"element_id": 8, "role": "link", "label": "Home & Furniture"},
    {"element_id": 9, "role": "link", "label": "Appliances"},
    {"element_id": 10, "role": "link", "label": "Travel"},
    {"element_id": 11, "role": "link", "label": "Beauty, Toys & More"},
]

TRAVEL = {
    "id": "E2E-TRAVEL",
    "task": "click on travel",
    "page": "Online Store",
    "route_hint": "/",
    "elements": TRAVEL_NAV,
    "acceptable": [("click", 10)],
}

# Anti-overfit siblings: the SAME page, a different requested category.
ELECTRONICS = {
    "id": "E2E-ELECTRONICS",
    "task": "click on electronics",
    "page": "Online Store",
    "route_hint": "/",
    "elements": TRAVEL_NAV,
    "acceptable": [("click", 7)],
}

GROCERY = {
    "id": "E2E-GROCERY",
    "task": "open grocery",
    "page": "Online Store",
    "route_hint": "/",
    "elements": TRAVEL_NAV,
    "acceptable": [("click", 4)],
}

CASES = [SHOPPING_STEP1, TRAVEL, ELECTRONICS, GROCERY]


def make_ctx(case: dict, run: int) -> SanitizedContext:
    return SanitizedContext(
        task_id=f"e2e-{case['id']}-r{run}",
        task=case["task"],
        page=case["page"],
        url_origin=ORIGIN,
        elements=case["elements"],
        fields={},
        history=case.get("history", []),
        route_hint=case.get("route_hint"),
    )


async def run_case(client: OllamaReasoningClient, case: dict, repeats: int) -> dict:
    outcomes: list[tuple] = []
    raw_failures: list[str] = []
    for i in range(repeats):
        ctx = make_ctx(case, i + 1)
        try:
            action = await client.propose_action(ctx)
            outcomes.append((action.action, action.element_id, action.value))
        except ReasoningError as exc:
            outcomes.append(("REJECTED", None, None))
            raw_failures.append(f"{exc.code}: {exc.reason}")

    acceptable = {tuple(p) for p in case["acceptable"]}
    hits = sum(1 for a, t, _v in outcomes if (a, t) in acceptable)
    counts = collections.Counter((a, t) for a, t, _v in outcomes)
    print(f"\n=== {case['id']}  task={case['task']!r} ===")
    print(f"  expected: {sorted(acceptable)}")
    print(f"  correct : {hits}/{repeats}")
    for (a, t), n in counts.most_common():
        print(f"    {n:2d}x  action={a!r} element_id={t}")
    for f in dict.fromkeys(raw_failures):
        print(f"    rejection: {f}")
    return {"id": case["id"], "correct": hits, "of": repeats,
            "distribution": {f"{a}:{t}": n for (a, t), n in counts.items()},
            "rejections": list(dict.fromkeys(raw_failures))}


async def main_async(repeats: int, out_path: str | None) -> None:
    client = OllamaReasoningClient(settings=load_settings())
    results = [await run_case(client, case, repeats) for case in CASES]
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=1)
        print(f"\n-> {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=10)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    asyncio.run(main_async(args.repeats, args.out))


if __name__ == "__main__":
    main()
