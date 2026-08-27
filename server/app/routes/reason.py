import os

from fastapi import APIRouter

from app.llm.client import OllamaReasoningClient, ReasoningClient, StubReasoningClient
from app.models.action import ActionResponse
from app.models.context import SanitizedContext
from app.validators.context_validator import assert_context_is_sanitized

router = APIRouter()


def _build_client() -> ReasoningClient:
    """Defaults to the stub so the other five roles can run the server
    with zero setup. Server AI sets REASONING_BACKEND=ollama locally
    (see server/README.md) to test against the real thing on this
    machine's GPU.
    """
    backend = os.getenv("REASONING_BACKEND", "stub").lower()
    if backend == "ollama":
        return OllamaReasoningClient(model=os.getenv("OLLAMA_MODEL", "qwen2.5:7b-instruct"))
    return StubReasoningClient()


_client = _build_client()


@router.post("/reason", response_model=ActionResponse)
async def reason(context: SanitizedContext) -> ActionResponse:
    """The extension's only server call. Context Validator runs first
    (assert_context_is_sanitized) — reasoning never sees a payload that
    hasn't passed the privacy check, regardless of which backend is active.
    """
    assert_context_is_sanitized(context)
    return await _client.propose_action(context)
