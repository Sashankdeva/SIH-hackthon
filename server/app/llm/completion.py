"""Completion probe — an isolated second reasoning path.

Deliberately does NOT extend OllamaReasoningClient or share its
`propose_action` pipeline. That client's job is to produce a validated
ActionResponse; this one produces a boolean. Sharing the class would
couple two things that must be able to change independently, and would
make it possible for a future edit to leak action semantics into the
completion path.

What IS shared, on purpose: the transport shape, the Settings object,
and the typed error hierarchy — so a dead Ollama looks identical from
both endpoints, and /complete inherits the same 502/503 contract as
/reason without restating it.

FAIL CLOSED is the governing rule of this module. Every failure path
raises; none returns a value. `complete: true` can only ever originate
from a model that answered, whose answer parsed, and whose answer was a
real JSON boolean. A timeout, an unreachable model, malformed output, a
non-boolean, an extra field, or an unanticipated exception all become
errors — never an optimistic default. Returning "complete" on failure
would tell a user their task finished when the server has no idea
whether it did.
"""

import json
import logging
from typing import Any

import httpx

from app.config import Settings, load_settings
from app.llm.completion_prompt import build_completion_prompt
from app.llm.client import MIN_CHARS_PER_TOKEN
from app.llm.errors import ContextTooLarge, ModelOutputInvalid, ModelUnavailable
from app.models.completion import CompletionResponse
from app.models.context import SanitizedContext

logger = logging.getLogger(__name__)

#: Grammar-constrained output. Ollama enforces this at sampling time, so
#: the model cannot emit prose, a string "true", a third value, a missing
#: key, or an extra field. The parse checks below are still performed —
#: a constraint enforced by a dependency is not a guarantee this module
#: gets to assume.
COMPLETION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"complete": {"type": "boolean"}},
    "required": ["complete"],
    "additionalProperties": False,
}


class CompletionProbe:
    """Answers one question: is the user's stated task complete?

    `transport` exists so tests can drive the whole path through
    httpx.MockTransport without a running Ollama, matching the pattern
    OllamaReasoningClient already uses.
    """

    name = "completion_probe"

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
        # SERVER PHASE S6.1 — same reasoning and same values as
        # OllamaReasoningClient (app/llm/client.py): /complete renders
        # the same current-elements list /reason does, so it carries the
        # identical element-count-driven truncation risk despite its
        # otherwise much smaller prompt.
        self.num_ctx = num_ctx if num_ctx is not None else resolved.ollama_num_ctx
        self.num_predict = num_predict if num_predict is not None else resolved.ollama_num_predict
        self._transport = transport
        # Set by the FastAPI lifespan via set_http_client(); None means
        # "reuse the original per-call client" — see the identical note
        # on OllamaReasoningClient in app/llm/client.py.
        self._http_client: httpx.AsyncClient | None = None

    def set_http_client(self, client: httpx.AsyncClient | None) -> None:
        """Installed/cleared by the FastAPI lifespan at startup/shutdown
        so /complete reuses the SAME shared client /reason does — one
        pooled connection for every inference call this process makes,
        not two separate pools.
        """
        self._http_client = client

    @staticmethod
    def _deterministic_incomplete_reason(context: SanitizedContext) -> str | None:
        """Evidence gate applied BEFORE the model is consulted.

        A completion verdict is only as trustworthy as the evidence
        behind it, and one case can be settled without any judgement at
        all: if the most recent VERIFIED outcome was a failure, then
        whatever the task's final action was, it did not take effect —
        so "complete" cannot be justified no matter how the current page
        happens to read. Deciding that here, deterministically, is
        strictly safer than asking a 7B model not to be misled by
        completion-sounding page text (a measured, still-open weakness —
        see tests/test_completion_regression_live.py's pinned CP1/ML1).

        Deliberately narrow. Two neighbouring gates were considered and
        REJECTED against the existing dataset, because each would have
        introduced false NEGATIVES where the endpoint currently has
        none (0/70 measured in SERVER PHASE S5):

          * "ambiguous -> incomplete" would break SM1 and SM2, where a
            step verified ambiguous but the page itself states the task
            is done ("You are now subscribed"). Ambiguous means the
            client could not SEE a change, not that none happened, so it
            is deferred to the model, which has the page text.
          * "empty history -> incomplete" would break M1, where the
            requested state already holds before the agent acts at all
            ("Dark mode: ON").

        Returns a reason string when completion must be refused, or None
        to defer to the model.
        """
        if not context.history:
            return None
        latest = max(context.history, key=lambda record: record.step)
        if latest.outcome == "failure":
            return "most recent verified outcome was a failure"
        return None

    async def judge(self, context: SanitizedContext) -> CompletionResponse:
        """Returns a CompletionResponse or raises a ReasoningError.

        task_id comes from the validated request, never from the model —
        the model is never shown a task id and could not supply one
        through the constrained schema even if it tried.
        """
        refusal = self._deterministic_incomplete_reason(context)
        if refusal is not None:
            # Never reaches the model: no judgement can make a verified
            # failure into a completed task, and skipping the call also
            # removes a chance for the model to be wrong about it.
            logger.info(
                "complete_gated task_id=%s complete=False reason=%s", context.task_id, refusal
            )
            return CompletionResponse(complete=False, task_id=context.task_id)

        raw_text = await self._generate(build_completion_prompt(context))
        complete = self._parse_completion(raw_text)
        return CompletionResponse(complete=complete, task_id=context.task_id)

    async def _generate(self, prompt: str) -> str:
        """Same shared-client-or-fallback pattern as
        OllamaReasoningClient._generate — see its comment for why.
        """
        # SERVER PHASE S6.1 — see OllamaReasoningClient._generate's
        # identical pre-flight check and MIN_CHARS_PER_TOKEN's comment
        # in app/llm/client.py for the full reasoning: Ollama's own
        # post-hoc prompt_eval_count is not a reliable truncation
        # signal (a truncated response collapses to ~num_ctx/2, not to
        # the configured ceiling), so this is checked before the call.
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
            "format": COMPLETION_SCHEMA,
            "stream": False,
            "options": {
                # Same reasoning as the action path: a completion
                # verdict that changes between identical requests
                # is not a verdict. Measured 21/21 stable at 0.0.
                "temperature": 0.0,
                # SERVER PHASE S6.1 — see OllamaReasoningClient._generate's
                # identical comment in app/llm/client.py.
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
            raise ModelUnavailable(f"completion probe timed out after {self.timeout_s}s") from exc
        except httpx.HTTPError as exc:
            raise ModelUnavailable(f"cannot reach Ollama at {self.base_url}: {exc}") from exc

        if response.status_code == 404:
            raise ModelUnavailable(f"model {self.model!r} is not available on this Ollama instance")
        if response.status_code >= 400:
            raise ModelUnavailable(f"Ollama returned HTTP {response.status_code}")

        try:
            payload = response.json()
        except ValueError as exc:
            raise ModelUnavailable("Ollama returned a non-JSON envelope") from exc

        raw_text = payload.get("response") if isinstance(payload, dict) else None
        if not isinstance(raw_text, str) or not raw_text.strip():
            raise ModelOutputInvalid("Ollama envelope contained no 'response' text")
        return raw_text

    @staticmethod
    def _parse_completion(raw_text: str) -> bool:
        """Strict: the answer must be a JSON object whose only key is
        `complete`, carrying a real boolean.

        Rejects — never coerces — a string "true", 1, null, a missing
        key, or any extra field. Coercion here would be the exact bug
        this module is built to avoid: a truthy string quietly becoming a
        completion verdict.
        """
        try:
            data = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            # Model output is derived from page content; never echo it to
            # the client. Truncated into the server log only.
            logger.warning("completion output was not JSON (%s): %.200r", exc, raw_text)
            raise ModelOutputInvalid("completion probe did not return valid JSON") from exc

        if not isinstance(data, dict):
            raise ModelOutputInvalid(
                f"completion probe returned {type(data).__name__}, expected a single JSON object"
            )

        unexpected = set(data) - {"complete"}
        if unexpected:
            raise ModelOutputInvalid(f"completion probe returned unexpected field(s): {sorted(unexpected)}")

        if "complete" not in data:
            raise ModelOutputInvalid("completion probe omitted the 'complete' field")

        value = data["complete"]
        # `isinstance(True, int)` is True in Python, so bool must be
        # checked explicitly or 1/0 would slip through as a verdict.
        if not isinstance(value, bool):
            raise ModelOutputInvalid(
                f"'complete' must be a boolean, got {type(value).__name__}"
            )
        return value
