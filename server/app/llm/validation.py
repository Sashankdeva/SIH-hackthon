"""Deterministic validation of model output.

Model output is untrusted input. Every rule stated in the prompt is
re-checked here, because a prompt is a request, not a control: the page
text fed into it is attacker-influenced, and a 7B model is not a
security boundary. Nothing in this module consults the prompt or the
model — only the action and the SanitizedContext the client actually
sent.

Order matters: cheap structural checks first, so a malformed action is
rejected before any semantic reasoning runs on it.
"""

import re
from typing import Any, get_args

from app.llm.errors import ActionRejected
from app.models.action import ActionResponse, ActionType
from app.models.context import SanitizedContext

# Derived from the schema Literal rather than re-typed — a hand-kept copy
# silently drifts the moment the schema gains an action.
ALLOWED_ACTIONS: frozenset[str] = frozenset(get_args(ActionType))

#: Actions meaningless without a target element on the page.
ELEMENT_TARGETED_ACTIONS = frozenset({"click", "type", "type_secret"})

#: Keys the model is allowed to emit. Anything else is a signal the
#: output isn't the shape we asked for, so we stop rather than silently
#: dropping it (the previous behaviour).
#: "done" uses only "action" and "confidence" — all other fields must be null.
ALLOWED_RESPONSE_KEYS = frozenset(
    {"action", "element_id", "value", "value_ref", "direction", "amount", "url", "confidence"}
)

#: Fields that must be absent (null) when action == "done".
#: Done is a bare terminal signal — it targets no element, writes no
#: value, follows no URL. Allowing any of these would let a prompt
#: injection smuggle a payload into the done signal.
DONE_FORBIDDEN_FIELDS: frozenset[str] = frozenset({"element_id", "value", "value_ref", "url"})

#: Only these schemes may ever reach `location.href` in the extension.
SAFE_URL_SCHEMES = ("http://", "https://")

_TOKEN_RE = re.compile(r"\[[A-Z_]+_\d+\]")
_EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
#: 9+ consecutive digits — card numbers, phone numbers, government IDs.
#: Deliberately loose; a false positive costs one refused action, a false
#: negative writes a real identifier into a page.
_LONG_DIGITS_RE = re.compile(r"\d{9,}")
_CODE_MARKERS = (
    "javascript:",
    "data:",
    "vbscript:",
    "<script",
    "</script",
    "onerror=",
    "onload=",
    "eval(",
    "document.cookie",
    "window.location",
)


def _reject(reason: str) -> None:
    raise ActionRejected(reason)


def _element_by_id(context: SanitizedContext, element_id: int | None):
    return next((el for el in context.elements if el.element_id == element_id), None)


def _is_redacted(label: str | None) -> bool:
    """True when a label carries a redaction token, so the real value
    lives only in the browser. `search`, not `fullmatch`: a label like
    "Email [EMAIL_01]" is still a redacted field, and treating it as
    ordinary would let a `type` action clear it.
    """
    return bool(label) and _TOKEN_RE.search(label) is not None


def _contains_code(text: str) -> str | None:
    lowered = text.lower()
    for marker in _CODE_MARKERS:
        if marker in lowered:
            return marker
    return None


def validate_response_keys(data: dict[str, Any]) -> None:
    """Reject output carrying fields we never asked for."""
    unexpected = set(data) - ALLOWED_RESPONSE_KEYS
    if unexpected:
        _reject(f"model returned unexpected field(s): {sorted(unexpected)}")


def validate_action_type(action: Any) -> str:
    if action not in ALLOWED_ACTIONS:
        _reject(f"disallowed action type: {action!r}")
    return str(action)


def validate_target(action: str, element_id: Any, context: SanitizedContext) -> int | None:
    """The target must be an element the CLIENT supplied, not one the
    model invented, and element-targeted actions must have one.
    """
    valid_ids = {el.element_id for el in context.elements}
    if element_id is not None and element_id not in valid_ids:
        _reject(f"element_id {element_id!r} was not supplied in the context (valid: {sorted(valid_ids)})")
    if action in ELEMENT_TARGETED_ACTIONS and element_id is None:
        _reject(f"action {action!r} requires an element_id, got null")
    return element_id


def validate_value(action: str, element_id: int | None, value: Any, context: SanitizedContext) -> str | None:
    """`value` is typed literally into the page, so it is the most
    dangerous field in the action. It must be plain, non-sensitive text.

    Two rules here exist because of a measured model failure. Asked to
    "enter my email", the model answered
    `{"action":"type","element_id":<email field>,"value":null}` on 3/3
    runs. That passed validation, and the extension executes `type` as
    `el.value = req.value ?? ""` — so a request to FILL a field would
    have CLEARED it. Both halves of that are now refused.
    """
    if action == "type":
        # (1) A redacted field's real value lives only in the browser.
        # `type` would write whatever literal the model invented — or,
        # with a null value, erase the field. type_secret is the only
        # mechanism that fills these.
        target = _element_by_id(context, element_id)
        if target is not None and _is_redacted(target.label):
            _reject(
                f"'type' targets element {element_id} whose label {target.label!r} is a redaction token — "
                "use type_secret so the browser supplies the real value"
            )
        # (2) "Enter something" can never legitimately mean "write an
        # empty string". Blanking a field is destructive and is never
        # what the user asked for.
        if value is None or (isinstance(value, str) and not value.strip()):
            _reject("'type' requires a non-empty value — refusing to clear the field")

    if value is None:
        return None
    if not isinstance(value, str):
        _reject(f"value must be a string or null, got {type(value).__name__}")

    if _TOKEN_RE.search(value):
        # Would type the literal text "[EMAIL_01]" into a real form field.
        _reject("value contains a redaction token — use value_ref for private data")
    if _EMAIL_RE.search(value):
        _reject("value looks like a raw email address — the model must not introduce PII")
    if _LONG_DIGITS_RE.search(value):
        _reject("value contains a long digit sequence (card/phone/ID-like) — refusing to type it")
    marker = _contains_code(value)
    if marker is not None:
        _reject(f"value contains code-like content ({marker!r})")
    return value


def validate_secret_reference(
    action: str, element_id: int | None, value_ref: Any, context: SanitizedContext
) -> str | None:
    """`type_secret` fills a field from a value only the browser holds.

    The id and the token must name the SAME element. Checking them
    independently is not enough: a live run proposed element_id=1 (an
    *email* field) with value_ref="[PASSWORD_01]" — each half valid, the
    pair meaning "type the password into the email box", which would
    submit it in the clear.
    """
    if action != "type_secret":
        # value_ref is meaningless for every other action — the executor
        # ignores it. Its presence means the model conflated `type` with
        # `type_secret` (observed live), so treat it as a coherence
        # failure rather than silently dropping it.
        if value_ref is not None:
            _reject(f"value_ref is only valid for type_secret, not {action!r}")
        return None

    target = _element_by_id(context, element_id)
    if target is None:
        _reject(f"type_secret targets unknown element_id {element_id!r}")
    if not value_ref or not isinstance(value_ref, str):
        _reject("type_secret requires a value_ref naming the field to fill")
    if value_ref != target.label:
        _reject(
            f"type_secret value_ref {value_ref!r} does not belong to element {element_id} "
            f"(its token is {target.label!r}) — refusing to fill the wrong field"
        )
    if not _is_redacted(target.label):
        _reject(
            f"type_secret targets element {element_id} (label {target.label!r}) which is not a redacted field"
        )
    return value_ref


def validate_navigation(action: str, url: Any, context: SanitizedContext) -> str | None:
    """The extension performs navigate as `location.href = url`, so an
    unconstrained URL is both an open redirect and a script-execution
    vector (`javascript:`). Constrain scheme and origin.
    """
    if action != "navigate":
        if url is not None and not isinstance(url, str):
            _reject("url must be a string or null")
        return url

    if not isinstance(url, str) or not url:
        _reject("navigate requires a url")
    if not url.startswith(SAFE_URL_SCHEMES):
        _reject(f"navigate url must use http/https, got {url[:32]!r}")
    if not url.startswith(context.url_origin):
        _reject(f"navigate url leaves origin {context.url_origin!r}")
    return url


def validate_done(action: str, data: dict[str, Any]) -> None:
    """'done' is a bare terminal signal — no element, no value, no URL.

    Any non-null value in a forbidden field alongside a done action is a
    prompt-injection risk: an attacker-controlled page could embed
    instructions that produce a done with a payload. We reject it loudly.
    """
    if action != "done":
        return
    for field in DONE_FORBIDDEN_FIELDS:
        v = data.get(field)
        if v is not None:
            _reject(f"'done' must not carry {field!r} (got {v!r}) — done is a bare terminal signal")


def build_validated_action(data: dict[str, Any], context: SanitizedContext) -> ActionResponse:
    """Run every deterministic check, then construct the response.

    Raises ActionRejected on the first violation. Constructing the
    ActionResponse last means Pydantic's own schema validation (types,
    confidence range, extra="forbid") is the final gate.
    """
    validate_response_keys(data)
    action = validate_action_type(data.get("action"))
    validate_done(action, data)
    element_id = validate_target(action, data.get("element_id"), context)
    value = validate_value(action, element_id, data.get("value"), context)
    value_ref = validate_secret_reference(action, element_id, data.get("value_ref"), context)
    url = validate_navigation(action, data.get("url"), context)

    raw_confidence = data.get("confidence", 0.5)
    try:
        confidence = float(raw_confidence)
    except (TypeError, ValueError):
        _reject(f"confidence is not a number: {raw_confidence!r}")

    try:
        return ActionResponse(
            action=action,  # type: ignore[arg-type]
            element_id=element_id,
            value=value,
            value_ref=value_ref,
            direction=data.get("direction"),
            amount=data.get("amount"),
            url=url,
            confidence=confidence,
            task_id=context.task_id,
            step_id=len(context.history) + 1,
        )

    except ValueError as exc:  # pydantic ValidationError subclasses ValueError
        _reject(f"action failed schema validation: {exc}")
    raise AssertionError("unreachable")  # pragma: no cover
