import json
import logging
from abc import ABC, abstractmethod

import httpx

from app.models.action import ActionResponse, ActionType
from app.models.context import SanitizedContext

logger = logging.getLogger(__name__)

ALLOWED_ACTIONS: set[ActionType] = {
    "click",
    "type",
    "type_secret",
    "scroll",
    "navigate",
    "keypress",
    "wait",
}


class ReasoningClient(ABC):
    """Swap implementations behind this interface — nothing outside this
    module should know which one is in use. The active implementation is
    selected in app/routes/reason.py via the REASONING_BACKEND env var.
    """

    @abstractmethod
    async def propose_action(self, context: SanitizedContext) -> ActionResponse: ...


class StubReasoningClient(ReasoningClient):
    """Deterministic stand-in requiring no GPU and no running model — the
    default backend. This is what the other five roles run against so
    nobody but Server AI needs a local model installed to develop
    against a live /reason endpoint. Always proposes a harmless 'wait'.
    """

    async def propose_action(self, context: SanitizedContext) -> ActionResponse:
        return ActionResponse(
            action="wait",
            amount=500,
            confidence=0.99,
            task_id=context.task_id,
            step_id=1,
        )


class OllamaReasoningClient(ReasoningClient):
    """Local reasoning via Ollama — the project's actual choice: privacy
    is enforced by redacting PII client-side before anything is sent
    (extension/src/privacy/), not by avoiding a server. Running the
    reasoning model locally too is a deliberate step further, not a
    requirement of the architecture, and it means the machine running
    this needs a real GPU (see docs/ARCHITECTURE.md, hardware note).

    Requires Ollama running locally (`ollama serve`, default port 11434)
    with the model already pulled (`ollama pull <model>`).
    """

    def __init__(self, model: str = "qwen2.5:7b-instruct", base_url: str = "http://localhost:11434") -> None:
        self.model = model
        self.base_url = base_url.rstrip("/")

    async def propose_action(self, context: SanitizedContext) -> ActionResponse:
        prompt = self._build_prompt(context)
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self.base_url}/api/generate",
                    json={
                        "model": self.model,
                        "prompt": prompt,
                        "format": "json",
                        "stream": False,
                        "options": {"temperature": 0.1},
                    },
                )
                response.raise_for_status()
                raw_text = response.json()["response"]
        except (httpx.HTTPError, KeyError) as exc:
            logger.error("Ollama call failed (%s) — falling back to a safe 'wait'.", exc)
            return self._safe_fallback(context)

        return self._parse_response(raw_text, context)

    def _build_prompt(self, context: SanitizedContext) -> str:
        elements_desc = "\n".join(
            f"- id={el.element_id} role={el.role} label={el.label!r}" for el in context.elements
        )
        return f"""You are a browser automation reasoning engine. You only ever see
sanitized data — every field value below is already a redaction token
([EMAIL_01], [PASSWORD_FIELD], etc.), never a real value. You do not need
and will never receive the real value.

Page: {context.page}
Origin: {context.url_origin}
Task ID: {context.task_id}

Interactive elements:
{elements_desc or "(none captured)"}

Redacted fields present: {list(context.fields.values())}

Respond with ONLY a JSON object matching this exact shape, no other text:
{{
  "action": "click" | "type" | "type_secret" | "scroll" | "navigate" | "keypress" | "wait",
  "element_id": <int or null>,
  "value": <string or null>,
  "confidence": <float 0-1>
}}"""

    def _parse_response(self, raw_text: str, context: SanitizedContext) -> ActionResponse:
        try:
            data = json.loads(raw_text)
            action = data.get("action")
            if action not in ALLOWED_ACTIONS:
                raise ValueError(f"model returned disallowed action: {action!r}")
            return ActionResponse(
                action=action,
                element_id=data.get("element_id"),
                value=data.get("value"),
                confidence=float(data.get("confidence", 0.5)),
                task_id=context.task_id,
                step_id=1,
            )
        except (json.JSONDecodeError, ValueError, TypeError) as exc:
            # A local 7B model is far less reliable at strict JSON than a
            # frontier cloud model — never let a malformed response reach
            # the extension's action validator. Fail safe, not silently.
            logger.error("Could not parse Ollama response (%s): %r", exc, raw_text)
            return self._safe_fallback(context)

    def _safe_fallback(self, context: SanitizedContext) -> ActionResponse:
        return ActionResponse(action="wait", amount=500, confidence=0.0, task_id=context.task_id, step_id=1)
