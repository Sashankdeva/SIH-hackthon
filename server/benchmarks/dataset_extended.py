"""Extended benchmark dataset — categories the core 32 cases don't cover.

Kept SEPARATE from dataset.py on purpose. The core dataset is the
comparison point for every prior phase's numbers; folding new cases into
it would silently change what "correct_action_pct" means and make this
phase's figures incomparable with Phase 3's. Run with:

    PYTHONPATH=. python -m benchmarks.runner --extended --repeats 5 --repeat-all

Adds, per the stability-baseline phase's required category list:
  K selection            — choosing among mutually exclusive options
  L multi-step workflow  — a step with prior history to reason over
  M recovery             — a step whose history records a FAILED action
  N completion / done    — when to emit `done`, and when not to
  O adversarial          — stale targets, conflicting controls,
                           misleading labels, non-contiguous ids

Design rules are inherited from dataset.py and hold here too: every case
carries distractors, `acceptable` is a set rather than one answer, and
nothing is site- or workflow-specific — these are generic UI shapes
(option groups, wizards, retry-after-failure), not a scripted product
flow. A model that only passed by memorising a particular website would
score no better here.
"""

from benchmarks.dataset import ALL_CASES, DETERMINISTIC, _case

# ------------------------------------------------------------- K: selection
# Mutually exclusive options plus a confirm — the generic "pick one of
# N, then proceed" shape common to size/plan/quantity pickers.
_SELECT_PAGE = [
    {"element_id": 1, "role": "button", "label": "Small"},
    {"element_id": 2, "role": "button", "label": "Medium"},
    {"element_id": 3, "role": "button", "label": "Large"},
    {"element_id": 4, "role": "button", "label": "Confirm selection"},
    {"element_id": 5, "role": "link", "label": "Size guide"},
]

SELECTION = [
    _case("K1", "selection", "choose the large option", _SELECT_PAGE, "click", 3,
          notes="'Size guide' link and the Confirm button are distractors"),
    _case("K2", "selection", "pick the medium option", _SELECT_PAGE, "click", 2),
    _case("K3", "selection", "confirm my selection", _SELECT_PAGE, "click", 4),
]

# ------------------------------------------------- L: multi-step workflow
# A three-stage wizard. The model sees prior history and must pick the
# step that is actually next, not one already completed.
_WIZARD_STEP2 = [
    {"element_id": 1, "role": "button", "label": "Account details"},
    {"element_id": 2, "role": "button", "label": "Shipping address"},
    {"element_id": 3, "role": "button", "label": "Payment method"},
    {"element_id": 4, "role": "button", "label": "Review and finish"},
]

MULTISTEP = [
    _case(
        "L1", "multistep", "complete the checkout wizard", _WIZARD_STEP2, "click", 2,
        acceptable=[("click", 2)],
        history=[{"step": 1, "action": "click", "element_id": 1,
                  "element_label": "Account details", "outcome": "success"}],
        page="Checkout wizard (step 2 of 4)",
        notes="stage 1 already done; the next undone stage is Shipping address",
    ),
    _case(
        "L2", "multistep", "complete the checkout wizard", _WIZARD_STEP2, "click", 3,
        acceptable=[("click", 3)],
        history=[
            {"step": 1, "action": "click", "element_id": 1,
             "element_label": "Account details", "outcome": "success"},
            {"step": 2, "action": "click", "element_id": 2,
             "element_label": "Shipping address", "outcome": "success"},
        ],
        page="Checkout wizard (step 3 of 4)",
    ),
    _case(
        "L3", "multistep", "complete the checkout wizard", _WIZARD_STEP2, "click", 4,
        acceptable=[("click", 4)],
        history=[
            {"step": 1, "action": "click", "element_id": 1,
             "element_label": "Account details", "outcome": "success"},
            {"step": 2, "action": "click", "element_id": 2,
             "element_label": "Shipping address", "outcome": "success"},
            {"step": 3, "action": "click", "element_id": 3,
             "element_label": "Payment method", "outcome": "success"},
        ],
        page="Checkout wizard (step 4 of 4)",
    ),
]

# ------------------------------------------ M: recovery after failed action
_RETRY_PAGE = [
    {"element_id": 1, "role": "button", "label": "Submit"},
    {"element_id": 2, "role": "button", "label": "Submit (alternative method)"},
    {"element_id": 3, "role": "link", "label": "Contact support"},
    {"element_id": 4, "role": "button", "label": "Cancel"},
]

RECOVERY = [
    _case(
        "M1", "recovery", "submit the form", _RETRY_PAGE, "click", 1,
        acceptable=[("click", 1), ("click", 2)],
        history=[{"step": 1, "action": "click", "element_id": 1,
                  "element_label": "Submit", "outcome": "failure"}],
        page="Form (submit failed)",
        notes="retrying the same control or trying the alternative are both defensible; "
              "giving up or cancelling is not",
    ),
    _case(
        "M2", "recovery", "submit the form", _RETRY_PAGE, "click", 1,
        acceptable=[("click", 1), ("click", 2)],
        history=[{"step": 1, "action": "click", "element_id": 1,
                  "element_label": "Submit", "outcome": "ambiguous"}],
        page="Form (submit outcome unclear)",
        notes="ambiguous != failed; the agent still needs to make progress",
    ),
]

# --------------------------------------------------- N: completion / done
_DONE_PAGE = [
    {"element_id": 1, "role": "link", "label": "Back to home"},
    {"element_id": 2, "role": "link", "label": "View receipt"},
    {"element_id": 3, "role": "button", "label": "Place another order"},
]
_NOT_DONE_PAGE = [
    {"element_id": 1, "role": "button", "label": "Confirm payment"},
    {"element_id": 2, "role": "link", "label": "Back to cart"},
]

COMPLETION = [
    _case(
        "N1", "completion", "place the order", _DONE_PAGE, "done", None,
        acceptable=[("done", None)],
        history=[
            {"step": 1, "action": "click", "element_id": 4,
             "element_label": "Place Order", "outcome": "success"},
        ],
        page="Order confirmed — thank you for your purchase",
        notes="history + a confirmation page: the task is genuinely finished",
    ),
    _case(
        "N2", "completion", "place the order", _NOT_DONE_PAGE, "click", 1,
        acceptable=[("click", 1)],
        history=[
            {"step": 1, "action": "click", "element_id": 5,
             "element_label": "Proceed to payment", "outcome": "success"},
        ],
        page="Payment — confirm to complete your order",
        notes="a step succeeded but the task is NOT finished; emitting done here "
              "would abandon the task early",
    ),
    _case(
        "N3", "completion", "place the order", _NOT_DONE_PAGE, "click", 1,
        acceptable=[("click", 1)],
        page="Payment — confirm to complete your order",
        notes="no history at all: done must never be the first action",
    ),
]

# ------------------------------------------------------- O: adversarial
_CONFLICT_PAGE = [
    {"element_id": 1, "role": "button", "label": "Submit"},
    {"element_id": 2, "role": "button", "label": "Submit"},
    {"element_id": 3, "role": "button", "label": "Reset"},
]
_MISLEADING_PAGE = [
    {"element_id": 1, "role": "button", "label": "Cancel"},
    {"element_id": 2, "role": "button", "label": "Do not click cancel"},
    {"element_id": 3, "role": "button", "label": "Save"},
]
# Deliberately non-contiguous, high ids: a model that pattern-matches
# "ids start at 1" instead of reading the supplied list will invent one.
_SPARSE_PAGE = [
    {"element_id": 47, "role": "button", "label": "Approve"},
    {"element_id": 112, "role": "button", "label": "Reject"},
    {"element_id": 903, "role": "link", "label": "More info"},
]
_STALE_PAGE = [
    {"element_id": 10, "role": "button", "label": "Continue to summary"},
    {"element_id": 11, "role": "link", "label": "Start over"},
]

ADVERSARIAL = [
    _case(
        "O1", "adversarial", "submit the form", _CONFLICT_PAGE, "click", 1,
        acceptable=[("click", 1), ("click", 2)],
        notes="two identically-labelled controls — either is defensible, "
              "but inventing a third id or picking Reset is not",
    ),
    _case(
        "O2", "adversarial", "save my changes", _MISLEADING_PAGE, "click", 3,
        notes="'Do not click cancel' contains the word the task does NOT want; "
              "the correct target is the unrelated-looking Save",
    ),
    _case(
        "O3", "adversarial", "approve the request", _SPARSE_PAGE, "click", 47,
        notes="non-contiguous ids far from 1 — tests reading the supplied list "
              "rather than assuming an id range",
    ),
    _case(
        "O4", "adversarial", "continue to the summary", _STALE_PAGE, "click", 10,
        history=[{"step": 1, "action": "click", "element_id": 3,
                  "element_label": "Next", "outcome": "success"}],
        page="Summary step",
        notes="history references element 3, which does NOT exist on this page. "
              "The model must target a CURRENT id, not the stale one from history.",
    ),
]

EXTENDED_DETERMINISTIC = (
    list(DETERMINISTIC) + SELECTION + MULTISTEP + RECOVERY + COMPLETION + ADVERSARIAL
)
EXTENDED_ALL = list(ALL_CASES) + SELECTION + MULTISTEP + RECOVERY + COMPLETION + ADVERSARIAL
