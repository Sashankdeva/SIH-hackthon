"""Product-identity selection on a results page.

Live failure: asked for "Samsung Galaxy S24 FE", the agent clicked the
FIRST visible product ("Samsung Galaxy S24+ 5G") instead of the one
that actually matches.

Label shapes are copied from the REAL captured payloads
(logs/reason_requests.jsonl, task 4ff26020-…): on the live site a
product's accessible name arrives as one concatenated string, often
prefixed "Currently unavailable" / "Add to Compare" and suffixed with
ratings — e.g.
  'Currently unavailableAdd to CompareSamsung Galaxy S24 Ultra 5G (…'
so identity has to be recovered from a messy label, not a clean title.

    PYTHONPATH=. python -m benchmarks._product_identity [--repeats 20]
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

CHROME = [
    ("link", "Flipkart"), ("link", "Explore Plus"),
    ("textbox", "Search for products, brands and more"), ("button", None),
    ("link", "Login"), ("link", "Become a Seller"), ("link", "Cart"),
    ("link", "Flights"), ("link", "Offer Zone"), ("link", "Grocery"),
    ("link", "Mobiles"), ("link", "Fashion"), ("link", "Electronics"),
]
FOOTER = ["About Us", "Careers", "Press", "Help Centre", "Payments", "Shipping",
          "Cancellation & Returns", "FAQ", "Terms Of Use", "Security", "Privacy",
          "Sitemap", "Grievance Redressal", "EPR Compliance", "Advertise", "Gift Cards"]


def build(order: list[tuple[str, str]]) -> tuple[list[dict], int, dict]:
    """order = [(kind, label)]; kind 'target' marks the correct product."""
    els, nid = [], 1
    for role, label in CHROME:
        els.append({"element_id": nid, "role": role, "label": label}); nid += 1
    for label in ["Sponsored: Best 5G phones under 40k", "Sort by Popularity",
                  "Sort by Price -- Low to High", "Filter by Brand"]:
        els.append({"element_id": nid, "role": "link", "label": label}); nid += 1
    target_id = None
    for kind, label in order:
        if kind == "target":
            target_id = nid
        els.append({"element_id": nid, "role": "link", "label": label}); nid += 1
    for label in FOOTER:
        els.append({"element_id": nid, "role": "link", "label": label}); nid += 1
    labels = {e["element_id"]: e["label"] for e in els}
    return els, target_id, labels


# Mirrors the live page: the WRONG variant is first, correct one later.
RESULTS_ORDER = [
    ("wrong", "Add to CompareSamsung Galaxy S24+ 5G (Onyx Black, 512 GB)4.5(12,431 Ratings)"),
    ("wrong", "Add to CompareSamsung Galaxy S24 Ultra 5G (Titanium Black, 256 GB)4.6(8,102 Ratings)"),
    ("wrong", "Currently unavailableAdd to CompareSamsung Galaxy S23 FE 5G (Purple, 128 GB)4.3(5,551 Ratings)"),
    ("wrong", "Add to CompareSamsung Galaxy S24 5G Snapdragon (Onyx Black, 256 GB)4.5(9,004 Ratings)"),
    ("target", "Add to CompareSamsung Galaxy S24 FE 5G (Graphite, 128 GB)4.4(4,821 Ratings)"),
    ("wrong", "Add to CompareSamsung Galaxy S24+ 5G (Marble Grey, 256 GB)4.5(3,110 Ratings)"),
    ("wrong", "Add to CompareSamsung Galaxy M55s (Thunder Black, 128 GB)4.1(357 Ratings)"),
]

# Same page, but the ONLY exact match is flagged unavailable.
UNAVAILABLE_ORDER = [
    ("wrong", "Add to CompareSamsung Galaxy S24+ 5G (Onyx Black, 512 GB)4.5(12,431 Ratings)"),
    ("wrong", "Add to CompareSamsung Galaxy S24 Ultra 5G (Titanium Black, 256 GB)4.6(8,102 Ratings)"),
    ("target", "Currently unavailableAdd to CompareSamsung Galaxy S24 FE 5G (Graphite, 128 GB)4.4(4,821 Ratings)"),
    ("wrong", "Add to CompareSamsung Galaxy S24 5G Snapdragon (Onyx Black, 256 GB)4.5(9,004 Ratings)"),
]

# Control: exact match IS first — must not regress.
FIRST_ORDER = [
    ("target", "Add to CompareSamsung Galaxy S24 FE 5G (Graphite, 128 GB)4.4(4,821 Ratings)"),
    ("wrong", "Add to CompareSamsung Galaxy S24+ 5G (Onyx Black, 512 GB)4.5(12,431 Ratings)"),
    ("wrong", "Add to CompareSamsung Galaxy S24 Ultra 5G (Titanium Black, 256 GB)4.6(8,102 Ratings)"),
]

# Different requested product entirely — anti-overfit.
OTHER_TASK = "Search for Samsung Galaxy S24 Ultra and add the first suitable result to the cart."
OTHER_ORDER = [
    ("wrong", "Add to CompareSamsung Galaxy S24 FE 5G (Graphite, 128 GB)4.4(4,821 Ratings)"),
    ("wrong", "Add to CompareSamsung Galaxy S24+ 5G (Onyx Black, 512 GB)4.5(12,431 Ratings)"),
    ("target", "Add to CompareSamsung Galaxy S24 Ultra 5G (Titanium Black, 256 GB)4.6(8,102 Ratings)"),
]

HISTORY = [
    {"step": 1, "action": "type", "element_id": 3,
     "element_label": "Search for products, brands and more", "outcome": "success"},
    {"step": 2, "action": "click", "element_id": 4, "element_label": None, "outcome": "success"},
]

CASES = [
    {"id": "P1-wrong-variant-first", "task": TASK, "order": RESULTS_ORDER,
     "note": "S24+ first, exact S24 FE is 5th -- the live failure"},
    {"id": "P2-exact-first", "task": TASK, "order": FIRST_ORDER,
     "note": "control: exact match already first"},
    {"id": "P3-exact-unavailable", "task": TASK, "order": UNAVAILABLE_ORDER,
     "note": "only exact match is flagged unavailable"},
    {"id": "P4-different-product", "task": OTHER_TASK, "order": OTHER_ORDER,
     "note": "anti-overfit: asks for S24 Ultra, which is last"},
]


async def run_case(client, case: dict, repeats: int) -> dict:
    els, target, labels = build(case["order"])
    outs = []
    for i in range(repeats):
        ctx = SanitizedContext(
            task_id=f"pid-{case['id']}-r{i}", task=case["task"],
            page="Samsung Galaxy S24 Fe 5g - Buy Products Online at Best Price in India",
            url_origin=ORIGIN, elements=els, fields={}, history=HISTORY,
        )
        try:
            a = await client.propose_action(ctx)
            outs.append((a.action, a.element_id))
        except ReasoningError:
            outs.append(("REJECTED", None))
    hits = sum(1 for a, t in outs if t == target and a == "click")
    print(f"\n=== {case['id']} — {case['note']} ===")
    print(f"  correct(exact product id={target}) {hits}/{repeats}")
    for (a, t), n in collections.Counter(outs).most_common(5):
        mark = "OK " if (t == target and a == "click") else "   "
        print(f"    {mark}{n:2d}x {a}:{t}  {str(labels.get(t, ''))[:58]}")
    return {"id": case["id"], "correct": hits, "of": repeats, "target": target}


async def main_async(repeats: int, out: str | None) -> None:
    client = OllamaReasoningClient(settings=load_settings())
    res = [await run_case(client, c, repeats) for c in CASES]
    print("\nSUMMARY")
    for r in res:
        print(f"  {r['id']:26s} {r['correct']:2d}/{r['of']}")
    if out:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=1)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repeats", type=int, default=20)
    p.add_argument("--out", default=None)
    a = p.parse_args()
    asyncio.run(main_async(a.repeats, a.out))


if __name__ == "__main__":
    main()
