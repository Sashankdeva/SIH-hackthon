"""SERVER PHASE S5 — additional /complete benchmark cases.

Kept separate from completion_dataset.py for the same reason every prior
phase's dataset extension has been: folding new cases into an existing
file would silently change what its accuracy figure means and make this
phase's numbers incomparable with the completion_prompt.py history-fix
phase's own reported baseline (94.7% accuracy, 0% false negatives).

Covers the S5 category list not already exercised by completion_dataset.py:
  C  final confirmation page (no next-step CTA related to the task)
  H  a similar-looking alternative action remains available
  I  multiple possible next actions remain, but the asked-for one is done
  K  three-clause compound goal (completion_dataset.py's COMPOUND has two)
  L  final state has no interactive elements at all
  M  already-complete from the start — no history, goal already holds
  N  stale/irrelevant history entry unrelated to the actual task
  O  recovery — an earlier FAILURE followed by a real success
  ADV adversarial false-positive traps named explicitly in the S5 spec

Same rules as every dataset in this project: every case carries a
distractor, nothing is site-specific, and `expected=None` means
genuinely ambiguous (scored separately, never as right or wrong).
"""

from benchmarks.completion_dataset import _case

CONFIRMATION = [
    _case("C1", "confirmation", "place the order",
          "Order #48213 confirmed — thank you!",
          [{"element_id": 1, "role": "link", "label": "View receipt"},
           {"element_id": 2, "role": "link", "label": "Continue shopping"}],
          [{"step": 1, "action": "click", "label": "Place order", "outcome": "success"}],
          "click", "success", True,
          notes="a genuine order-confirmation page; neither remaining link is the task"),
]

SIMILAR_ALTERNATIVE = [
    _case("H1", "similar_alternative", "add the item to your wishlist",
          "Product detail — saved to your wishlist",
          [{"element_id": 1, "role": "button", "label": "Add to Cart"},
           {"element_id": 2, "role": "link", "label": "View wishlist"}],
          [{"step": 1, "action": "click", "label": "Add to Wishlist", "outcome": "success"}],
          "click", "success", True,
          notes="'Add to Cart' is a similar-sounding DIFFERENT action still available; "
                "must not be read as 'the wishlist step still needs doing'"),
    _case("H2", "similar_alternative", "add the item to your cart",
          "Product detail",
          [{"element_id": 1, "role": "button", "label": "Add to Wishlist"},
           {"element_id": 2, "role": "button", "label": "Add to Cart"}],
          [],
          None, None, False,
          notes="nothing done yet; the similarly-worded wishlist button must not be "
                "mistaken for progress on the cart task"),
]

MULTIPLE_NEXT_ACTIONS = [
    _case("I1", "multiple_next_actions", "log out",
          "Login — you have been signed out",
          [{"element_id": 1, "role": "link", "label": "Sign in"},
           {"element_id": 2, "role": "link", "label": "Register"},
           {"element_id": 3, "role": "link", "label": "Forgot password?"},
           {"element_id": 4, "role": "link", "label": "Help"}],
          [{"step": 1, "action": "click", "label": "Sign out", "outcome": "success"}],
          "click", "success", True,
          notes="many POSSIBLE next actions remain, but the requested one (log out) is done"),
]

THREE_CLAUSE_GOAL = [
    _case("K1", "multi_step_goal", "add the item to the cart, apply a coupon, and place the order",
          "Checkout — review your order",
          [{"element_id": 1, "role": "button", "label": "Place order"},
           {"element_id": 2, "role": "link", "label": "Edit cart"}],
          [{"step": 1, "action": "click", "label": "Add to cart", "outcome": "success"},
           {"step": 2, "action": "click", "label": "Apply coupon", "outcome": "success"}],
          "click", "success", False,
          notes="2 of 3 clauses done; the final clause (place the order) has not happened"),
]

NO_CTA = [
    _case("L1", "no_cta", "clear the search filters",
          "Search results — showing all 128 items",
          [],
          [{"step": 1, "action": "click", "label": "Clear filters", "outcome": "success"}],
          "click", "success", True,
          notes="no interactive elements at all on the final page — absence of a CTA "
                "is not evidence of incompleteness; the page TEXT confirms the task"),
]

ALREADY_COMPLETE = [
    _case("M1", "already_complete", "turn on dark mode",
          "Settings — Dark mode: ON",
          [{"element_id": 1, "role": "button", "label": "Turn off dark mode"},
           {"element_id": 2, "role": "link", "label": "Back"}],
          [],
          None, None, True,
          notes="EMPTY history, yet the goal state already holds. /complete's own "
                "prompt carries no 'never say done on the first step' rule (unlike "
                "the /reason action prompt's rule 11) — this tests whether that "
                "distinction actually holds in practice, not just in the prompt text"),
]

STALE_HISTORY = [
    _case("N1", "stale_history", "update my shipping address",
          "Checkout — shipping address: 221B Baker Street. Save changes to continue.",
          [{"element_id": 1, "role": "button", "label": "Save address"}],
          [{"step": 1, "action": "click", "label": "Apply discount code", "outcome": "success"}],
          "click", "success", False,
          notes="the ONE history entry is a stale success from an unrelated action "
                "(a discount code, not the address); the page itself still shows an "
                "unsaved state — a false-positive trap if the model treats ANY "
                "successful history entry as evidence for THIS task"),
]

RECOVERY = [
    _case("O1", "recovery", "submit the form",
          "Form — thank you, your submission was received",
          [{"element_id": 1, "role": "link", "label": "Back to home"}],
          [{"step": 1, "action": "click", "label": "Submit", "outcome": "failure"},
           {"step": 2, "action": "click", "label": "Submit", "outcome": "success"}],
          "click", "success", True,
          notes="an earlier FAILURE must not veto a later confirmed success — "
                "highest-step-number outcome (success) is what matters"),
]

# --------------------------------------------------------------------
# ADV — adversarial false-positive traps named explicitly in the S5 spec
# --------------------------------------------------------------------

ADVERSARIAL = [
    _case("ADV1", "adversarial", "delete my account",
          "Settings — Success",
          [{"element_id": 1, "role": "button", "label": "Delete account"},
           {"element_id": 2, "role": "button", "label": "Save"}],
          [{"step": 1, "action": "click", "label": "Save", "outcome": "success"}],
          "click", "success", False,
          notes="the word 'Success' on screen belongs to a SAVE action, not account "
                "deletion — the requested action was never taken"),
    _case("ADV2", "adversarial", "update your password",
          "Account wizard",
          [{"element_id": 1, "role": "button", "label": "Done"},
           {"element_id": 2, "role": "button", "label": "Change password"}],
          [],
          None, None, False,
          notes="a button literally labelled 'Done' exists and is unrelated to the "
                "task, and untouched; nothing has been done yet"),
    _case("ADV3", "adversarial", "delete the comment",
          "Comments — 'Great post!' (1 comment)",
          [{"element_id": 1, "role": "button", "label": "Delete"},
           {"element_id": 2, "role": "button", "label": "Reply"}],
          [{"step": 1, "action": "click", "label": "Delete", "outcome": "success"}],
          "click", "success", False,
          notes="history claims success, but the CURRENT page still shows the exact "
                "comment and a Delete button — current state must override a stale "
                "or incorrect verification claim, not defer to it blindly"),
    _case("ADV4", "adversarial", "view your order history",
          "My Account — profile overview",
          [{"element_id": 1, "role": "link", "label": "Order history"},
           {"element_id": 2, "role": "link", "label": "Settings"}],
          [{"step": 1, "action": "click", "label": "My Account", "outcome": "success"}],
          "click", "success", False,
          notes="navigated to the account area, but the specific target (order "
                "history) has not been reached yet — one more navigation is required"),
]

S5_NEW_CASES = (
    CONFIRMATION + SIMILAR_ALTERNATIVE + MULTIPLE_NEXT_ACTIONS + THREE_CLAUSE_GOAL
    + NO_CTA + ALREADY_COMPLETE + STALE_HISTORY + RECOVERY + ADVERSARIAL
)
