from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints


class CapturedElement(BaseModel):
    element_id: int
    role: str
    label: str | None = None


class StepRecord(BaseModel):
    """Sanitized summary of one completed step, sent back to the server
    so the model can see what has already been attempted.

    Privacy constraints — NOTHING from this list may appear here:
      - raw typed values (value field contents)
      - secret values (passwords, card numbers, etc.)
      - value_ref resolved values
      - full URLs containing query params or path segments with PII

    Only structural metadata is allowed: step number, action type,
    which element was targeted (by id and its already-sanitized label),
    and the PVM verification outcome. Redaction tokens such as
    [EMAIL_01] are safe because they carry no real value.
    """

    model_config = ConfigDict(extra="forbid")

    step: int = Field(ge=1, description="Step number, starting from 1.")
    action: str
    element_id: int | None = None
    element_label: str | None = None
    outcome: Literal["success", "failure", "ambiguous"]


class SanitizedContext(BaseModel):
    """The only payload shape the server accepts. Mirrors
    shared/schemas/sanitized-context.schema.json — keep both in sync.
    `extra="forbid"` rejects any unexpected raw field outright; this is
    the server-side half of the privacy firewall.
    """

    model_config = ConfigDict(extra="forbid")

    task_id: str
    #: What the user actually asked for, in their own words. The agent
    #: never runs without one — see extension/src/popup. Bounded length
    #: because it goes straight into the model prompt. Whitespace is
    #: stripped BEFORE the length check, so "   " is rejected rather
    #: than passed through as a meaningless goal (caught by
    #: test_reason_rejects_empty_task).
    task: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    page: str
    url_origin: str
    elements: list[CapturedElement] = Field(default_factory=list)
    fields: dict[str, str] = Field(default_factory=dict)
    #: Optional sanitized history from previous steps in this task.
    #: Absent or empty on the first step. The server is stateless —
    #: the extension builds and sends this; nothing is stored here.
    history: list[StepRecord] = Field(default_factory=list)
