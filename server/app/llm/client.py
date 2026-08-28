"""Reasoning backends.

Pipeline for the real one:
    SanitizedContext -> prompt.build_prompt -> Ollama -> raw text
    -> JSON parse -> validation.build_validated_action -> ActionResponse

Every failure raises a typed error from app.llm.errors. Nothing here
invents an action to paper over a failure — see errors.py for why that
matters.
"""

import json
import logging
from abc import ABC, abstractmethod
from typing import Any

import httpx

from app.config import Settings, load_settings
from app.llm.errors import ModelOutputInvalid, ModelUnavailable
from app.llm.prompt import build_prompt
from app.llm.validation import build_validated_action
from app.models.action import ActionResponse
from app.models.context import SanitizedContext

logger = logging.getLogger(__name__)


class ReasoningClient(ABC):
    """Swap implementations behind this interface — nothing outside this
    module should know which one is in use. Selected in
    app/routes/reason.py from Settings.
    """

    #: Reported in logs and health output so it's always clear which
    #: backend produced (or refused) an action.
    name: str = "abstract"

    @abstractmethod
    async def propose_action(self, context: SanitizedContext) -> ActionResponse: ...


class StubReasoningClient(ReasoningClient):
    """Deterministic stand-in requiring no GPU and no running model — the
    default backend, so the other five roles can develop against a live
    /reason endpoint with zero setup. Always proposes a harmless 'wait'.

    This is the one place a fixed action is legitimate: it is the
    configured behaviour of this backend, not a fallback masking a
    failure.
    """

    name = "stub"

    async def propose_action(self, context: SanitizedContext) -> ActionResponse:
        return ActionResponse(
            action="wait",
            amount=500,
            confidence=0.99,
            task_id=context.task_id,
            step_id=len(context.history) + 1,
        )



class OllamaReasoningClient(ReasoningClient):
    """Local reasoning via Ollama.

    Privacy note: the payload reaching this client is already sanitized
    — the client-side firewall redacted it and
    validators/context_validator.py re-checked it on arrival. The server
    never holds raw passwords, PII, or local profile values, so there is
    nothing sensitive here to forward to the model.

    `transport` exists so tests can drive the whole pipeline through
    httpx.MockTransport without a running Ollama.
    """

    name = "ollama"

    def __init__(
        self,
        model: str | None = None,
        base_url: str | None = None,
        timeout_s: float | None = None,
        settings: Settings | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        resolved = settings or load_settings()
        self.model = model or resolved.ollama_model
        self.base_url = (base_url or resolved.ollama_base_url).rstrip("/")
        self.timeout_s = timeout_s if timeout_s is not None else resolved.ollama_timeout_s
        self._transport = transport

    async def propose_action(self, context: SanitizedContext) -> ActionResponse:
        raw_text = await self._generate(build_prompt(context))
        data = self._parse_json(raw_text)
        # Deterministic security + semantic validation. Raises
        # ActionRejected; deliberately not caught here.
        return build_validated_action(data, context)

    async def _generate(self, prompt: str) -> str:
        """Call Ollama and return the raw completion text."""
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s, transport=self._transport) as client:
                response = await client.post(
                    f"{self.base_url}/api/generate",
                    json={
                        "model": self.model,
                        "prompt": prompt,
                        "format": "json",
                        "stream": False,
                        # temperature 0: at 0.1 the same page and task
                        # produced different actions across runs. A demo
                        # that must be reproducible cannot roll dice.
                        "options": {"temperature": 0.0},
                    },
                )
        except httpx.TimeoutException as exc:
            raise ModelUnavailable(f"Ollama timed out after {self.timeout_s}s") from exc
        except httpx.HTTPError as exc:
            raise ModelUnavailable(f"cannot reach Ollama at {self.base_url}: {exc}") from exc

        if response.status_code == 404:
            # Ollama's shape for "that model isn't pulled".
            raise ModelUnavailable(f"model {self.model!r} is not available on this Ollama instance")
        if response.status_code >= 400:
            raise ModelUnavailable(f"Ollama returned HTTP {response.status_code}")

        try:
            payload = response.json()
        except ValueError as exc:  # includes json.JSONDecodeError
            raise ModelUnavailable("Ollama returned a non-JSON envelope") from exc

        raw_text = payload.get("response") if isinstance(payload, dict) else None
        if not isinstance(raw_text, str) or not raw_text.strip():
            raise ModelOutputInvalid("Ollama envelope contained no 'response' text")
        return raw_text

    @staticmethod
    def _parse_json(raw_text: str) -> dict[str, Any]:
        """Parse the completion. Handles prose, fences, truncation."""
        try:
            data = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            # Never echo raw_text to the client — it is model output
            # derived from page content. Truncated into the server log
            # only.
            logger.warning("model output was not JSON (%s): %.200r", exc, raw_text)
            raise ModelOutputInvalid("model did not return valid JSON") from exc

        if not isinstance(data, dict):
            raise ModelOutputInvalid(f"model returned {type(data).__name__}, expected a single JSON object")
        return data
