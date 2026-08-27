from fastapi import HTTPException

from app.models.context import SanitizedContext

# A bare '@' in a field value strongly suggests an un-redacted email slipped through.
FORBIDDEN_FIELD_SUBSTRINGS = ("@",)


def assert_context_is_sanitized(context: SanitizedContext) -> None:
    """Server-side half of the privacy firewall. Pydantic's
    `extra="forbid"` on SanitizedContext already rejects unexpected raw
    fields at parse time; this catches redaction that ran but produced a
    value that still looks raw. See PS26171_Role4_Server.pdf, Day 3, and
    PS26171_Role3_Privacy.pdf's canary-value test.
    """
    for field_name, value in context.fields.items():
        if not (value.startswith("[") and value.endswith("]")):
            raise HTTPException(
                status_code=422,
                detail=f"Field '{field_name}' is not a redaction token ('{value}') — rejecting unsanitized payload.",
            )
        for pattern in FORBIDDEN_FIELD_SUBSTRINGS:
            if pattern in value:
                raise HTTPException(
                    status_code=422,
                    detail=f"Field '{field_name}' contains '{pattern}' — looks unredacted, rejecting.",
                )
