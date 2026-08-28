from fastapi import HTTPException

from app.models.context import SanitizedContext


def assert_context_is_sanitized(context: SanitizedContext) -> None:
    """Server-side half of the privacy firewall. Pydantic's
    `extra="forbid"` on SanitizedContext already rejects unexpected raw
    fields at parse time; this catches redaction that ran but produced a
    value that still looks raw.
    """
    for field_name, value in context.fields.items():
        if not (value.startswith("[") and value.endswith("]")):
            raise HTTPException(
                status_code=422,
                detail=f"Field '{field_name}' is not a redaction token ('{value}') — rejecting unsanitized payload.",
            )
        # Bracket-wrapped but still containing an address, e.g.
        # "[person@example.com]" — shaped like a token, but the real
        # value is right there. The bracket check above would pass it.
        if "@" in value:
            raise HTTPException(
                status_code=422,
                detail=f"Field '{field_name}' looks like a wrapped email rather than a token — rejecting.",
            )
