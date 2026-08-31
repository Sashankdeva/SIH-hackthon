"""Phase 3 — adversarial reasoning-path tests.

These drive OllamaReasoningClient.propose_action directly against a
mocked transport, the same way test_ollama_client.py does — no real
Ollama required. The point of this file specifically is the checklist
from the Phase 3 spec: each test name maps to one item on that list.

Several items are ALREADY covered elsewhere and are deliberately not
duplicated here — see the note on each:
  - malformed JSON, empty response, prose instead of JSON, truncated
    JSON, JSON array instead of object: test_ollama_client.py
  - extra/unexpected JSON keys (isolated unit): test_validation.py
  - invented element_id, off-origin navigate (via prompt injection):
    test_ollama_client.py, test_validation.py

The model remains untrusted throughout: every case here proves
app.llm.validation still runs and still refuses, even now that Ollama's
`format` is schema-constrained (see app/llm/client.py's
_ACTION_JSON_SCHEMA) — schema conformance is not the same claim as
"safe to execute".
"""

import asyncio

import httpx
import pytest

from app.llm.client import OllamaReasoningClient
from app.llm.errors import ActionRejected
from app.models.context import SanitizedContext, StepRecord
from tests.conftest import action_json, ollama_transport


def run(coro):
    return asyncio.run(coro)


def client_with(transport: httpx.AsyncBaseTransport) -> OllamaReasoningClient:
    return OllamaReasoningClient(
        model="test-model", base_url="http://localhost:11434", timeout_s=5.0, transport=transport
    )


# ======================================================================
# 1. invented element IDs — see also test_ollama_client.py's
#    test_invalid_schema_is_rejected_not_fabricated
# ======================================================================


def test_invented_element_id_rejected(checkout_context: SanitizedContext) -> None:
    client = client_with(ollama_transport(response_text=action_json(element_id=9999)))
    with pytest.raises(ActionRejected, match="was not supplied"):
        run(client.propose_action(checkout_context))


# ======================================================================
# 2. invalid action types
# ======================================================================


def test_invalid_action_type_rejected(checkout_context: SanitizedContext) -> None:
    client = client_with(ollama_transport(response_text=action_json(action="delete_everything")))
    with pytest.raises(ActionRejected, match="disallowed action type"):
        run(client.propose_action(checkout_context))


# ======================================================================
# 3. unsafe URLs
# ======================================================================


def test_javascript_url_rejected(checkout_context: SanitizedContext) -> None:
    client = client_with(
        ollama_transport(response_text=action_json(action="navigate", element_id=None, url="javascript:alert(1)"))
    )
    with pytest.raises(ActionRejected, match="http/https"):
        run(client.propose_action(checkout_context))


def test_off_origin_navigate_rejected(checkout_context: SanitizedContext) -> None:
    client = client_with(
        ollama_transport(
            response_text=action_json(action="navigate", element_id=None, url="https://attacker.example.com/")
        )
    )
    with pytest.raises(ActionRejected, match="leaves origin"):
        run(client.propose_action(checkout_context))


def test_url_on_non_navigate_action_rejected(checkout_context: SanitizedContext) -> None:
    """Phase 3 tightening: url must be null unless the action is navigate."""
    client = client_with(ollama_transport(response_text=action_json(action="click", url="http://localhost:8000/x")))
    with pytest.raises(ActionRejected, match="only valid for 'navigate'"):
        run(client.propose_action(checkout_context))


# ======================================================================
# 4. literal password output
# ======================================================================


def test_literal_password_via_type_on_redacted_field_rejected(checkout_context: SanitizedContext) -> None:
    """Model tries 'type' with a plausible-looking password string,
    targeting the redacted password field directly — this must be
    refused regardless of the value's content, because 'type' is never
    the right action for a redacted field at all."""
    client = client_with(
        ollama_transport(response_text=action_json(action="type", element_id=4, value="Sup3rSecret!2024"))
    )
    with pytest.raises(ActionRejected, match="redaction token"):
        run(client.propose_action(checkout_context))


def test_type_secret_carrying_a_literal_value_rejected(checkout_context: SanitizedContext) -> None:
    """Phase 3 tightening: type_secret must not carry `value` at all,
    even alongside a correct value_ref."""
    client = client_with(
        ollama_transport(
            response_text=action_json(
                action="type_secret", element_id=4, value="Sup3rSecret!2024", value_ref="[PASSWORD_01]"
            )
        )
    )
    with pytest.raises(ActionRejected, match="must not carry a literal value"):
        run(client.propose_action(checkout_context))


# ======================================================================
# 5. literal email / card output
# ======================================================================


def test_literal_email_value_on_ordinary_field_rejected(checkout_context: SanitizedContext) -> None:
    client = client_with(
        ollama_transport(response_text=action_json(action="type", element_id=5, value="attacker@example.com"))
    )
    with pytest.raises(ActionRejected, match="raw email"):
        run(client.propose_action(checkout_context))


def test_literal_card_number_value_rejected(checkout_context: SanitizedContext) -> None:
    client = client_with(
        ollama_transport(response_text=action_json(action="type", element_id=5, value="4111111111111111"))
    )
    with pytest.raises(ActionRejected, match="long digit sequence"):
        run(client.propose_action(checkout_context))


# ======================================================================
# 8. extra JSON keys — client-level, distinct from test_validation.py's
#    isolated unit test on the same rule
# ======================================================================


def test_extra_json_key_rejected(checkout_context: SanitizedContext) -> None:
    client = client_with(
        ollama_transport(response_text='{"action":"click","element_id":6,"confidence":0.9,"reasoning":"because"}')
    )
    with pytest.raises(ActionRejected, match="unexpected field"):
        run(client.propose_action(checkout_context))


# ======================================================================
# 9. repeated action
# ======================================================================


def test_repeating_an_already_succeeded_action_is_validated_not_blocked(
    checkout_context: SanitizedContext,
) -> None:
    """Characterization test, not a bug report: a repeat is inert
    (harmless), not unsafe, so app.llm.validation deliberately does NOT
    reject it — blocking repeats deterministically would risk blocking a
    legitimate retry the client's own PVM/recovery layer asked for.

    A prompt rule discouraging blind repetition was tried this phase and
    reverted — it measurably regressed an unrelated single-shot case in
    the benchmark (see prompt.py's "Tried and reverted" comment). Left
    unaddressed at the prompt layer for now rather than re-attempting
    without a formulation that's actually been measured to help.
    """
    ctx = checkout_context.model_copy(
        update={
            "history": [
                StepRecord(step=1, action="click", element_id=6, element_label="Place Order", outcome="success"),
            ]
        }
    )
    client = client_with(ollama_transport(response_text=action_json(action="click", element_id=6)))
    action = run(client.propose_action(ctx))
    assert action.action == "click"
    assert action.step_id == 2


# ======================================================================
# 10. incorrect task ID / step ID — the model does not supply either;
#     confirm an attempt to smuggle one in is rejected outright rather
#     than silently overridden.
# ======================================================================


def test_model_supplied_task_id_is_rejected(checkout_context: SanitizedContext) -> None:
    client = client_with(
        ollama_transport(response_text='{"action":"click","element_id":6,"confidence":0.9,"task_id":"attacker-chosen"}')
    )
    with pytest.raises(ActionRejected, match="unexpected field"):
        run(client.propose_action(checkout_context))


def test_model_supplied_step_id_is_rejected(checkout_context: SanitizedContext) -> None:
    client = client_with(
        ollama_transport(response_text='{"action":"click","element_id":6,"confidence":0.9,"step_id":999}')
    )
    with pytest.raises(ActionRejected, match="unexpected field"):
        run(client.propose_action(checkout_context))


def test_step_id_is_always_server_computed_from_history_length(checkout_context: SanitizedContext) -> None:
    """Positive counterpart to the two tests above: step_id is correct
    BECAUSE it's server-computed, never client- or model-supplied."""
    ctx = checkout_context.model_copy(
        update={
            "history": [
                StepRecord(step=1, action="type_secret", element_id=4, element_label="[PASSWORD_01]", outcome="success"),
                StepRecord(step=2, action="click", element_id=6, element_label="Place Order", outcome="ambiguous"),
            ]
        }
    )
    client = client_with(ollama_transport(response_text=action_json(action="click", element_id=6)))
    action = run(client.propose_action(ctx))
    assert action.step_id == 3
    assert action.task_id == ctx.task_id


# ======================================================================
# 11. legitimate done
# ======================================================================


def test_legitimate_done_with_prior_history_succeeds(checkout_context: SanitizedContext) -> None:
    ctx = checkout_context.model_copy(
        update={
            "history": [
                StepRecord(step=1, action="click", element_id=6, element_label="Place Order", outcome="success"),
            ]
        }
    )
    client = client_with(ollama_transport(response_text='{"action":"done","confidence":0.95}'))
    action = run(client.propose_action(ctx))
    assert action.action == "done"
    assert action.element_id is None
    assert action.value is None
    assert action.value_ref is None
    assert action.url is None
    assert action.step_id == 2


def test_done_with_a_forbidden_field_rejected(checkout_context: SanitizedContext) -> None:
    """Rule 11's guardrail, confirmed enforced deterministically:
    'done' carrying element_id is a prompt-injection-shaped risk, not
    just a formatting slip."""
    ctx = checkout_context.model_copy(
        update={
            "history": [
                StepRecord(step=1, action="click", element_id=6, element_label="Place Order", outcome="success"),
            ]
        }
    )
    client = client_with(ollama_transport(response_text='{"action":"done","element_id":6,"confidence":0.95}'))
    with pytest.raises(ActionRejected, match="bare terminal signal"):
        run(client.propose_action(ctx))


# ======================================================================
# 12. valid multi-step history
# ======================================================================


def test_valid_action_with_multi_step_history(checkout_context: SanitizedContext) -> None:
    ctx = checkout_context.model_copy(
        update={
            "history": [
                StepRecord(step=1, action="type_secret", element_id=2, element_label="[PERSON_NAME_01]", outcome="success"),
                StepRecord(step=2, action="type_secret", element_id=3, element_label="[EMAIL_01]", outcome="success"),
                StepRecord(step=3, action="type_secret", element_id=4, element_label="[PASSWORD_01]", outcome="success"),
            ]
        }
    )
    client = client_with(ollama_transport(response_text=action_json(action="click", element_id=6)))
    action = run(client.propose_action(ctx))
    assert action.action == "click"
    assert action.element_id == 6
    assert action.step_id == 4
    assert action.task_id == ctx.task_id
