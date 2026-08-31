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
from typing import Any, get_args

import httpx

from app.config import Settings, load_settings
from app.llm.errors import ContextTooLarge, ModelOutputInvalid, ModelUnavailable
from app.llm.prompt import build_prompt
from app.llm.validation import build_validated_action
from app.models.action import ActionResponse, ActionType
from app.models.context import SanitizedContext

logger = logging.getLogger(__name__)

# Passed as Ollama's `format` instead of the bare string "json". Ollama
# grammar-constrains generation to match this shape (a llama.cpp GBNF
# grammar under the hood), so the model CANNOT emit an extra key, a
# wrong-typed field, or an out-of-enum action value — those failure
# classes are prevented at the sampling level rather than caught after
# the fact. Confirmed working against qwen2.5:7b-instruct on Ollama
# 0.33.1 by direct /api/generate testing before adopting this.
#
# This is a reliability improvement, not a security boundary: it
# constrains STRUCTURE, not truthfulness. A schema-conformant action can
# still name an invented element_id, mismatch a value_ref, or navigate
# off-origin — app.llm.validation still runs unchanged on every
# response and remains the actual authority. Same reasoning as the
# untrusted-content warning in prompt.py: a smarter output format is
# still a request, not a control.
#: SERVER PHASE S6.1 — a deliberately pessimistic (i.e. UNDER-estimates
#: chars/token, so OVER-estimates token count) floor, used only to
#: reject an oversized prompt BEFORE sending it to Ollama. Measured
#: chars-per-token for this project's actual rendered prompts ranges
#: ~2.2 (large, highly repetitive element lists) to ~3.9 (short
#: prompts); 2.0 stays conservative below even the densest measured
#: case, on the safe side (predicting MORE tokens than reality errs
#: toward rejecting slightly early, never toward missing a real
#: overrun).
#:
#: This exists because Ollama's OWN post-hoc prompt_eval_count is not a
#: reliable truncation signal: measured directly, when the true prompt
#: exceeds num_ctx, Ollama does not clip it to fit near num_ctx (or
#: num_ctx - num_predict) — it collapses to roughly HALF of num_ctx
#: regardless of num_predict (a 4096-token load plateaued at 2050; a
#: 16384-token load plateaued at 8194; a 32768-token load plateaued at
#: 16386 — each ~num_ctx/2). A post-hoc check looking for
#: prompt_eval_count "near the ceiling" would never fire, because a
#: truncated response reports a count far BELOW the ceiling, not at it.
#: Catching this before the network call, from the prompt this process
#: already rendered, sidesteps needing to characterize that internal
#: behavior further.
MIN_CHARS_PER_TOKEN = 2.0

_ACTION_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": list(get_args(ActionType))},
        "element_id": {"type": ["integer", "null"]},
        "value": {"type": ["string", "null"]},
        "value_ref": {"type": ["string", "null"]},
        "direction": {"type": ["string", "null"], "enum": ["up", "down", "left", "right", None]},
        "amount": {"type": ["number", "null"]},
        "url": {"type": ["string", "null"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["action", "confidence"],
    "additionalProperties": False,
}


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

    def set_http_client(self, client: httpx.AsyncClient | None) -> None:
        """Installs (or clears) a shared httpx.AsyncClient for backends
        that make real HTTP calls. No-op by default — StubReasoningClient
        never touches HTTP, so it has nothing to install this into.
        Called by the FastAPI lifespan (app/main.py) at startup/shutdown.
        """
        return


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
        num_ctx: int | None = None,
        num_predict: int | None = None,
        settings: Settings | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        resolved = settings or load_settings()
        self.model = model or resolved.ollama_model
        self.base_url = (base_url or resolved.ollama_base_url).rstrip("/")
        self.timeout_s = timeout_s if timeout_s is not None else resolved.ollama_timeout_s
        # SERVER PHASE S6.1 — see app/config.py's DEFAULT_OLLAMA_NUM_CTX
        # comment for why these are explicit rather than left to
        # Ollama's own defaults (a silently truncated prompt, not an
        # error).
        self.num_ctx = num_ctx if num_ctx is not None else resolved.ollama_num_ctx
        self.num_predict = num_predict if num_predict is not None else resolved.ollama_num_predict
        self._transport = transport
        # Set by the FastAPI lifespan via set_http_client(); None means
        # "no shared client is installed" (e.g. this instance was built
        # directly by a test or a standalone script, not served by the
        # app) and _generate falls back to the original per-call client.
        self._http_client: httpx.AsyncClient | None = None

    def set_http_client(self, client: httpx.AsyncClient | None) -> None:
        """See ReasoningClient.set_http_client. Storing None (the
        lifespan's own shutdown behavior) is what makes it safe for this
        instance to outlive one particular shared client: the next call
        simply falls back to constructing its own, rather than reusing a
        reference to a client that has since been closed.
        """
        self._http_client = client

    async def propose_action(self, context: SanitizedContext) -> ActionResponse:
        raw_text = await self._generate(build_prompt(context))
        data = self._parse_json(raw_text)
        # Deterministic security + semantic validation. Raises
        # ActionRejected; deliberately not caught here.
        return build_validated_action(data, context)

    async def _generate(self, prompt: str) -> str:
        """Call Ollama and return the raw completion text.

        Reuses the shared, lifespan-managed client when one is installed
        (the normal production path — avoids paying ~436ms to construct
        a fresh httpx.AsyncClient per call, measured in the prior
        connection-overhead investigation) and otherwise falls back to
        exactly the original per-call `async with httpx.AsyncClient(...)`
        pattern, unchanged. Same request, same timeout, same transport
        override support either way — only the client's own lifetime
        differs.
        """
        # SERVER PHASE S6.1 — reject BEFORE calling Ollama if this
        # prompt's pessimistic token estimate would exceed the
        # configured budget. See MIN_CHARS_PER_TOKEN's own comment for
        # why this has to happen pre-flight rather than by inspecting
        # Ollama's post-hoc prompt_eval_count: a truncated response's
        # reported count lands near num_ctx/2, not near the ceiling, so
        # checking "close to the ceiling" would never catch it.
        budget = self.num_ctx - self.num_predict
        estimated_tokens = len(prompt) / MIN_CHARS_PER_TOKEN
        if estimated_tokens > budget:
            raise ContextTooLarge(
                f"rendered prompt is ~{estimated_tokens:.0f} tokens (estimated from "
                f"{len(prompt)} chars), over the configured budget ({budget} = num_ctx "
                f"{self.num_ctx} - num_predict {self.num_predict}) — refusing rather than "
                "risk Ollama silently truncating the context"
            )

        request_json = {
            "model": self.model,
            "prompt": prompt,
            "format": _ACTION_JSON_SCHEMA,
            "stream": False,
            "options": {
                # temperature 0: at 0.1 the same page and task
                # produced different actions across runs. A demo
                # that must be reproducible cannot roll dice.
                "temperature": 0.0,
                # SERVER PHASE S6.1 — explicit, not left to Ollama's own
                # default (which loads this model at a 4096-token
                # runtime context regardless of its true 32768 capacity,
                # and was measured to silently truncate any prompt past
                # ~150 elements to exactly 2050 tokens rather than
                # erroring). See app/config.py's DEFAULT_OLLAMA_NUM_CTX
                # comment for the measured VRAM cost behind this value
                # and app/config.py's DEFAULT_OLLAMA_NUM_PREDICT comment
                # for the generation-budget reasoning.
                "num_ctx": self.num_ctx,
                "num_predict": self.num_predict,
            },
        }
        url = f"{self.base_url}/api/generate"
        try:
            if self._http_client is not None:
                response = await self._http_client.post(url, json=request_json, timeout=self.timeout_s)
            else:
                async with httpx.AsyncClient(timeout=self.timeout_s, transport=self._transport) as client:
                    response = await client.post(url, json=request_json)
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
