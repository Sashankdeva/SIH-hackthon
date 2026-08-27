from app.llm.client import OllamaReasoningClient
from app.models.context import SanitizedContext

_ctx = SanitizedContext(
    task_id="t1",
    page="login",
    url_origin="http://localhost:8000",
    elements=[{"element_id": 1, "role": "button", "label": "Submit"}],
    fields={},
)


def test_parses_valid_model_json() -> None:
    client = OllamaReasoningClient()
    raw = '{"action": "click", "element_id": 1, "value": null, "confidence": 0.87}'
    result = client._parse_response(raw, _ctx)
    assert result.action == "click"
    assert result.element_id == 1
    assert result.confidence == 0.87
    assert result.task_id == "t1"


def test_falls_back_safely_on_malformed_json() -> None:
    client = OllamaReasoningClient()
    result = client._parse_response("not json at all", _ctx)
    assert result.action == "wait"
    assert result.confidence == 0.0


def test_falls_back_safely_on_disallowed_action() -> None:
    client = OllamaReasoningClient()
    raw = '{"action": "eval_javascript", "confidence": 0.9}'
    result = client._parse_response(raw, _ctx)
    assert result.action == "wait"
    assert result.confidence == 0.0
