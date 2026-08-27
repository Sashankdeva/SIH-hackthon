from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ActionType = Literal["click", "type", "type_secret", "scroll", "navigate", "keypress", "wait"]


class ActionResponse(BaseModel):
    """Mirrors shared/schemas/action.schema.json. The extension is the
    only thing that ever executes this — the server never touches the
    browser directly.
    """

    model_config = ConfigDict(extra="forbid")

    action: ActionType
    element_id: int | None = None
    value: str | None = None
    value_ref: str | None = None
    direction: Literal["up", "down", "left", "right"] | None = None
    amount: float | None = None
    url: str | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    task_id: str
    step_id: int
