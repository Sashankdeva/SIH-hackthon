from abc import ABC, abstractmethod

from app.models.action import ActionResponse
from app.models.context import SanitizedContext


class ReasoningClient(ABC):
    """Swap implementations behind this interface — a cloud API during
    SIH, a self-hosted open-weight model later. Nothing outside this
    module should know which one is in use. See
    PS26171_Role4_Server.pdf, Day 1: pick and freeze the cloud API here.
    """

    @abstractmethod
    async def propose_action(self, context: SanitizedContext) -> ActionResponse: ...


class StubReasoningClient(ReasoningClient):
    """Deterministic stand-in so the rest of the pipeline is testable
    before a real LLM/VLM is wired in. Always proposes a harmless
    'wait'. Replace with a real cloud API call — Day 2/3 task.
    """

    async def propose_action(self, context: SanitizedContext) -> ActionResponse:
        return ActionResponse(
            action="wait",
            amount=500,
            confidence=0.99,
            task_id=context.task_id,
            step_id=1,
        )
