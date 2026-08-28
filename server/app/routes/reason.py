import logging
import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.config import load_settings
from app.llm.client import OllamaReasoningClient, ReasoningClient, StubReasoningClient
from app.llm.errors import ReasoningError
from app.models.action import ActionResponse
from app.models.context import SanitizedContext
from app.validators.context_validator import assert_context_is_sanitized

logger = logging.getLogger(__name__)
router = APIRouter()


def build_client() -> ReasoningClient:
    """Defaults to the stub so the other five roles can run the server
    with zero setup. Server AI sets REASONING_BACKEND=ollama locally to
    test against the real model on this machine's GPU.
    """
    settings = load_settings()
    if settings.uses_ollama:
        return OllamaReasoningClient(settings=settings)
    return StubReasoningClient()


_client = build_client()


@router.post("/reason", response_model=ActionResponse)
async def reason(context: SanitizedContext) -> ActionResponse | JSONResponse:
    """The extension's only server call.

    Context Validator runs first — reasoning never sees a payload that
    hasn't passed the privacy check, regardless of backend.

    On any failure this returns a real error status, never HTTP 200 with
    a fabricated action. The extension must be able to tell "do nothing"
    (a deliberate `wait`) apart from "the server could not answer".
    """
    assert_context_is_sanitized(context)

    started = time.perf_counter()
    backend = getattr(_client, "name", "unknown")
    model = getattr(_client, "model", "-")

    try:
        action = await _client.propose_action(context)
    except ReasoningError as exc:
        # Operational log only: task identity, backend, timing, and the
        # refusal reason. Reasons are authored in our own code and never
        # interpolate page content, model output, or field values.
        logger.warning(
            "reason_refused task_id=%s backend=%s model=%s ms=%d code=%s reason=%s",
            context.task_id,
            backend,
            model,
            int((time.perf_counter() - started) * 1000),
            exc.code,
            exc.reason,
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.code, "detail": exc.reason, "task_id": context.task_id},
        )

    logger.info(
        "reason_ok task_id=%s backend=%s model=%s ms=%d action=%s element_id=%s confidence=%.2f",
        context.task_id,
        backend,
        model,
        int((time.perf_counter() - started) * 1000),
        action.action,
        action.element_id,
        action.confidence,
    )
    return action
