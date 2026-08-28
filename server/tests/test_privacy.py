"""Privacy guarantees of the server-side reasoning path.

The server never holds raw PII: the client redacts before sending, and
context_validator re-checks on arrival. These tests assert that nothing
in the reasoning path reintroduces it — into the prompt, the response,
or the logs.
"""

import asyncio
import json
import logging

import pytest

from app.llm.client import OllamaReasoningClient
from app.llm.errors import ActionRejected
from app.llm.prompt import build_prompt
from app.llm.validation import build_validated_action
from app.models.context import SanitizedContext
from tests.conftest import action_json, ollama_transport

# Values that must never appear anywhere in the pipeline. If one of these
# shows up, redaction upstream failed AND the server amplified it.
CANARIES = ("hunter2", "victim@example.com", "4242424242424242", "Jane Q. Testperson")


def test_prompt_contains_only_tokens_never_raw_values(checkout_context: SanitizedContext) -> None:
    """The prompt is built from the sanitized context, so the only
    representation of private data in it is the token.
    """
    prompt = build_prompt(checkout_context)
    for canary in CANARIES:
        assert canary not in prompt, f"raw value {canary!r} leaked into the prompt"
    assert "[PASSWORD_01]" in prompt, "the token itself should be present — that's what the model reasons over"


def test_prompt_marks_page_content_untrusted(checkout_context: SanitizedContext) -> None:
    """Element labels are attacker-influenced; the prompt must say so."""
    prompt = build_prompt(checkout_context).lower()
    assert "untrusted" in prompt
    assert "ignore" in prompt  # instructions embedded in page text must be ignored


def test_prompt_forbids_code_and_secret_output(checkout_context: SanitizedContext) -> None:
    prompt = build_prompt(checkout_context).lower()
    assert "javascript" in prompt
    assert "exactly one action" in prompt


def test_response_cannot_carry_raw_pii(checkout_context: SanitizedContext) -> None:
    """Even if the model emits a raw value, validation refuses it — so no
    raw PII can reach the extension through the action.
    """
    for canary in ("victim@example.com", "4242424242424242"):
        with pytest.raises(ActionRejected):
            build_validated_action(
                {"action": "type", "element_id": 5, "value": canary, "confidence": 0.9},
                checkout_context,
            )


def test_type_secret_response_contains_no_value(checkout_context: SanitizedContext) -> None:
    """The whole point of type_secret: the server names the field, the
    browser supplies the value. The response must carry no value.
    """
    action = build_validated_action(
        {"action": "type_secret", "element_id": 4, "value_ref": "[PASSWORD_01]", "confidence": 0.9},
        checkout_context,
    )
    serialised = json.dumps(action.model_dump())
    assert action.value is None
    for canary in CANARIES:
        assert canary not in serialised


def test_logs_do_not_contain_model_output_or_field_values(
    checkout_context: SanitizedContext, caplog: pytest.LogCaptureFixture
) -> None:
    """A refusal is logged with a reason we authored — never with the
    model's raw text or the context's field values.
    """
    client = OllamaReasoningClient(
        model="test-model",
        base_url="http://localhost:11434",
        timeout_s=5.0,
        transport=ollama_transport(response_text=action_json(element_id=999)),
    )
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(ActionRejected):
            asyncio.run(client.propose_action(checkout_context))

    logged = "\n".join(record.getMessage() for record in caplog.records)
    for canary in CANARIES:
        assert canary not in logged


def test_parse_failure_log_truncates_model_output(caplog: pytest.LogCaptureFixture) -> None:
    """Unparseable model output is logged for debugging, but bounded —
    it is derived from page content and could be large or hostile.
    """
    ctx = SanitizedContext(
        task_id="t", task="do a thing", page="p", url_origin="http://localhost:8000", elements=[], fields={}
    )
    huge = "x" * 5000
    client = OllamaReasoningClient(
        model="test-model",
        base_url="http://localhost:11434",
        timeout_s=5.0,
        transport=ollama_transport(response_text=huge),
    )
    with caplog.at_level(logging.WARNING):
        with pytest.raises(Exception):
            asyncio.run(client.propose_action(ctx))

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert len(logged) < 1000, "model output must be truncated in logs, not dumped whole"
