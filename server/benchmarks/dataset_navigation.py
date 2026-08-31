"""SERVER PHASE S3 — navigation-aware (route_hint) and target-selection
benchmark cases.

Kept SEPARATE from dataset.py/dataset_extended.py for the same reason
those two are separate from each other: folding new cases into an
existing category would silently change what its accuracy figure means
and make this phase's numbers incomparable with prior phases'.

Two purposes:

  P — route_hint A/B pairs. Each pair is the IDENTICAL task and element
      list, differing ONLY in whether `route_hint` is set. This isolates
      route_hint's own contribution instead of conflating it with any
      other change. Two sub-kinds:

        * P1-P3: an UNAMBIGUOUS task where route_hint should, if
          anything, only confirm what the labels already say. The
          honest expectation is little-to-no measurable difference —
          that is itself a real finding, not a null result to hide.
        * P4-P5: a GENUINELY AMBIGUOUS task (mirrors dataset.py's I1/I4)
          where the model has to guess without route context. This is
          the case type where route_hint could plausibly change the
          answer distribution or reduce ambiguity, and is the fairer
          test of Phase 9's actual question.

  Q — target-selection cases dataset.py/dataset_extended.py don't cover:
      a disabled duplicate (does the model spontaneously avoid a
      disabled control with NO prompt rule telling it to — see
      app/llm/prompt.py's `_describe_element`, which renders disabled
      state as fact only), an icon-only label pair, and a card-style
      nested-control page where a highlighted "primary" action button is
      a distractor against the literal task wording.
"""

from benchmarks.dataset import _case

# ------------------------------------------------------- P1: at destination
# A checkout page with no element literally labelled "checkout" — because
# the user is already there. Same acceptable answer either way; this
# tests whether route_hint changes ACCURACY/STABILITY, not whether it
# flips the answer.
_CHECKOUT_NO_LABEL_PAGE = [
    {"element_id": 1, "role": "input:text", "label": "[ADDRESS_01]"},
    {"element_id": 2, "role": "button", "label": "Continue"},
    {"element_id": 3, "role": "link", "label": "Edit cart"},
]
_CHECKOUT_NO_LABEL_FIELDS = {"1": "[ADDRESS_01]"}

P1_NO_ROUTE = _case(
    "P1a", "navigation", "go to checkout", _CHECKOUT_NO_LABEL_PAGE, "click", 2,
    fields=_CHECKOUT_NO_LABEL_FIELDS,
    notes="A/B pair with P1b. No element is literally labelled 'checkout' "
          "because the page already IS checkout.",
)
P1_WITH_ROUTE = _case(
    "P1b", "navigation", "go to checkout", _CHECKOUT_NO_LABEL_PAGE, "click", 2,
    fields=_CHECKOUT_NO_LABEL_FIELDS, route_hint="/checkout",
    notes="A/B pair with P1a. Identical task/elements; route_hint confirms "
          "the user is already on the checkout route.",
)

# ------------------------------------------------------- P2: search intent
_SEARCH_PAGE = [
    {"element_id": 1, "role": "input:text", "label": "Search"},
    {"element_id": 2, "role": "button", "label": "Search"},
    {"element_id": 3, "role": "link", "label": "Deals"},
]

P2_NO_ROUTE = _case(
    "P2a", "navigation", "search for wireless earbuds", _SEARCH_PAGE, "type", 1,
    notes="A/B pair with P2b.",
)
P2_WITH_ROUTE = _case(
    "P2b", "navigation", "search for wireless earbuds", _SEARCH_PAGE, "type", 1,
    route_hint="/search", notes="A/B pair with P2a.",
)

# ------------------------------------------------------- P3: product intent
_PRODUCT_PAGE = [
    {"element_id": 1, "role": "button", "label": "Add to Wishlist"},
    {"element_id": 2, "role": "button", "label": "Add to Cart"},
    {"element_id": 3, "role": "link", "label": "Reviews"},
]

P3_NO_ROUTE = _case(
    "P3a", "navigation", "save this item for later", _PRODUCT_PAGE, "click", 1,
    notes="A/B pair with P3b.",
)
P3_WITH_ROUTE = _case(
    "P3b", "navigation", "save this item for later", _PRODUCT_PAGE, "click", 1,
    route_hint="/product/8823", notes="A/B pair with P3a.",
)

# ------------------------------------- P4: ambiguous, route could disambiguate
# Mirrors dataset.py's I1 exactly (same page, same task, same acceptable
# set) so P4a is a same-condition replication of I1, and P4b isolates
# route_hint's effect on a genuinely ambiguous case.
_WIZARD_AMBIGUOUS_PAGE = [
    {"element_id": 1, "role": "button", "label": "Continue"},
    {"element_id": 2, "role": "button", "label": "Next step"},
    {"element_id": 3, "role": "button", "label": "Submit"},
    {"element_id": 4, "role": "link", "label": "Open details page"},
    {"element_id": 5, "role": "button", "label": "Cancel"},
]

P4_NO_ROUTE = _case(
    "P4a", "navigation", "continue", _WIZARD_AMBIGUOUS_PAGE, "click", 1,
    acceptable=[("click", 1), ("click", 2)], ambiguous=True,
    notes="A/B pair with P4b; same page/task as dataset.py I1.",
)
P4_WITH_ROUTE = _case(
    "P4b", "navigation", "continue", _WIZARD_AMBIGUOUS_PAGE, "click", 1,
    acceptable=[("click", 1), ("click", 2)], ambiguous=True,
    route_hint="/onboarding/step-2",
    notes="A/B pair with P4a. route_hint suggests a step wizard; tests "
          "whether that shifts the Continue/Next-step split or stability.",
)

# ------------------------------------- P5: fully generic, route could help
# Mirrors dataset.py's I4 exactly.
P5_NO_ROUTE = _case(
    "P5a", "navigation", "go there", _WIZARD_AMBIGUOUS_PAGE, "click", None,
    acceptable=[("click", 1), ("click", 2), ("click", 4), ("wait", None)], ambiguous=True,
    notes="A/B pair with P5b; same page/task as dataset.py I4.",
)
P5_WITH_ROUTE = _case(
    "P5b", "navigation", "go there", _WIZARD_AMBIGUOUS_PAGE, "click", None,
    acceptable=[("click", 1), ("click", 2), ("click", 4), ("wait", None)], ambiguous=True,
    route_hint="/search",
    notes="A/B pair with P5a. route_hint suggests search results, where "
          "'go there' plausibly means opening a result (id 4).",
)

NAVIGATION_ROUTE_HINT = [
    P1_NO_ROUTE, P1_WITH_ROUTE,
    P2_NO_ROUTE, P2_WITH_ROUTE,
    P3_NO_ROUTE, P3_WITH_ROUTE,
    P4_NO_ROUTE, P4_WITH_ROUTE,
    P5_NO_ROUTE, P5_WITH_ROUTE,
]
# Deterministic for repeat purposes: P1-P3 are unambiguous. P4/P5 are
# ambiguous by design and analysed separately, exactly like I1-I5.
NAVIGATION_ROUTE_HINT_DETERMINISTIC = [
    P1_NO_ROUTE, P1_WITH_ROUTE, P2_NO_ROUTE, P2_WITH_ROUTE, P3_NO_ROUTE, P3_WITH_ROUTE,
]
NAVIGATION_ROUTE_HINT_AMBIGUOUS = [P4_NO_ROUTE, P4_WITH_ROUTE, P5_NO_ROUTE, P5_WITH_ROUTE]

# ======================================================================
# Q — target-selection cases dataset.py/dataset_extended.py don't cover
# ======================================================================

Q1A = _case(
    "Q1a", "target_selection", "submit the form",
    [
        {"element_id": 1, "role": "button", "label": "Submit", "disabled": True},
        {"element_id": 2, "role": "button", "label": "Submit"},
    ],
    "click", 2,
    notes="Disabled duplicate at id 1. No prompt rule tells the model to "
          "avoid a disabled control (app/llm/prompt.py renders it as fact "
          "only) — this measures whether it does so anyway.",
)
Q1B = _case(
    "Q1b", "target_selection", "submit the form",
    [
        {"element_id": 1, "role": "button", "label": "Submit"},
        {"element_id": 2, "role": "button", "label": "Submit", "disabled": True},
    ],
    "click", 1,
    notes="Same as Q1a with the disabled duplicate at the OTHER id, to "
          "rule out a positional (always-pick-lowest-id) bias.",
)
Q2 = _case(
    "Q2", "target_selection", "close the dialog",
    [
        {"element_id": 1, "role": "button", "label": "×"},
        {"element_id": 2, "role": "button", "label": "☰"},
        {"element_id": 3, "role": "button", "label": "Save"},
    ],
    "click", 1,
    notes="Icon-only labels (× = close, ☰ = menu). No word 'close' "
          "appears anywhere; the model must map the glyph to intent.",
)
Q3 = _case(
    "Q3", "target_selection", "view the product details",
    [
        {"element_id": 1, "role": "link", "label": "Wireless Headphones — view details"},
        {"element_id": 2, "role": "button", "label": "Add to cart"},
        {"element_id": 3, "role": "link", "label": "Compare"},
    ],
    "click", 1,
    notes="'Add to cart' is the strong distractor: prompt rule 2 says to "
          "prefer a button that completes the task outright, but the task "
          "asks to VIEW details, not purchase — the literal-match link is "
          "correct despite the more 'actionable'-looking button.",
)

TARGET_SELECTION = [Q1A, Q1B, Q2, Q3]

S3_ALL = NAVIGATION_ROUTE_HINT + TARGET_SELECTION
S3_DETERMINISTIC = NAVIGATION_ROUTE_HINT_DETERMINISTIC + TARGET_SELECTION
