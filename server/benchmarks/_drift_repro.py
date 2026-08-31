"""REAL E2E — target drift on realistic, distractor-heavy pages.

The previous phase measured a 7-element product page and saw no drift
(20/20 correct). Real product pages carry 100+ interactive elements, so
this rebuilds each scenario at realistic scale with the primary control
buried among ordinary distractors — the condition the live runs
actually hit.

Cases follow the phase brief: A product page, B search results,
C navigation-heavy, D form, E equally-plausible buttons, F
completed-looking page that still needs an action. Plus a semantic
target case (a category whose visible label is a brand name, not the
word in the task) to check task-semantics mapping WITHOUT a keyword
rule.

    PYTHONPATH=. python -m benchmarks._drift_repro [--repeats 20]
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
SHOP_TASK = "Search for Samsung Galaxy S24 FE and add the first suitable result to the cart"

CATEGORIES = ["Grocery", "Mobiles", "Fashion", "Electronics", "Home & Furniture",
              "Appliances", "Cleartrip", "Beauty, Toys & More", "Two Wheelers"]


def _chrome(nid: int) -> tuple[list[dict], int]:
    """Site chrome every page carries."""
    els = []
    for role, label in [("textbox", "Search for products, brands and more"),
                        ("button", "Search"), ("link", "Login"),
                        ("link", "Become a Seller"), ("link", "More"), ("link", "Cart")]:
        els.append({"element_id": nid, "role": role, "label": label}); nid += 1
    for c in CATEGORIES:
        els.append({"element_id": nid, "role": "link", "label": c}); nid += 1
    return els, nid


def _footer(nid: int, n: int = 35) -> tuple[list[dict], int]:
    els = []
    for name in ["About Us", "Careers", "Press", "Corporate Information", "Help Centre",
                 "Payments", "Shipping", "Cancellation & Returns", "FAQ", "Terms Of Use",
                 "Security", "Privacy", "Sitemap", "Grievance Redressal", "EPR Compliance",
                 "Advertise", "Gift Cards", "Report Infringement", "Press Enquiries"][:n]:
        els.append({"element_id": nid, "role": "link", "label": name}); nid += 1
    return els, nid


def product_page() -> tuple[list[dict], int]:
    """~110 elements. 'Add to Cart' is the primary control, buried."""
    els, nid = _chrome(1)
    for label in ["Home", "Mobiles & Accessories", "Smartphones", "Samsung"]:
        els.append({"element_id": nid, "role": "link", "label": label}); nid += 1
    els.append({"element_id": nid, "role": "link",
                "label": "Samsung Galaxy S24 FE 5G (Graphite, 128 GB)"}); nid += 1
    for label in ["128 GB", "256 GB", "Graphite", "Mint", "Blue"]:
        els.append({"element_id": nid, "role": "button", "label": label}); nid += 1
    for label in ["Bank Offer: 10% off on HDFC Cards", "Exchange Offer up to 15,000",
                  "No Cost EMI available", "View all offers", "Seller: RetailNet",
                  "See other sellers", "Read all 4,821 reviews", "Q&A", "Report incorrect info"]:
        els.append({"element_id": nid, "role": "link", "label": label}); nid += 1
    add_to_cart = nid
    els.append({"element_id": nid, "role": "button", "label": "Add to Cart"}); nid += 1
    els.append({"element_id": nid, "role": "button", "label": "Buy Now"}); nid += 1
    els.append({"element_id": nid, "role": "button", "label": "Add to Compare"}); nid += 1
    els.append({"element_id": nid, "role": "button", "label": "Add to Wishlist"}); nid += 1
    for i in range(24):
        els.append({"element_id": nid, "role": "link",
                    "label": f"Similar phone {i + 1} — 5G, 8GB RAM, best price"}); nid += 1
        els.append({"element_id": nid, "role": "button", "label": "Add to Cart"}); nid += 1
    f, nid = _footer(nid)
    els += f
    return els, add_to_cart


def results_page() -> tuple[list[dict], int]:
    els, nid = _chrome(1)
    for label in ["Sort by Relevance", "Sort by Price", "Filter", "Brand", "Price Range"]:
        els.append({"element_id": nid, "role": "link", "label": label}); nid += 1
    for label in ["Sponsored: Best 5G phones under 30k", "Sponsored: Exchange your old phone"]:
        els.append({"element_id": nid, "role": "link", "label": label}); nid += 1
    target = nid
    els.append({"element_id": nid, "role": "link",
                "label": "Samsung Galaxy S24 FE 5G (Graphite, 128 GB)"}); nid += 1
    for i, label in enumerate(["Samsung Galaxy S24 Ultra 5G (Titanium, 256 GB)",
                               "Samsung Galaxy S23 FE 5G (Mint, 128 GB)",
                               "Samsung Galaxy M35 5G (Blue, 128 GB)",
                               "Apple iPhone 15 (Black, 128 GB)",
                               "OnePlus 12R (Iron Gray, 256 GB)"]):
        els.append({"element_id": nid, "role": "link", "label": label}); nid += 1
    f, nid = _footer(nid)
    els += f
    return els, target


PRODUCT_ELS, ADD_TO_CART_ID = product_page()
RESULTS_ELS, RESULT_ID = results_page()

PRODUCT_HISTORY = [
    {"step": 1, "action": "type", "element_id": 1,
     "element_label": "Search for products, brands and more", "outcome": "success"},
    {"step": 2, "action": "click", "element_id": 2, "element_label": "Search", "outcome": "success"},
    {"step": 3, "action": "click", "element_id": RESULT_ID,
     "element_label": "Samsung Galaxy S24 FE 5G (Graphite, 128 GB)", "outcome": "success"},
]

NAV_ELS, _ = _chrome(1)
CLEARTRIP_ID = next(e["element_id"] for e in NAV_ELS if e["label"] == "Cleartrip")

FORM_ELS = [
    {"element_id": 1, "role": "textbox", "label": "Full name"},
    {"element_id": 2, "role": "textbox", "label": "Address line 1"},
    {"element_id": 3, "role": "textbox", "label": "City"},
    {"element_id": 4, "role": "button", "label": "Save address"},
    {"element_id": 5, "role": "link", "label": "Cancel"},
    {"element_id": 6, "role": "link", "label": "Help"},
]

PLAUSIBLE_ELS = [
    {"element_id": 1, "role": "button", "label": "Continue"},
    {"element_id": 2, "role": "button", "label": "Proceed"},
    {"element_id": 3, "role": "button", "label": "Next"},
    {"element_id": 4, "role": "link", "label": "Back"},
]

# F — looks finished (an order-placed banner) but the task asked for
# something that still needs one more action.
LOOKS_DONE_ELS = [
    {"element_id": 1, "role": "link", "label": "Continue shopping"},
    {"element_id": 2, "role": "button", "label": "Add to Cart"},
    {"element_id": 3, "role": "link", "label": "View receipt"},
]

CASES = [
    {"id": "A-product-page", "task": SHOP_TASK, "elements": PRODUCT_ELS,
     "history": PRODUCT_HISTORY, "page": "Samsung Galaxy S24 FE 5G — Online Store",
     "route": "/product/samsung-galaxy-s24-fe", "correct": [ADD_TO_CART_ID],
     "note": f"{len(PRODUCT_ELS)} elements, Add to Cart at id={ADD_TO_CART_ID}"},
    {"id": "B-results-page", "task": SHOP_TASK, "elements": RESULTS_ELS,
     "history": PRODUCT_HISTORY[:2], "page": "Search results — Online Store",
     "route": "/search", "correct": [RESULT_ID],
     "note": f"{len(RESULTS_ELS)} elements, correct result at id={RESULT_ID}"},
    {"id": "C-nav-semantic", "task": "click on travel", "elements": NAV_ELS,
     "history": [], "page": "Online Store", "route": "/", "correct": [CLEARTRIP_ID],
     "note": "the travel category is labelled 'Cleartrip', not 'Travel' — semantics, no keyword"},
    {"id": "D-form-page", "task": "save my address", "elements": FORM_ELS,
     "history": [], "page": "Address book", "route": "/account/addresses", "correct": [4],
     "note": "form page"},
    {"id": "E-plausible-buttons", "task": "continue to the next step", "elements": PLAUSIBLE_ELS,
     "history": [], "page": "Checkout step 2", "route": "/checkout", "correct": [1, 2, 3],
     "note": "several equally plausible — any of 1/2/3 defensible"},
    {"id": "F-looks-done", "task": "add this item to the cart", "elements": LOOKS_DONE_ELS,
     "history": [{"step": 1, "action": "click", "element_id": 9,
                  "element_label": "Place Order", "outcome": "success"}],
     "page": "Order complete! Thanks for your last purchase.",
     "route": "/", "correct": [2],
     "note": "completion-sounding page, but THIS task still needs Add to Cart"},
]


def make_ctx(case: dict, run: int) -> SanitizedContext:
    return SanitizedContext(
        task_id=f"drift-{case['id']}-r{run}", task=case["task"], page=case["page"],
        url_origin=ORIGIN, elements=case["elements"], fields={},
        history=case["history"], route_hint=case["route"],
    )


async def run_case(client, case: dict, repeats: int) -> dict:
    outs, rejects = [], collections.Counter()
    for i in range(repeats):
        try:
            a = await client.propose_action(make_ctx(case, i + 1))
            outs.append((a.action, a.element_id))
        except ReasoningError as exc:
            outs.append(("REJECTED", None)); rejects[exc.reason[:60]] += 1

    correct = set(case["correct"])
    hits = sum(1 for a, t in outs if t in correct and a in ("click", "type"))
    waits = sum(1 for a, _ in outs if a == "wait")
    invalid = sum(1 for a, _ in outs if a == "REJECTED")
    lbl = {e["element_id"]: e["label"] for e in case["elements"]}
    print(f"\n=== {case['id']} — {case['note']} ===")
    print(f"  task={case['task']!r}")
    print(f"  CORRECT {hits}/{repeats}   wait {waits}   invalid {invalid}")
    for (a, t), n in collections.Counter(outs).most_common(6):
        mark = "OK " if (t in correct and a in ("click", "type")) else "   "
        print(f"    {mark}{n:2d}x {a}:{t}  {lbl.get(t, '')[:52]}")
    for r, n in rejects.most_common(3):
        print(f"       reject: {n}x {r}")
    return {"id": case["id"], "correct": hits, "of": repeats, "wait": waits, "invalid": invalid}


async def main_async(repeats: int, out: str | None) -> None:
    client = OllamaReasoningClient(settings=load_settings())
    res = [await run_case(client, c, repeats) for c in CASES]
    print("\nSUMMARY")
    for r in res:
        print(f"  {r['id']:22s} correct {r['correct']:2d}/{r['of']}  wait {r['wait']}  invalid {r['invalid']}")
    if out:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=1)
        print(f"-> {out}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repeats", type=int, default=20)
    p.add_argument("--out", default=None)
    a = p.parse_args()
    asyncio.run(main_async(a.repeats, a.out))


if __name__ == "__main__":
    main()
