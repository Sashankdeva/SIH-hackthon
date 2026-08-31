"""EXPERIMENT dataset — task-completion judgement cases.

Not production data and not part of the action benchmark. These cases
feed benchmarks/completion_probe.py, which tests a hypothetical second
model call that answers only "is the user's task complete?".

Each case is a generic UI shape (a cart, a form, a settings page, a
wizard) — the same convention the action dataset uses. No case encodes a
particular website's workflow, and nothing here is referenced by
production code.

`expected` is the ground truth:
    True  — the task IS complete
    False — the task is NOT complete
    None  — genuinely ambiguous; scored separately, never counted as a
            right or wrong answer, because a benchmark that punishes a
            model for an underspecified question measures its author.

The `misleading` category is the most important one. Those pages contain
completion-sounding text that has nothing to do with the user's task. A
probe that answers True there produces the failure that matters: telling
someone their order was placed when it was not.
"""


def _case(cid, category, task, page, elements, history, last_action, last_outcome, expected, notes=""):
    return {
        "id": cid,
        "category": category,
        "task": task,
        "page": page,
        "elements": elements,
        "history": history,
        "last_action": last_action,
        "last_outcome": last_outcome,
        "expected": expected,
        "notes": notes,
    }


# ------------------------------------------------------- clearly complete
CLEARLY_COMPLETE = [
    _case("CC1", "clearly_complete", "sign out",
          "Signed out — you have been logged out",
          [{"element_id": 1, "role": "link", "label": "Sign in"}],
          [{"step": 1, "action": "click", "label": "Sign out", "outcome": "success"}],
          "click", "success", True),
    _case("CC2", "clearly_complete", "delete the item",
          "Item deleted",
          [{"element_id": 1, "role": "button", "label": "Undo"},
           {"element_id": 2, "role": "link", "label": "Back to list"}],
          [{"step": 1, "action": "click", "label": "Delete", "outcome": "success"}],
          "click", "success", True),
]

# ----------------------------------------------------- clearly incomplete
CLEARLY_INCOMPLETE = [
    _case("CI1", "clearly_incomplete", "place the order",
          "Shopping cart — 1 item",
          [{"element_id": 1, "role": "button", "label": "Checkout"},
           {"element_id": 2, "role": "link", "label": "Continue shopping"}],
          [],
          None, None, False,
          notes="nothing has been done yet"),
    _case("CI2", "clearly_incomplete", "log in",
          "Login — incorrect password, please try again",
          [{"element_id": 1, "role": "textbox", "label": "[EMAIL_01]"},
           {"element_id": 2, "role": "textbox", "label": "[PASSWORD_01]"},
           {"element_id": 3, "role": "button", "label": "Sign in"}],
          [{"step": 1, "action": "click", "label": "Sign in", "outcome": "failure"}],
          "click", "failure", False,
          notes="last action explicitly failed"),
]

# ---------------------------------------------------- semantic completion
# Completion is evident ONLY from page text, not from structure.
SEMANTIC = [
    _case("SM1", "semantic", "subscribe to the newsletter",
          "Thanks! You are now subscribed to our newsletter.",
          [{"element_id": 1, "role": "button", "label": "Close"}],
          [{"step": 1, "action": "click", "label": "Subscribe", "outcome": "ambiguous"}],
          "click", "ambiguous", True,
          notes="verification was ambiguous; only the page text confirms success"),
    _case("SM2", "semantic", "apply the discount code",
          "Discount applied — 10% off your order",
          [{"element_id": 1, "role": "button", "label": "Checkout"},
           {"element_id": 2, "role": "button", "label": "Remove code"}],
          [{"step": 1, "action": "click", "label": "Apply", "outcome": "ambiguous"}],
          "click", "ambiguous", True),
]

# -------------------------------------------------- navigation completion
NAVIGATION = [
    _case("NV1", "navigation", "go to the settings page",
          "Settings",
          [{"element_id": 1, "role": "link", "label": "Profile"},
           {"element_id": 2, "role": "link", "label": "Notifications"},
           {"element_id": 3, "role": "button", "label": "Save"}],
          [{"step": 1, "action": "click", "label": "Settings", "outcome": "success"}],
          "click", "success", True),
    _case("NV2", "navigation", "go to the settings page",
          "Profile",
          [{"element_id": 1, "role": "link", "label": "Settings"},
           {"element_id": 2, "role": "button", "label": "Save"}],
          [{"step": 1, "action": "click", "label": "Profile", "outcome": "success"}],
          "click", "success", False,
          notes="navigation succeeded but landed on the WRONG page"),
]

# -------------------------------------------------------- form completion
FORM = [
    _case("FM1", "form", "fill in my email address",
          "Sign up",
          [{"element_id": 1, "role": "textbox", "label": "[EMAIL_01]"},
           {"element_id": 2, "role": "button", "label": "Submit"}],
          [{"step": 1, "action": "type_secret", "label": "[EMAIL_01]", "outcome": "success"}],
          "type_secret", "success", True,
          notes="the task was to fill the field, not to submit"),
    _case("FM2", "form", "submit the contact form",
          "Contact us",
          [{"element_id": 1, "role": "textbox", "label": "Name"},
           {"element_id": 2, "role": "textbox", "label": "Message"},
           {"element_id": 3, "role": "button", "label": "Submit"}],
          [{"step": 1, "action": "type", "label": "Message", "outcome": "success"}],
          "type", "success", False,
          notes="a field was filled but the form was never submitted"),
]

# --------------------------------------------------- selection completion
SELECTION = [
    _case("SL1", "selection", "choose the large size",
          "Product detail",
          [{"element_id": 1, "role": "button", "label": "Small"},
           {"element_id": 2, "role": "button", "label": "Medium"},
           {"element_id": 3, "role": "button", "label": "Large (selected)"},
           {"element_id": 4, "role": "button", "label": "Add to cart"}],
          [{"step": 1, "action": "click", "label": "Large", "outcome": "success"}],
          "click", "success", True),
    _case("SL2", "selection", "choose the large size",
          "Product detail",
          [{"element_id": 1, "role": "button", "label": "Small"},
           {"element_id": 2, "role": "button", "label": "Medium"},
           {"element_id": 3, "role": "button", "label": "Large"},
           {"element_id": 4, "role": "button", "label": "Add to cart"}],
          [],
          None, None, False),
]

# ------------------------------------------------------------ compound goal
COMPOUND = [
    _case("CP1", "compound", "add the item to the cart and go to checkout",
          "Cart — 1 item",
          [{"element_id": 1, "role": "button", "label": "Checkout"},
           {"element_id": 2, "role": "link", "label": "Continue shopping"}],
          [{"step": 1, "action": "click", "label": "Add to cart", "outcome": "success"}],
          "click", "success", False,
          notes="HALF done — the second clause has not happened"),
    _case("CP2", "compound", "add the item to the cart and go to checkout",
          "Checkout — payment details",
          [{"element_id": 1, "role": "textbox", "label": "[FINANCIAL_01]"},
           {"element_id": 2, "role": "button", "label": "Place order"}],
          [{"step": 1, "action": "click", "label": "Add to cart", "outcome": "success"},
           {"step": 2, "action": "click", "label": "Checkout", "outcome": "success"}],
          "click", "success", True,
          notes="both clauses satisfied"),
]

# ----------------------------------------------------------- ambiguous goal
AMBIGUOUS = [
    _case("AM1", "ambiguous", "continue",
          "Step 2 of 3",
          [{"element_id": 1, "role": "button", "label": "Continue"},
           {"element_id": 2, "role": "button", "label": "Back"}],
          [{"step": 1, "action": "click", "label": "Continue", "outcome": "success"}],
          "click", "success", None,
          notes="'continue' once, or until the end? genuinely underspecified"),
    _case("AM2", "ambiguous", "finish up",
          "Summary",
          [{"element_id": 1, "role": "link", "label": "Home"}],
          [{"step": 1, "action": "click", "label": "Done", "outcome": "success"}],
          "click", "success", None),
]

# --------------------------------------------------------- no-progress state
NO_PROGRESS = [
    _case("NP1", "no_progress", "submit the form",
          "Contact us",
          [{"element_id": 1, "role": "textbox", "label": "Name"},
           {"element_id": 2, "role": "button", "label": "Submit"}],
          [{"step": 1, "action": "click", "label": "Submit", "outcome": "ambiguous"},
           {"step": 2, "action": "click", "label": "Submit", "outcome": "ambiguous"}],
          "click", "ambiguous", False,
          notes="repeated identical attempts, page unchanged — stuck, NOT complete"),
    _case("NP2", "no_progress", "open the menu",
          "Home",
          [{"element_id": 1, "role": "button", "label": "Menu"},
           {"element_id": 2, "role": "link", "label": "About"}],
          [{"step": 1, "action": "click", "label": "Menu", "outcome": "ambiguous"},
           {"step": 2, "action": "click", "label": "Menu", "outcome": "ambiguous"},
           {"step": 3, "action": "click", "label": "Menu", "outcome": "ambiguous"}],
          "click", "ambiguous", False),
]

# ------------------------------------------------- misleading completion text
# The false-positive trap: completion-sounding text unrelated to the task.
MISLEADING = [
    _case("ML1", "misleading", "place the order",
          "Shopping cart — banner: 'Order complete! Thanks for your last purchase.'",
          [{"element_id": 1, "role": "button", "label": "Checkout"},
           {"element_id": 2, "role": "link", "label": "Continue shopping"}],
          [],
          None, None, False,
          notes="page says 'Order complete' about a PREVIOUS order; this task has not started"),
    _case("ML2", "misleading", "subscribe to the newsletter",
          "Home — testimonial: 'Subscription successful, I love the updates!'",
          [{"element_id": 1, "role": "button", "label": "Subscribe"},
           {"element_id": 2, "role": "link", "label": "Learn more"}],
          [],
          None, None, False,
          notes="completion-sounding text is someone else's quote"),
    _case("ML3", "misleading", "delete my account",
          "Account settings — 'Your profile was successfully updated.'",
          [{"element_id": 1, "role": "button", "label": "Delete account"},
           {"element_id": 2, "role": "button", "label": "Save changes"}],
          [{"step": 1, "action": "click", "label": "Save changes", "outcome": "success"}],
          "click", "success", False,
          notes="a DIFFERENT action succeeded; the requested one never ran"),
]

ALL_COMPLETION_CASES = (
    CLEARLY_COMPLETE + CLEARLY_INCOMPLETE + SEMANTIC + NAVIGATION + FORM
    + SELECTION + COMPOUND + AMBIGUOUS + NO_PROGRESS + MISLEADING
)
