"""Task-scoped product selection on Amazon-shaped pages.

Reported symptom: the agent sees real "Add to Cart" controls and adds
MULTIPLE products instead of only the requested one.

Structural note that shapes every case here: SanitizedContext is a FLAT
list of (element_id, role, label). It carries no grouping, nesting, or
parent-product information — so several "Add to Cart" buttons on one
page are, to the model, IDENTICAL labels distinguished only by their
element_id and their ORDER in the list. Whether that is enough to scope
a purchase to one product is exactly what these cases measure.

    PYTHONPATH=. python -m benchmarks._amazon_scope [--repeats 15]
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

ORIGIN = "https://www.amazon.in"
TASK = "Search for Samsung Galaxy S24 FE and add the first suitable result to the cart."
TARGET = "Samsung Galaxy S24 FE 5G (Graphite, 128GB)"

CHROME = [("link", "Amazon"), ("textbox", "Search Amazon.in"), ("button", "Go"),
          ("link", "Hello, sign in Account & Lists"), ("link", "Returns & Orders"), ("link", "Cart")]


def _add(els, nid, role, label):
    els.append({"element_id": nid, "role": role, "label": label})
    return nid + 1


def results_page():
    """Search results: several products, each with its own Add to Cart."""
    els, nid = [], 1
    for role, label in CHROME:
        nid = _add(els, nid, role, label)
    nid = _add(els, nid, "link", "Sponsored Samsung Galaxy S23 FE 5G (Mint, 128GB)")
    sponsored_cart = nid
    nid = _add(els, nid, "button", "Add to Cart")
    target_link = nid
    nid = _add(els, nid, "link", TARGET)
    target_cart = nid
    nid = _add(els, nid, "button", "Add to Cart")
    for label in ["Samsung Galaxy S24 Ultra 5G (Titanium, 256GB)",
                  "Samsung Galaxy S23 FE 5G (Purple, 128GB)",
                  "Samsung Galaxy S24+ 5G (Onyx, 256GB)"]:
        nid = _add(els, nid, "link", label)
        nid = _add(els, nid, "button", "Add to Cart")
    return els, {"target_link": target_link, "target_cart": target_cart,
                 "sponsored_cart": sponsored_cart}


def product_page():
    """Product detail page for the requested item, with the usual
    recommendation blocks that also carry Add to Cart controls."""
    els, nid = [], 1
    for role, label in CHROME:
        nid = _add(els, nid, role, label)
    nid = _add(els, nid, "link", TARGET)
    nid = _add(els, nid, "button", "128GB")
    nid = _add(els, nid, "button", "256GB")
    main_cart = nid
    nid = _add(els, nid, "button", "Add to Cart")
    nid = _add(els, nid, "button", "Buy Now")
    # Frequently bought together
    nid = _add(els, nid, "link", "Frequently bought together")
    fbt_cart = nid
    nid = _add(els, nid, "button", "Add both to Cart")
    # Customers also bought — each with its own Add to Cart
    rec_carts = []
    for label in ["Samsung Galaxy S23 FE 5G (Mint, 128GB)",
                  "Samsung 25W Charger",
                  "Screen Protector for Galaxy S24 FE"]:
        nid = _add(els, nid, "link", "Customers who bought this item also bought: " + label)
        rec_carts.append(nid)
        nid = _add(els, nid, "button", "Add to Cart")
    nid = _add(els, nid, "link", "Sponsored Samsung Galaxy S24 Ultra 5G")
    sponsored_cart = nid
    nid = _add(els, nid, "button", "Add to Cart")
    for label in ["Customer reviews", "Product details", "Back to top"]:
        nid = _add(els, nid, "link", label)
    return els, {"main_cart": main_cart, "fbt_cart": fbt_cart,
                 "rec_carts": rec_carts, "sponsored_cart": sponsored_cart}


RES_ELS, RES = results_page()
PROD_ELS, PROD = product_page()

SEARCH_HISTORY = [
    {"step": 1, "action": "type", "element_id": 2, "element_label": "Search Amazon.in", "outcome": "success"},
    {"step": 2, "action": "click", "element_id": 3, "element_label": "Go", "outcome": "success"},
]
OPENED = SEARCH_HISTORY + [
    {"step": 3, "action": "click", "element_id": RES["target_link"],
     "element_label": TARGET, "outcome": "success"},
]
ADDED = OPENED + [
    {"step": 4, "action": "click", "element_id": PROD["main_cart"],
     "element_label": "Add to Cart", "outcome": "success"},
]
ADDED_AMBIGUOUS = OPENED + [
    {"step": 4, "action": "click", "element_id": PROD["main_cart"],
     "element_label": "Add to Cart", "outcome": "ambiguous"},
]
ADDED_AMBIG_X3 = OPENED + [
    {"step": s, "action": "click", "element_id": PROD["main_cart"],
     "element_label": "Add to Cart", "outcome": "ambiguous"} for s in (4, 5, 6)
]

CASES = [
    {"id": "A-results-5-products", "els": RES_ELS, "history": SEARCH_HISTORY,
     "page": "Amazon.in : samsung galaxy s24 fe", "route": "/s?k=samsung+galaxy+s24+fe",
     "ok": {RES["target_link"], RES["target_cart"]},
     "bad_name": "other product's cart/link",
     "note": "5 products each with Add to Cart -> only requested product"},
    {"id": "B-product-page-recs", "els": PROD_ELS, "history": OPENED,
     "page": "Amazon.in: " + TARGET, "route": "/dp/B0CT2PQ1RS",
     "ok": {PROD["main_cart"]},
     "bad_name": "recommendation / sponsored / FBT cart",
     "note": "main Add to Cart vs 3 rec + 1 sponsored + FBT carts"},
    {"id": "E-after-successful-add", "els": PROD_ELS, "history": ADDED,
     "page": "Amazon.in: " + TARGET, "route": "/dp/B0CT2PQ1RS",
     "ok": None,  # scored specially: must NOT click another cart
     "bad_name": "any further Add to Cart",
     "note": "already added successfully -> must not add anything else"},
    {"id": "F-ambiguous-add-once", "els": PROD_ELS, "history": ADDED_AMBIGUOUS,
     "page": "Amazon.in: " + TARGET, "route": "/dp/B0CT2PQ1RS",
     "ok": None,
     "bad_name": "repeat/other cart",
     "note": "one ambiguous add -> should not blindly repeat"},
    {"id": "F2-ambiguous-x3", "els": PROD_ELS, "history": ADDED_AMBIG_X3,
     "page": "Amazon.in: " + TARGET, "route": "/dp/B0CT2PQ1RS",
     "ok": None,
     "bad_name": "repeat/other cart",
     "note": "three ambiguous adds -> must not keep repeating"},
]

ALL_CART_IDS = {PROD["main_cart"], PROD["fbt_cart"], PROD["sponsored_cart"], *PROD["rec_carts"]}


async def run_case(client, case, repeats):
    lbl = {e["element_id"]: e["label"] for e in case["els"]}
    outs = []
    for i in range(repeats):
        ctx = SanitizedContext(
            task_id=f"amz-{case['id']}-{i}", task=TASK, page=case["page"], url_origin=ORIGIN,
            elements=case["els"], fields={}, history=case["history"], route_hint=case["route"])
        try:
            a = await client.propose_action(ctx)
            outs.append((a.action, a.element_id))
        except ReasoningError as e:
            outs.append(("REJECTED", e.code))
    print(f"\n=== {case['id']} — {case['note']} ===")
    if case["ok"] is not None:
        good = sum(1 for a, t in outs if t in case["ok"])
        print(f"  correct(requested product only): {good}/{repeats}")
    else:
        extra = sum(1 for a, t in outs if t in ALL_CART_IDS)
        done = sum(1 for a, t in outs if a == "done")
        cartnav = sum(1 for a, t in outs if str(lbl.get(t, "")) == "Cart")
        print(f"  further purchase clicks: {extra}/{repeats}   done: {done}   cart-nav: {cartnav}")
    for (a, t), n in collections.Counter(outs).most_common(4):
        print(f"    {n:2d}x {a}:{t}  {str(lbl.get(t, ''))[:52]}")
    return {"id": case["id"], "dist": {f"{a}:{t}": n for (a, t), n in collections.Counter(outs).items()}}


async def main_async(repeats, out):
    client = OllamaReasoningClient(settings=load_settings())
    res = [await run_case(client, c, repeats) for c in CASES]
    if out:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=1)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repeats", type=int, default=15)
    p.add_argument("--out", default=None)
    a = p.parse_args()
    asyncio.run(main_async(a.repeats, a.out))


if __name__ == "__main__":
    main()
