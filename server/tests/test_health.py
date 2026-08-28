from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_reason_rejects_unredacted_field() -> None:
    payload = {
        "task_id": "t1",
        "task": "log in",
        "page": "login",
        "url_origin": "http://localhost:8000",
        "elements": [],
        "fields": {"email": "person@example.com"},
    }
    response = client.post("/reason", json=payload)
    assert response.status_code == 422


def test_reason_accepts_sanitized_payload() -> None:
    payload = {
        "task_id": "t1",
        "task": "submit the form",
        "page": "login",
        "url_origin": "http://localhost:8000",
        "elements": [{"element_id": 1, "role": "button", "label": "Submit"}],
        "fields": {"email": "[EMAIL_01]"},
    }
    response = client.post("/reason", json=payload)
    assert response.status_code == 200
    assert response.json()["action"] == "wait"


def test_reason_requires_a_task() -> None:
    """The agent must never reason about a page with no stated goal —
    that was the pre-task behaviour, where it acted on whatever looked
    clickable. A payload without a task is now a schema violation.
    """
    payload = {
        "task_id": "t1",
        "page": "login",
        "url_origin": "http://localhost:8000",
        "elements": [{"element_id": 1, "role": "button", "label": "Submit"}],
        "fields": {},
    }
    response = client.post("/reason", json=payload)
    assert response.status_code == 422


def test_reason_rejects_empty_task() -> None:
    payload = {
        "task_id": "t1",
        "task": "   ",
        "page": "login",
        "url_origin": "http://localhost:8000",
        "elements": [{"element_id": 1, "role": "button", "label": "Submit"}],
        "fields": {},
    }
    response = client.post("/reason", json=payload)
    assert response.status_code == 422
