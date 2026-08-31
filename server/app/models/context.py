from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator


class CapturedElement(BaseModel):
    element_id: int
    role: str
    label: str | None = None
    #: Whether the control is unavailable for interaction. The client
    #: already derives this from the native `disabled` property,
    #: `aria-disabled`, and `fieldset[disabled]` inheritance
    #: (extension/src/perception/domCapture.ts); this field is what
    #: carries it across the wire.
    #:
    #: Defaults to False so a client that does not send the field — every
    #: client before this was added — is accepted unchanged. "Absent"
    #: therefore means "not known to be disabled", NOT "known to be
    #: enabled"; the two are indistinguishable on the wire by design, and
    #: the prompt renders nothing for either (see app/llm/prompt.py).
    disabled: bool = False
    #: WHETHER an editable control currently holds content — never WHAT
    #: it holds. Added to close a measured end-to-end failure: after a
    #: successful `type`, the next request's context looked identical to
    #: the one before it (role + label only, never values), so the model
    #: had no way to observe that the field was now filled and re-typed
    #: the same text instead of moving on. Two prompt-only attempts to
    #: fix that by reasoning over history alone were measured and both
    #: failed — see app/llm/prompt.py's "Tried and reverted" notes.
    #:
    #: A closed three-token enum is the privacy mechanism, not merely a
    #: type: because nothing else validates, a raw value (a password, a
    #: query, any PII) CANNOT travel in this field even if a client sent
    #: one — Pydantic rejects it before reasoning runs. "redacted" and
    #: "nonempty" differ only in the client's sensitivity
    #: classification; neither discloses content.
    #:
    #: Optional, defaulting to None. Absent means "the client does not
    #: report field state" and is NOT a claim of emptiness — the same
    #: convention `disabled` uses above, and the reason the prompt
    #: renders this only when present.
    value_state: Literal["empty", "nonempty", "redacted"] | None = None


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
    #: Required, matching shared/schemas/sanitized-context.schema.json
    #: (both are in its top-level "required" list) and the extension's
    #: own serializer (toWireSanitizedContext always includes both keys,
    #: even when the arrays/maps are empty). A prior default_factory
    #: silently accepted an omitted key here, which the JSON schema
    #: never allowed — tightened to match the contract actually in use,
    #: not to add a new restriction.
    elements: list[CapturedElement]
    fields: dict[str, str]
    #: Optional sanitized history from previous steps in this task.
    #: Absent or empty on the first step. The server is stateless —
    #: the extension builds and sends this; nothing is stored here.
    history: list[StepRecord] = Field(default_factory=list)
    #: Optional structural route (pathname only) for the CURRENT page,
    #: e.g. "/search" or "/product/123" — never a full URL. The client
    #: derives this straight from location.pathname
    #: (extension/src/privacy/sanitizedContext.ts), which already
    #: excludes query strings, hash fragments, and credentials by
    #: construction; the validator below re-checks the shape rather than
    #: trusting that.
    #:
    #: Optional, defaulting to None, for the same backward-compatibility
    #: reason as `disabled` on CapturedElement above: every client built
    #: before this field existed omits it. Absent means "route unknown" —
    #: the server must never substitute "/" or any other guessed default.
    route_hint: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] | None = None

    @field_validator("route_hint")
    @classmethod
    def _validate_route_hint(cls, value: str | None) -> str | None:
        """Reject anything that isn't a bare pathname. Defence in depth,
        independent of the client: a pathname never contains a scheme,
        host, or credentials, and never carries control characters."""
        if value is None:
            return value
        if not value.startswith("/") or value.startswith("//"):
            raise ValueError("route_hint must be a pathname starting with a single '/'")
        if "://" in value:
            raise ValueError("route_hint must not contain a scheme — pathname only, not a full URL")
        if any(c in value for c in ("\n", "\r", "\t")):
            raise ValueError("route_hint must not contain control characters")
        return value
