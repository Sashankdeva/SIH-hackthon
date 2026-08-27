from fastapi import APIRouter

from app.llm.client import StubReasoningClient
from app.models.action import ActionResponse
from app.models.context import SanitizedContext
from app.validators.context_validator import assert_context_is_sanitized

router = APIRouter()
_client = StubReasoningClient()


@router.post("/reason", response_model=ActionResponse)
async def reason(context: SanitizedContext) -> ActionResponse:
    """The extension's only server call. Context Validator runs first
    (assert_context_is_sanitized) — reasoning never sees a payload that
    hasn't passed the privacy check.
    """
    assert_context_is_sanitized(context)
    return await _client.propose_action(context)
