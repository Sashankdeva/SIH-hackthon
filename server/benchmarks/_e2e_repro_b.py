"""REAL E2E FIX phase — harder Part B (navigation target) reproduction.

The simple 11-element nav bar in _e2e_repro.py did NOT reproduce the
live "click on travel" mis-target (10/10 correct). Real storefront
captures are far larger and carry step history from the repeated
attempts. These cases add the three realistic differences, one at a
time, so whichever one actually triggers the failure is identifiable
rather than guessed at.

Run against the UNMODIFIED prompt first to establish reproduction.

    PYTHONPATH=. python -m benchmarks._e2e_repro_b [--repeats N]
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

CATEGORIES = [
    "Grocery", "Mobiles", "Fashion", "Electronics", "Home & Furniture",
    "Appliances", "Travel", "Beauty, Toys & More", "Two Wheelers",
]

def _storefront(n_products: int = 40, n_footer: int = 30) -> list[dict]:
    """A realistic large storefront capture: chrome + category bar +
    product tiles + footer link farm. Travel sits in the category bar,
    exactly as captured live."""
    els: list[dict] = []
    nid = 1

    def add(role: str, label: str) -> None:
        nonlocal nid
        els.append({"element_id": nid, "role": role, "label": label})
        nid += 1

    add("textbox", "Search for products, brands and more")
    add("button", "Search")
    add("link", "Login")
    add("link", "Become a Seller")
    add("link", "More")
    add("link", "Cart")
    for c in CATEGORIES:
        add("link", c)
    for i in range(n_products):
        add("link", f"Product {i + 1} — great value, limited time offer")
        add("button", "Add to Cart")
    for i in range(n_footer):
        add("link", f"Footer link {i + 1}")
    return els


STOREFRONT = _storefront()
TRAVEL_ID = next(e["element_id"] for e in STOREFRONT if e["label"] == "Travel")
ELECTRONICS_ID = next(e["element_id"] for e in STOREFRONT if e["label"] == "Electronics")

# Travel duplicated in the footer — genuine ambiguity, either is defensible.
STOREFRONT_DUP = STOREFRONT + [
    {"element_id": 9001, "role": "link", "label": "Travel"},
]

CASES = [
    {
        "id": "B-LARGE",
        "task": "click on travel",
        "page": "Online Store",
        "route_hint": "/",
        "elements": STOREFRONT,
        "acceptable": [("click", TRAVEL_ID)],
        "note": "~130 elements, Travel buried in the category bar",
    },
    {
        "id": "B-LARGE-HISTORY",
        "task": "click on travel",
        "page": "Online Store",
        "route_hint": "/",
        "elements": STOREFRONT,
        "history": [
            {"step": 1, "action": "click", "element_id": ELECTRONICS_ID,
             "element_label": "Electronics", "outcome": "ambiguous"},
        ],
        "acceptable": [("click", TRAVEL_ID)],
        "note": "same, but a prior wrong attempt is in history (the repeat scenario)",
    },
    {
        "id": "B-LARGE-DUP",
        "task": "click on travel",
        "page": "Online Store",
        "route_hint": "/",
        "elements": STOREFRONT_DUP,
        "acceptable": [("click", TRAVEL_ID), ("click", 9001)],
        "note": "Travel appears twice — either is defensible",
    },
    {
        "id": "B-LARGE-ELECTRONICS",
        "task": "click on electronics",
        "page": "Online Store",
        "route_hint": "/",
        "elements": STOREFRONT,
        "acceptable": [("click", ELECTRONICS_ID)],
        "note": "anti-overfit sibling on the same large page",
    },
]


def make_ctx(case: dict, run: int) -> SanitizedContext:
    return SanitizedContext(
        task_id=f"e2eb-{case['id']}-r{run}",
        task=case["task"], page=case["page"], url_origin=ORIGIN,
        elements=case["elements"], fields={},
        history=case.get("history", []), route_hint=case.get("route_hint"),
    )


async def run_case(client, case: dict, repeats: int) -> dict:
    outcomes, rejections = [], []
    for i in range(repeats):
        try:
            a = await client.propose_action(make_ctx(case, i + 1))
            outcomes.append((a.action, a.element_id))
        except ReasoningError as exc:
            outcomes.append(("REJECTED", None))
            rejections.append(f"{exc.code}: {exc.reason}")

    acceptable = {tuple(p) for p in case["acceptable"]}
    hits = sum(1 for o in outcomes if o in acceptable)
    counts = collections.Counter(outcomes)
    label_by_id = {e["element_id"]: e["label"] for e in case["elements"]}
    print(f"\n=== {case['id']} — {case['note']} ===")
    print(f"  task={case['task']!r}  expected={sorted(acceptable)}  correct={hits}/{repeats}")
    for (a, t), n in counts.most_common():
        lbl = label_by_id.get(t, "")
        print(f"    {n:2d}x  {a!r} id={t} {('label=' + repr(lbl)) if lbl else ''}")
    for r in dict.fromkeys(rejections):
        print(f"    rejection: {r}")
    return {"id": case["id"], "correct": hits, "of": repeats,
            "distribution": {f"{a}:{t}": n for (a, t), n in counts.items()}}


async def main_async(repeats: int, out_path: str | None) -> None:
    client = OllamaReasoningClient(settings=load_settings())
    results = [await run_case(client, c, repeats) for c in CASES]
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=1)
        print(f"\n-> {out_path}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repeats", type=int, default=10)
    p.add_argument("--out", default=None)
    a = p.parse_args()
    asyncio.run(main_async(a.repeats, a.out))


if __name__ == "__main__":
    main()
