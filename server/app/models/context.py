from pydantic import BaseModel, ConfigDict, Field


class CapturedElement(BaseModel):
    element_id: int
    role: str
    label: str | None = None


class SanitizedContext(BaseModel):
    """The only payload shape the server accepts. Mirrors
    shared/schemas/sanitized-context.schema.json — keep both in sync.
    `extra="forbid"` rejects any unexpected raw field outright; this is
    the server-side half of the privacy firewall.
    """

    model_config = ConfigDict(extra="forbid")

    task_id: str
    page: str
    url_origin: str
    elements: list[CapturedElement] = Field(default_factory=list)
    fields: dict[str, str] = Field(default_factory=dict)
