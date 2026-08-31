"""Prompt-content regression tests.

These assert that instructions added in response to a measured model
failure are still present. They cannot prove the model obeys them — only
the benchmark can — but they stop a rule being silently dropped during
an edit, which is how the last prompt regression happened.

The prompt is not the security boundary; every rule referenced here is
independently enforced in app/llm/validation.py.
"""

from app.llm.prompt import build_prompt
from app.models.context import SanitizedContext

CTX = SanitizedContext(
    task_id="t",
    task="write a note",
    page="p",
    url_origin="http://localhost:8000",
    elements=[
        {"element_id": 1, "role": "input:text", "label": "[EMAIL_01]"},
        {"element_id": 2, "role": "input:text", "label": "Gift message"},
    ],
    fields={"1": "[EMAIL_01]"},
)


def test_prompt_states_the_converse_rule() -> None:
    """Fix #2: token-labelled fields must use type_secret AND
    non-token-labelled fields must not. The benchmark showed the
    one-directional version let the model over-apply type_secret.

    Wording matters here and was measured, not chosen. Stating the
    converse as a standalone rule ("if NOT token-labelled, use type")
    scored 87.9% — worse than the 89.4% baseline, because the model then
    over-applied `type` to redacted fields instead. Framing it as an
    ordered decision on the chosen element's OWN label scored 95.5%.
    Keep the (a)/(b) ordering; re-measure if it changes.
    """
    prompt = build_prompt(CTX)
    assert "if its label contains a token" in prompt
    assert "only if its label contains no token" in prompt
    assert "NEVER use \"type_secret\" for an element whose own label has no token" in prompt
    assert "NEVER invent or borrow a token from another element" in prompt


def test_prompt_states_token_element_binding() -> None:
    assert "A token may only be used with the exact element whose label contains that token" in build_prompt(CTX)


def test_prompt_binds_value_to_type_not_click() -> None:
    """REAL E2E BLOCKER 1. Live Chrome, 3/3, and a synthetic replay of
    the same storefront step, 10/10: the model answered
    {"action":"click","element_id":<search box>,"value":"<query>"} and
    validation correctly refused it (422 action_rejected), killing the
    task at step 1.

    Model-side cause: `value` was the ONLY optional field the rules never
    bound to an action. `value_ref` has rule 9 ("only for type_secret"),
    `url`/`direction`/`amount` have rule 6 — but rule 4 described only
    what `value` may CONTAIN, and its own example was "e.g. a search
    query", which is exactly the failing task shape. Rule 4 now carries
    the same exclusivity rule 9 already had.

    This is a prompt-content tripwire, not proof the model obeys — the
    benchmark measures that. It exists so the binding cannot be dropped
    in a later edit, which is how the last prompt regression happened.

    Wording matters and was measured, not chosen. A first attempt also
    appended "to put text into a field the action is 'type', never
    'click' carrying a value". That fixed this blocker but CONTRADICTED
    rules 3/7/10 (token-labelled fields must use type_secret, not type),
    and a controlled in-process A/B measured the damage: case C1 ("enter
    my email", a redacted field) fell 15/15 -> 13/15, the model
    answering `type` on a token-labelled field, which validation then
    refused. Never unsafe — validation caught every one — but a real
    reasoning-quality loss that would kill a login task ~13% of the
    time. Dropping that one clause and keeping ONLY the field/action
    binding restored C1 to 15/15 while still fixing the blocker 15/15.
    Do not re-add a clause that asserts how fields get filled; rules
    3/7/10 own that, and this rule owns only where `value` may appear.
    """
    rule_4 = next(line for line in build_prompt(CTX).splitlines() if line.startswith("4."))
    assert '"value"' in rule_4
    assert 'belongs ONLY to "type"' in rule_4
    assert '"click" included' in rule_4
    assert '"value" must be null' in rule_4
    # The reverted clause must not come back — it regressed C1 (above).
    assert "the action is" not in rule_4, "rule 4 must not restate how fields are filled"


def test_value_binding_rule_names_no_site_or_task_keyword() -> None:
    """Anti-overfit guard for the rule above: the fix must generalise to
    every click, so it must not name a site, product, or task word.
    """
    rule_4 = next(line for line in build_prompt(CTX).splitlines() if line.startswith("4.")).lower()
    for banned in ("samsung", "amazon", "flipkart", "galaxy", "travel", "cart", "product"):
        assert banned not in rule_4, f"rule 4 mentions {banned!r} — the fix must stay generic"


def test_converse_rule_is_field_neutral() -> None:
    """Rule 10 must not name a specific field type. An earlier rule-7
    edit used email examples and primed the model so hard toward email
    fields that it mis-bound a password token on the login page.
    """
    rule_10 = next(line for line in build_prompt(CTX).splitlines() if line.startswith("10."))
    lowered = rule_10.lower()
    for field_word in ("email", "password", "phone", "card", "address"):
        assert field_word not in lowered, f"rule 10 mentions {field_word!r} — keep it field-neutral"


def test_existing_security_instructions_are_intact() -> None:
    """Fix #2 must not weaken anything already there."""
    prompt = build_prompt(CTX)
    for required in (
        "Return EXACTLY ONE action object",
        "Never output JavaScript",
        "Untrusted content warning",
        "NEVER use \"type\" on an element whose label contains a redaction token",
        "NEVER use \"type\" with a null or empty value",
        "NEVER include value_ref unless the action is exactly \"type_secret\"",
    ):
        assert required in prompt, f"missing security instruction: {required!r}"
