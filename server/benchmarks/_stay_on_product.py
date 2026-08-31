"""Does the model stay on the requested product once its page is open?

Element shapes are copied verbatim from the REAL captured product-page
payloads (logs/reason_requests.jsonl, task 4ff26020-…, steps 7-8): the
header chrome, the breadcrumb-style current-product link, and the
"Add to CompareSamsung Galaxy …" recommendation carousel that the live
run kept clicking into.

The one thing added is a purchase control — the element the client's
new custom-control capture is expected to surface. That isolates the
model question ("given the control, does it choose it over the
carousel?") from the capture question.

    PYTHONPATH=. python -m benchmarks._stay_on_product [--repeats 20]
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

ORIGIN = "https://www.flipkart.com"
TASK = "Search for Samsung Galaxy S24 FE and add the first suitable result to the cart."
PRODUCT_PAGE = "Samsung Galaxy S24 Fe 5g Black Colour- Buy Products Online at Best Price in India - All Categories | Flipkart.com"

# Verbatim shapes from the real capture.
HEADER = [
    ("link", "Flipkart"), ("link", "Explore Plus"),
    ("textbox", "Search for products, brands and more"), ("button", None),
    ("link", "Login"), ("link", "Become a Seller"), ("link", "Cart"),
    ("link", "Flights"), ("link", "Offer Zone"), ("link", "Buying Guide"),
]
CAROUSEL = [
    "Currently unavailableAdd to CompareSamsung Galaxy S24+ 5G (Onyx Black, 256 GB)",
    "Add to CompareSamsung Galaxy S24 5G Snapdragon (Onyx Black, 256 GB)",
    "Currently unavailableAdd to CompareSamsung Galaxy A05s (Black, 128 GB)",
    "Add to CompareSamsung M55s (Thunder Black, 128 GB)4.1357 Ratings",
    "Currently unavailableAdd to CompareSamsung Galaxy S24 Ultra 5G (Titanium Black, 256 GB)",
    "Add to CompareSamsung Galaxy S24 Exynos 5G (Onyx Black, 256 GB)",
    "Coming SoonAdd to CompareSamsung Galaxy A50s (Prism Crush Black, 128 GB)",
    "Add to CompareSamsung Galaxy S24+ 5G (Onyx Black, 256 GB)4.5",
    "Currently unavailableAdd to CompareSamsung Galaxy S8 (Midnight Black, 64 GB)",
    "Add to CompareSamsung Galaxy S25 FE 5G (Navy, 128 GB)",
]
FOOTER = ["About Us", "Careers", "Press", "Help Centre", "Payments", "Shipping",
          "Cancellation & Returns", "FAQ", "Terms Of Use", "Security", "Privacy", "Sitemap"]


def product_page(*, purchase: bool, current_label: str = "samsung galaxy s24 fe 5g black colour",
                 carousel: list[str] | None = None) -> tuple[list[dict], int | None, dict]:
    els, nid = [], 1
    for role, label in HEADER:
        els.append({"element_id": nid, "role": role, "label": label}); nid += 1
    els.append({"element_id": nid, "role": "link", "label": current_label}); nid += 1
    buy_id = None
    if purchase:
        buy_id = nid
        els.append({"element_id": nid, "role": "button", "label": "Add to cart"}); nid += 1
        els.append({"element_id": nid, "role": "button", "label": "Buy now"}); nid += 1
    for label in (carousel if carousel is not None else CAROUSEL):
        els.append({"element_id": nid, "role": "link", "label": label}); nid += 1
    for label in FOOTER:
        els.append({"element_id": nid, "role": "link", "label": label}); nid += 1
    return els, buy_id, {e["element_id"]: e["label"] for e in els}


HISTORY = [
    {"step": 1, "action": "type", "element_id": 3,
     "element_label": "Search for products, brands and more", "outcome": "success"},
    {"step": 2, "action": "click", "element_id": 4, "element_label": None, "outcome": "success"},
    {"step": 3, "action": "click", "element_id": 39,
     "element_label": "Samsung Galaxy S24 FE 5G (Blue, 128 GB)", "outcome": "success"},
]


def build_cases():
    els1, buy1, lbl1 = product_page(purchase=True)
    els2, buy2, lbl2 = product_page(purchase=True, carousel=[
        "Add to CompareSamsung Galaxy S24 FE 5G (Mint, 256 GB)",
        "Add to CompareSamsung Galaxy S24 FE 5G (Blue, 128 GB)",
        "Add to CompareSamsung Galaxy S25 FE 5G (Navy, 128 GB)",
        "Add to CompareSamsung Galaxy S24 FE 5G (Graphite, 256 GB)",
    ])
    els4, buy4, lbl4 = product_page(purchase=False)
    els5, buy5, lbl5 = product_page(purchase=True, current_label="apple iphone 15 blue 128 gb",
                                    carousel=["Add to CompareApple iPhone 14 (Midnight, 128 GB)",
                                              "Add to CompareApple iPhone 15 Pro (Titanium, 256 GB)",
                                              "Add to CompareSamsung Galaxy S24 FE 5G (Graphite, 128 GB)"])
    return [
        {"id": "S1-unrelated-recs", "task": TASK, "els": els1, "correct": [buy1, buy1 + 1],
         "lbl": lbl1, "reps": 20, "note": "purchase control + 10 unrelated recs (real shapes)"},
        {"id": "S2-similar-recs", "task": TASK, "els": els2, "correct": [buy2, buy2 + 1],
         "lbl": lbl2, "reps": 20, "note": "recs are OTHER S24 FE variants -- must not switch product"},
        {"id": "S4-no-purchase-control", "task": TASK, "els": els4, "correct": None,
         "lbl": lbl4, "reps": 20, "note": "purchase control ABSENT (today's real situation)"},
        {"id": "S5-different-product", "task": "Search for Apple iPhone 15 and add the first suitable result to the cart.",
         "els": els5, "correct": [buy5, buy5 + 1], "lbl": lbl5, "reps": 10,
         "note": "anti-bias: different requested product"},
    ]


async def run_case(client, case, ) -> dict:
    outs = []
    for i in range(case["reps"]):
        ctx = SanitizedContext(
            task_id=f"stay-{case['id']}-r{i}", task=case["task"], page=PRODUCT_PAGE,
            url_origin=ORIGIN, elements=case["els"], fields={}, history=HISTORY,
        )
        try:
            a = await client.propose_action(ctx)
            outs.append((a.action, a.element_id))
        except ReasoningError:
            outs.append(("REJECTED", None))
    lbl = case["lbl"]
    print(f"\n=== {case['id']} — {case['note']} ===")
    if case["correct"] is None:
        carousel = sum(1 for a, t in outs if "Add to Compare" in str(lbl.get(t, "")))
        print(f"  drifted into recommendation carousel: {carousel}/{case['reps']}")
    else:
        hits = sum(1 for a, t in outs if t in case["correct"] and a == "click")
        carousel = sum(1 for a, t in outs if "Add to Compare" in str(lbl.get(t, "")))
        print(f"  purchase control chosen {hits}/{case['reps']}   carousel drift {carousel}/{case['reps']}")
    for (a, t), n in collections.Counter(outs).most_common(4):
        ok = case["correct"] and t in case["correct"] and a == "click"
        print(f"    {'OK ' if ok else '   '}{n:2d}x {a}:{t}  {str(lbl.get(t, ''))[:56]}")
    return {"id": case["id"], "dist": {f"{a}:{t}": n for (a, t), n in collections.Counter(outs).items()}}


async def main_async(repeats_override, out):
    client = OllamaReasoningClient(settings=load_settings())
    cases = build_cases()
    if repeats_override:
        for c in cases:
            c["reps"] = repeats_override
    res = [await run_case(client, c) for c in cases]
    if out:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=1)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repeats", type=int, default=None)
    p.add_argument("--out", default=None)
    a = p.parse_args()
    asyncio.run(main_async(a.repeats, a.out))


if __name__ == "__main__":
    main()
