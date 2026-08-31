"""POST /complete — is the user's stated task finished?

A sibling of /reason, not a replacement and not a variant of it.
/reason stays byte-for-byte unchanged; this module imports nothing from
it beyond the shared context validator and the shared error hierarchy.

Stateless, like /reason: everything needed for the judgement arrives in
the request. No session, no cached page state, no task memory. Two
identical requests get the same answer because nothing is remembered
between them, not because anything is stored.

The endpoint returns a JUDGEMENT ONLY. It authorizes nothing, executes
nothing, and returns no element, value, or URL — there is nothing in the
response for a client to act on. Action validation, execution, PVM
verification and any user confirmation all remain client-side, exactly
as before.
"""

import logging
import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.config import load_settings
from app.llm.completion import CompletionProbe
from app.llm.errors import ReasoningError
from app.models.completion import CompletionResponse
from app.models.context import SanitizedContext
from app.validators.context_validator import assert_context_is_sanitized

logger = logging.getLogger(__name__)
router = APIRouter()


def build_probe() -> CompletionProbe:
    """Always the real probe — there is no stub variant.

    A stub returning a fixed `complete` value would be actively
    dangerous: `false` makes every task run to the client's step budget,
    and `true` ends tasks that never finished. A client that cannot
    reach a working model should get an error and fall back to its own
    deterministic no-progress detection, which is the hybrid design's
    whole point.
    """
    return CompletionProbe(settings=load_settings())


_probe = build_probe()


@router.post("/complete", response_model=CompletionResponse)
async def complete(context: SanitizedContext) -> CompletionResponse | JSONResponse:
    """Judge whether the task described by `context.task` is complete.

    Same privacy boundary as /reason: assert_context_is_sanitized runs
    before the model sees anything, and raises ContextRejected (422) for
    a payload whose field values are not redaction tokens.

    FAIL CLOSED. Every failure below returns an error status. None
    returns `complete: true`, and none returns `complete: false` either
    — a false verdict would be indistinguishable from a real "not
    finished yet" answer, which would silently push the client to keep
    acting on a task the server could not actually assess.
    """
    started = time.perf_counter()

    try:
        assert_context_is_sanitized(context)
        result = await _probe.judge(context)
    except ReasoningError as exc:
        # Reasons are authored in our own code and never interpolate page
        # content, model output, or field values.
        logger.warning(
            "complete_refused task_id=%s model=%s ms=%d code=%s reason=%s",
            context.task_id,
            _probe.model,
            int((time.perf_counter() - started) * 1000),
            exc.code,
            exc.reason,
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.code, "detail": exc.reason, "task_id": context.task_id},
        )

    logger.info(
        "complete_ok task_id=%s model=%s ms=%d complete=%s steps=%d",
        context.task_id,
        _probe.model,
        int((time.perf_counter() - started) * 1000),
        result.complete,
        len(context.history),
    )
    return result
