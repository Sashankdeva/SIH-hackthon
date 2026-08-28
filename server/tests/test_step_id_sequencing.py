"""Tests for step_id sequencing calculation in validation layer.

Proves that:
  - empty history produces step_id = 1
  - 1 history record produces step_id = 2
  - 3 history records produce step_id = 4
  - task_id flows unchanged
  - action validation rules operate identically
"""

import pytest

from app.llm.validation import build_validated_action
from app.models.context import SanitizedContext, StepRecord


def _make_context(history_count: int = 0, task_id: str = "task-seq-1") -> SanitizedContext:
    history = [
        StepRecord(
            step=i + 1,
            action="click",
            element_id=1,
            element_label="Btn",
            outcome="success",
        )
        for i in range(history_count)
    ]
    return SanitizedContext(
        task_id=task_id,
        task="do sequence",
        page="Page",
        url_origin="http://localhost:8000",
        elements=[{"element_id": 1, "role": "button", "label": "Btn"}],
        fields={},
        history=history,
    )


def test_empty_history_produces_step_id_1() -> None:
    ctx = _make_context(history_count=0)
    action = build_validated_action({"action": "click", "element_id": 1, "confidence": 0.9}, ctx)
    assert action.step_id == 1
    assert action.task_id == "task-seq-1"


def test_one_history_record_produces_step_id_2() -> None:
    ctx = _make_context(history_count=1)
    action = build_validated_action({"action": "click", "element_id": 1, "confidence": 0.9}, ctx)
    assert action.step_id == 2
    assert action.task_id == "task-seq-1"


def test_three_history_records_produce_step_id_4() -> None:
    ctx = _make_context(history_count=3)
    action = build_validated_action({"action": "click", "element_id": 1, "confidence": 0.9}, ctx)
    assert action.step_id == 4
    assert action.task_id == "task-seq-1"


def test_task_id_remains_unchanged_across_steps() -> None:
    ctx = _make_context(history_count=2, task_id="custom-uuid-999")
    action = build_validated_action({"action": "click", "element_id": 1, "confidence": 0.9}, ctx)
    assert action.task_id == "custom-uuid-999"
    assert action.step_id == 3


def test_action_validation_rules_unaffected_by_history_count() -> None:
    ctx = _make_context(history_count=5)
    action = build_validated_action({"action": "wait", "amount": 200, "confidence": 0.95}, ctx)
    assert action.action == "wait"
    assert action.step_id == 6
