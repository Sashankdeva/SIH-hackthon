from app.llm.errors import ContextRejected
from app.models.context import SanitizedContext


def assert_context_is_sanitized(context: SanitizedContext) -> None:
    """Server-side half of the privacy firewall. Pydantic's
    `extra="forbid"` on SanitizedContext already rejects unexpected raw
    fields at parse time; this catches redaction that ran but produced a
    value that still looks raw.

    Raises ContextRejected (a ReasoningError) rather than HTTPException
    directly, so this failure gets the same {error, detail, task_id}
    envelope and logging as every other refusal in routes/reason.py —
    see app/llm/errors.py.
    """
    for field_name, value in context.fields.items():
        if not (value.startswith("[") and value.endswith("]")):
            # SECURITY: never interpolate `value` into this message. It
            # becomes both the client-visible `detail` field (see
            # routes/reason.py's/complete.py's ReasoningError handling)
            # and a server log line (routes/reason.py's reason_refused
            # log) UNCONDITIONALLY — neither is gated by
            # LOG_FULL_REQUEST_BODY, so echoing the very value this
            # check exists to catch would leak it through both paths on
            # every rejection, defeating the check's own purpose. Found
            # and fixed during this phase's logging/error-handling audit.
            raise ContextRejected(
                f"Field '{field_name}' is not a redaction token — rejecting unsanitized payload."
            )
        # Bracket-wrapped but still containing an address, e.g.
        # "[person@example.com]" — shaped like a token, but the real
        # value is right there. The bracket check above would pass it.
        if "@" in value:
            raise ContextRejected(
                f"Field '{field_name}' looks like a wrapped email rather than a token — rejecting."
            )
