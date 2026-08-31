"""SERVER PHASE S4 — one-off structured-output audit matrix.

Not part of the permanent suite. Exercises _parse_json and
build_validated_action DIRECTLY with hand-crafted inputs (no live model
needed) to characterize current fail-closed behavior across the
malformed-output matrix and the action-field matrix. Genuine gaps found
here get proper pytest coverage added to tests/ separately; this script
is throwaway scaffolding for the audit itself.
"""

import json

from app.llm.client import OllamaReasoningClient
from app.llm.errors import ActionRejected, ModelOutputInvalid
from app.llm.validation import build_validated_action
from app.models.context import SanitizedContext

ORIGIN = "http://localhost:8000"

CTX = SanitizedContext(
    task_id="audit", task="do the thing", page="p", url_origin=ORIGIN,
    elements=[
        {"element_id": 1, "role": "textbox", "label": "Search"},
        {"element_id": 2, "role": "button", "label": "Go"},
        {"element_id": 3, "role": "link", "label": "Help"},
        {"element_id": 4, "role": "checkbox", "label": "Remember me"},
        {"element_id": 5, "role": "textbox", "label": "[PASSWORD_01]", "disabled": True},
    ],
    fields={"5": "[PASSWORD_01]"},
)


def try_parse(label, raw):
    try:
        data = OllamaReasoningClient._parse_json(raw)
        print(f"[PARSE OK]     {label}: {data}")
        return data
    except ModelOutputInvalid as exc:
        print(f"[PARSE REJECT] {label}: {exc.reason}")
        return None


def try_validate(label, data):
    if data is None:
        return
    try:
        action = build_validated_action(data, CTX)
        print(f"[VALID OK]     {label}: action={action.action} target={action.element_id} "
              f"task_id={action.task_id} step_id={action.step_id}")
    except ActionRejected as exc:
        print(f"[VALID REJECT] {label}: {exc.reason}")


print("=" * 70)
print("SECTION 2 — MALFORMED OUTPUT MATRIX (via _parse_json)")
print("=" * 70)

cases = [
    ("1. invalid JSON", '{"action": "click",'),
    ("2. JSON array", '[{"action": "click", "element_id": 2}]'),
    ("3. JSON scalar (number)", '0.9'),
    ("3b. JSON scalar (string)", '"click"'),
    ("3c. JSON scalar (bool)", 'true'),
    ("4. empty response", ''),
    ("5. whitespace response", '   \n\t  '),
    ("6. truncated JSON", '{"action": "click", "element_id": 2, "conf'),
    ("7. prose + JSON", 'Sure, here is the action: {"action": "click", "element_id": 2, "confidence": 0.9}'),
    ("8. markdown fenced JSON", '```json\n{"action": "click", "element_id": 2, "confidence": 0.9}\n```'),
    ("9. duplicate keys", '{"action": "click", "element_id": 2, "element_id": 999, "confidence": 0.9}'),
    ("10. null", 'null'),
    ("11a. wrong type: element_id as string", '{"action": "click", "element_id": "2", "confidence": 0.9}'),
    ("11b. wrong type: confidence as string", '{"action": "click", "element_id": 2, "confidence": "high"}'),
    ("12. missing required field (no action)", '{"element_id": 2, "confidence": 0.9}'),
    ("13. extra field", '{"action": "click", "element_id": 2, "confidence": 0.9, "reasoning": "because"}'),
    ("NaN literal (JSON extension)", '{"action": "click", "element_id": 2, "confidence": NaN}'),
    ("Infinity literal", '{"action": "wait", "amount": Infinity, "confidence": 0.9}'),
]

for label, raw in cases:
    data = try_parse(label, raw)
    if data is not None and isinstance(data, dict):
        try_validate(label, data)

print()
print("=" * 70)
print("SECTION 3/4/5/6 — ACTION FIELD MATRIX, TASK/STEP, TARGET, CONFIDENCE")
print("=" * 70)

field_cases = [
    ("click: valid", {"action": "click", "element_id": 2, "confidence": 0.9}),
    ("click: missing element_id", {"action": "click", "confidence": 0.9}),
    ("click: value stray", {"action": "click", "element_id": 2, "value": "x", "confidence": 0.9}),
    ("click: value_ref stray", {"action": "click", "element_id": 2, "value_ref": "[X]", "confidence": 0.9}),
    ("click: disabled target", {"action": "click", "element_id": 5, "confidence": 0.9}),
    ("click: nonexistent element_id", {"action": "click", "element_id": 999, "confidence": 0.9}),
    ("click: element_id=0", {"action": "click", "element_id": 0, "confidence": 0.9}),
    ("click: negative element_id", {"action": "click", "element_id": -1, "confidence": 0.9}),
    ("type: valid on textbox", {"action": "type", "element_id": 1, "value": "hello", "confidence": 0.9}),
    ("type: on button role", {"action": "type", "element_id": 2, "value": "hello", "confidence": 0.9}),
    ("type: on link role", {"action": "type", "element_id": 3, "value": "hello", "confidence": 0.9}),
    ("type: on checkbox role", {"action": "type", "element_id": 4, "value": "hello", "confidence": 0.9}),
    ("type: null value", {"action": "type", "element_id": 1, "value": None, "confidence": 0.9}),
    ("type: empty value", {"action": "type", "element_id": 1, "value": "", "confidence": 0.9}),
    ("type: on redacted field", {"action": "type", "element_id": 5, "value": "hunter2", "confidence": 0.9}),
    ("type_secret: valid", {"action": "type_secret", "element_id": 5, "value_ref": "[PASSWORD_01]", "confidence": 0.9}),
    ("type_secret: on button role", {"action": "type_secret", "element_id": 2, "value_ref": "[X]", "confidence": 0.9}),
    ("type_secret: with stray value", {"action": "type_secret", "element_id": 5, "value": "x", "value_ref": "[PASSWORD_01]", "confidence": 0.9}),
    ("scroll: valid", {"action": "scroll", "direction": "down", "amount": 200, "confidence": 0.9}),
    ("scroll: with stray element_id", {"action": "scroll", "element_id": 2, "direction": "down", "confidence": 0.9}),
    ("scroll: invalid direction", {"action": "scroll", "direction": "sideways", "confidence": 0.9}),
    ("scroll: with url", {"action": "scroll", "direction": "down", "url": "http://localhost:8000/x", "confidence": 0.9}),
    ("navigate: valid same-origin", {"action": "navigate", "url": "http://localhost:8000/next", "confidence": 0.9}),
    ("navigate: with stray element_id", {"action": "navigate", "element_id": 2, "url": "http://localhost:8000/next", "confidence": 0.9}),
    ("navigate: missing url", {"action": "navigate", "confidence": 0.9}),
    ("navigate: off-origin", {"action": "navigate", "url": "http://evil.example.com", "confidence": 0.9}),
    ("navigate: javascript url", {"action": "navigate", "url": "javascript:alert(1)", "confidence": 0.9}),
    ("wait: valid", {"action": "wait", "amount": 500, "confidence": 0.9}),
    ("wait: with stray element_id", {"action": "wait", "element_id": 2, "amount": 500, "confidence": 0.9}),
    ("wait: negative amount", {"action": "wait", "amount": -500, "confidence": 0.9}),
    ("wait: with direction", {"action": "wait", "direction": "down", "amount": 500, "confidence": 0.9}),
    ("keypress: valid", {"action": "keypress", "element_id": 1, "value": "Enter", "confidence": 0.9}),
    ("keypress: no value (default Enter)", {"action": "keypress", "element_id": 1, "confidence": 0.9}),
    ("keypress: no element_id", {"action": "keypress", "value": "Enter", "confidence": 0.9}),
    ("done: valid", {"action": "done", "confidence": 0.9}),
    ("done: with element_id (forbidden)", {"action": "done", "element_id": 2, "confidence": 0.9}),
    ("done: with value (forbidden)", {"action": "done", "value": "x", "confidence": 0.9}),
    ("done: with url (forbidden)", {"action": "done", "url": "http://localhost:8000/x", "confidence": 0.9}),
    # TASK/STEP INTEGRITY
    ("model supplies task_id", {"action": "click", "element_id": 2, "task_id": "attacker-task", "confidence": 0.9}),
    ("model supplies step_id", {"action": "click", "element_id": 2, "step_id": 999, "confidence": 0.9}),
    # CONFIDENCE
    ("confidence: missing", {"action": "click", "element_id": 2}),
    ("confidence: null", {"action": "click", "element_id": 2, "confidence": None}),
    ("confidence: negative", {"action": "click", "element_id": 2, "confidence": -0.1}),
    ("confidence: >1", {"action": "click", "element_id": 2, "confidence": 1.1}),
    ("confidence: string", {"action": "click", "element_id": 2, "confidence": "high"}),
    ("confidence: integer 1", {"action": "click", "element_id": 2, "confidence": 1}),
    ("confidence: integer 0", {"action": "click", "element_id": 2, "confidence": 0}),
    ("confidence: boundary 0.0", {"action": "click", "element_id": 2, "confidence": 0.0}),
    ("confidence: boundary 1.0", {"action": "click", "element_id": 2, "confidence": 1.0}),
    ("confidence: NaN (python float)", {"action": "click", "element_id": 2, "confidence": float("nan")}),
    ("confidence: bool True", {"action": "click", "element_id": 2, "confidence": True}),
]

for label, data in field_cases:
    try_validate(label, data)
