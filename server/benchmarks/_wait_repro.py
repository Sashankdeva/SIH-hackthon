"""REAL E2E — why does the model spend steps on `wait`?

Decision procedure (from the phase brief): do NOT blame the model until
the context is confirmed to contain useful controls. So case A measures
the exact question — with an actionable primary control PRESENT on a
realistic product page, how often does the model still answer `wait`?

B/C establish that wait stays available when it is genuinely correct,
D/E that unrelated behaviour is unchanged.

    PYTHONPATH=. python -m benchmarks._wait_repro [--repeats 20]
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
TASK = "Search for Samsung Galaxy S24 FE and add the first suitable result to the cart"

# History mirroring the real run: the search was typed and results were
# opened, all verified successful, before the product page was reached.
PRODUCT_HISTORY = [
    {"step": 1, "action": "type", "element_id": 1,
     "element_label": "Search for products, brands and more", "outcome": "success"},
    {"step": 2, "action": "click", "element_id": 2, "element_label": "Search", "outcome": "success"},
    {"step": 3, "action": "click", "element_id": 5,
     "element_label": "Samsung Galaxy S24 FE 5G (Graphite, 128 GB)", "outcome": "success"},
]

# A — the product page as it looks once loaded: the primary control IS
# present, alongside ordinary distractors.
PRODUCT_LOADED = [
    {"element_id": 10, "role": "button", "label": "Add to Cart"},
    {"element_id": 11, "role": "button", "label": "Buy Now"},
    {"element_id": 12, "role": "link", "label": "Samsung Galaxy S24 FE 5G (Graphite, 128 GB)"},
    {"element_id": 13, "role": "link", "label": "Read all reviews"},
    {"element_id": 14, "role": "link", "label": "Cart"},
    {"element_id": 15, "role": "button", "label": "Add to Compare"},
    {"element_id": 16, "role": "link", "label": "Seller details"},
]

# B — nothing actionable at all (the empty-capture case).
NOTHING = []

# C — page genuinely mid-load: only a disabled control and a spinner.
LOADING = [
    {"element_id": 20, "role": "button", "label": "Add to Cart", "disabled": True},
    {"element_id": 21, "role": "link", "label": "Loading…"},
]

# D — ambiguous: two equally plausible primary controls.
AMBIGUOUS = [
    {"element_id": 30, "role": "button", "label": "Add to Cart"},
    {"element_id": 31, "role": "button", "label": "Add to Cart"},
    {"element_id": 32, "role": "link", "label": "Home"},
]

# E — unrelated navigation context, no history.
NAV = [
    {"element_id": 40, "role": "link", "label": "Grocery"},
    {"element_id": 41, "role": "link", "label": "Electronics"},
    {"element_id": 42, "role": "link", "label": "Travel"},
]

CASES = [
    {"id": "A-actionable-present", "task": TASK, "elements": PRODUCT_LOADED,
     "history": PRODUCT_HISTORY, "route": "/product/s24fe",
     "expect": "a click on the primary control; wait should be RARE"},
    {"id": "B-nothing-actionable", "task": TASK, "elements": NOTHING,
     "history": PRODUCT_HISTORY, "route": "/product/s24fe",
     "expect": "wait remains VALID"},
    {"id": "C-page-loading", "task": TASK, "elements": LOADING,
     "history": PRODUCT_HISTORY, "route": "/product/s24fe",
     "expect": "wait remains VALID"},
    {"id": "D-ambiguous", "task": TASK, "elements": AMBIGUOUS,
     "history": PRODUCT_HISTORY, "route": "/product/s24fe",
     "expect": "existing safe behaviour preserved"},
    {"id": "E-unrelated-nav", "task": "click on electronics", "elements": NAV,
     "history": [], "route": "/",
     "expect": "existing behaviour preserved"},
]


def make_ctx(case: dict, run: int) -> SanitizedContext:
    return SanitizedContext(
        task_id=f"wait-{case['id']}-r{run}", task=case["task"], page="Online Store",
        url_origin=ORIGIN, elements=case["elements"], fields={},
        history=case["history"], route_hint=case["route"],
    )


async def run_case(client, case: dict, repeats: int) -> dict:
    outs = []
    for i in range(repeats):
        try:
            a = await client.propose_action(make_ctx(case, i + 1))
            outs.append((a.action, a.element_id))
        except ReasoningError as exc:
            outs.append(("REJECTED", exc.code))
    waits = sum(1 for a, _ in outs if a == "wait")
    c = collections.Counter(outs)
    lbl = {e["element_id"]: e["label"] for e in case["elements"]}
    print(f"\n=== {case['id']}  ({case['expect']}) ===")
    print(f"  wait: {waits}/{repeats}")
    for (a, t), n in c.most_common():
        print(f"    {n:2d}x {a}:{t}  {lbl.get(t, '')}")
    return {"id": case["id"], "waits": waits, "of": repeats,
            "dist": {f"{a}:{t}": n for (a, t), n in c.items()}}


async def main_async(repeats: int, out: str | None) -> None:
    client = OllamaReasoningClient(settings=load_settings())
    res = [await run_case(client, c, repeats) for c in CASES]
    if out:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=1)
        print(f"\n-> {out}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repeats", type=int, default=20)
    p.add_argument("--out", default=None)
    a = p.parse_args()
    asyncio.run(main_async(a.repeats, a.out))


if __name__ == "__main__":
    main()
