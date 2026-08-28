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
