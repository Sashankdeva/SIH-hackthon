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

import math
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

#: Actions for which a literal `value` has no meaning at execution time
#: and is therefore rejected outright rather than silently ignored — see
#: validate_value's own comment for why "keypress" is deliberately NOT
#: in this set (it genuinely uses `value` for the key to press) and
#: "type_secret"/"done" are handled by their own dedicated checks
#: instead of this generic set.
#:
#: SERVER PHASE S3.1 note: a role-scoped version of this rejection was
#: tried — "click" + value only on text-entry-capable roles
#: (textbox/searchbox/combobox/spinbutton), motivated by the S3 finding
#: that Qwen sometimes emits click+value on a search box instead of
#: "type". Measured to be provably unreachable: this line already
#: rejects "click" + any non-null value for EVERY role, so a role-scoped
#: version can only ever be a strict subset of what's already refused
#: here. Confirmed empirically too — a full-suite S3 benchmark re-run
#: with the role-scoped check wired in ahead of this one produced
#: byte-identical results (141/141 records; the only 2 diffs traced to
#: unrelated, already-documented model nondeterminism on an unrelated
#: case). Not added. If element role is ever used for a NEW purpose,
#: remember it's client-reported structural metadata (same trust tier
#: as CapturedElement.disabled) — real, ARIA-style values only
#: ("textbox", "combobox", "button", "link", "checkbox", "radio", or an
#: explicit page-set role); this benchmark suite's older fixtures use a
#: non-existent "input:text"/"input:email"/etc. convention that the real
#: client (extension/src/perception/domCapture.ts's roleFor()) never
#: actually produces — don't validate against that vocabulary.
VALUE_IRRELEVANT_ACTIONS = frozenset({"click", "scroll", "navigate", "wait"})

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

#: SERVER PHASE S4 — roles that can NEVER be a legitimate "type"/
#: "type_secret" target, regardless of what the model claims. Derived
#: from extension/src/perception/domCapture.ts's roleFor() (the ONLY
#: source of the `role` field: "button" for <button> and
#: input[type=button/submit/reset], "link" for <a>, "checkbox"/"radio"
#: for those input types) cross-checked against
#: extension/src/action/executor.ts's injectTextIntoElement, which is
#: the ONLY function "type"/"type_secret" ever call.
#:
#: This is deliberately a narrow denylist, not an allowlist of
#: "textbox"/"searchbox"/"combobox"/"spinbutton": those roles can
#: legitimately be page-author-set ARIA values on elements whose real
#: DOM fillability the label alone can't rule out, and a false
#: rejection there is a worse failure mode than the gap this closes. The
#: four roles below can never be genuinely fillable by ANY reasonable
#: interpretation, so rejecting them carries no such risk:
#:   - "button" (<button>): injectTextIntoElement no-ops (not an
#:     HTMLInputElement/HTMLTextAreaElement, not contenteditable) — a
#:     silently wasted step, not unsafe.
#:   - "button" (<input type="submit/button/reset">): injectTextIntoElement
#:     DOES match (it IS an HTMLInputElement) and sets `.value` — for a
#:     submit/button input, `.value` IS its visible label text, so this
#:     silently REWRITES the button's displayed text. Not a security
#:     hole, but a genuine unintended, observable side effect — the
#:     concrete finding that justifies this check.
#:   - "link" (<a>): no-ops, same as <button>.
#:   - "checkbox"/"radio": IS an HTMLInputElement, so `.value` is set,
#:     but checkbox/radio controls render from `.checked`, not `.value`
#:     — an invisible, inert mutation in virtually every real page.
NEVER_FILLABLE_ROLES = frozenset({"button", "link", "checkbox", "radio"})

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
        if target is not None and target.role in NEVER_FILLABLE_ROLES:
            _reject(
                f"'type' targets element {element_id} whose role is {target.role!r} — "
                "that control can never be a text-entry target"
            )
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

    if action == "type_secret" and value is not None:
        # type_secret's real value comes from value_ref, resolved
        # locally in the browser — the executor never reads `value` for
        # this action. A model that sets both is either confused about
        # which field carries the secret, or attempting to smuggle a
        # literal alongside a legitimate-looking value_ref. Reject
        # rather than silently ignore.
        _reject("'type_secret' must not carry a literal value — only value_ref")

    if action in VALUE_IRRELEVANT_ACTIONS and value is not None:
        # `value` is inert at execution time for every one of these — the
        # executor never reads it (click/scroll/navigate/wait each use
        # their own fields, or none). Accepting a stray value here let a
        # confused model response look more "valid" than it actually
        # was: observed live, the model emitted
        # {"action":"click","element_id":<search box>,"value":"Samsung S24 FE"}
        # meaning to type a search query, but "click" ignored the value
        # entirely and the search never happened — validation.py raised
        # nothing, so nothing signalled the mismatch. `type` is the only
        # action `value` has real meaning for; `type_secret`/`done` are
        # already rejected above/in validate_done. `keypress` is
        # deliberately EXCLUDED from this set: the extension's executor
        # reads the key to press from `value` itself
        # (`req.value ?? "Enter"` in action/executor.ts) — rejecting it
        # here would make it impossible to ever request a key other than
        # the hardcoded "Enter" default, an existing capability, not a
        # gap.
        _reject(f"value is only valid for 'type', not {action!r}")

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
    if target.role in NEVER_FILLABLE_ROLES:
        _reject(
            f"type_secret targets element {element_id} whose role is {target.role!r} — "
            "that control can never be a text-entry target"
        )
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
        if url is not None:
            _reject(f"url is only valid for 'navigate', not {action!r}")
        return url

    if not isinstance(url, str) or not url:
        _reject("navigate requires a url")
    if not url.startswith(SAFE_URL_SCHEMES):
        _reject(f"navigate url must use http/https, got {url[:32]!r}")
    if not url.startswith(context.url_origin):
        _reject(f"navigate url leaves origin {context.url_origin!r}")
    return url


def validate_scroll_and_wait_fields(action: str, direction: Any, amount: Any) -> tuple[Any, Any]:
    """`direction` only means anything for 'scroll'; `amount` only means
    anything for 'scroll' (pixels) or 'wait' (milliseconds). Neither is
    unsafe if the model sets it elsewhere — the executor ignores fields
    outside its own action's case — but a stray value here signals the
    model is confused about which action it's actually proposing, and
    "required fields match the action type" cuts both ways: presence
    where required, absence where irrelevant.

    SERVER PHASE S4: `amount` has no Pydantic bound on ActionResponse (no
    Field(ge=...)), so without this check a negative, NaN, or infinite
    amount reaches the client unrejected. The extension happens to clamp
    `wait` (`Math.min(amount ?? 1000, 5000)`) and the browser happens to
    clamp `scroll` internally, but that is the CLIENT'S safety net, not
    ours — this project's standing rule is that every prompt-controlled
    field is independently re-verified server-side, not left to whatever
    the client currently happens to do with it.
    """
    if direction is not None and action != "scroll":
        _reject(f"direction is only valid for 'scroll', not {action!r}")
    if amount is not None and action not in ("scroll", "wait"):
        _reject(f"amount is only valid for 'scroll' or 'wait', not {action!r}")
    if amount is not None:
        if not isinstance(amount, (int, float)) or isinstance(amount, bool):
            _reject(f"amount must be a number, got {type(amount).__name__}")
        if not math.isfinite(amount):
            _reject(f"amount must be a finite number, got {amount!r}")
        if amount < 0:
            _reject(f"amount must not be negative, got {amount!r}")
    return direction, amount


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
    direction, amount = validate_scroll_and_wait_fields(action, data.get("direction"), data.get("amount"))

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
            direction=direction,
            amount=amount,
            url=url,
            confidence=confidence,
            task_id=context.task_id,
            step_id=len(context.history) + 1,
        )

    except ValueError as exc:  # pydantic ValidationError subclasses ValueError
        _reject(f"action failed schema validation: {exc}")
    raise AssertionError("unreachable")  # pragma: no cover
