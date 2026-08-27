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
        "page": "login",
        "url_origin": "http://localhost:8000",
        "elements": [{"element_id": 1, "role": "button", "label": "Submit"}],
        "fields": {"email": "[EMAIL_01]"},
    }
    response = client.post("/reason", json=payload)
    assert response.status_code == 200
    assert response.json()["action"] == "wait"


def test_reason_rejects_unadapted_camelcase_payload() -> None:
    """Verifies that un-adapted client camelCase payloads are rejected by strict validation."""
    raw_client_payload = {
        "taskId": "t1",
        "page": "login",
        "urlOrigin": "http://localhost:8000",
        "elements": [{"elementId": 1, "role": "button", "label": "Submit"}],
        "fields": {},
    }
    response = client.post("/reason", json=raw_client_payload)
    assert response.status_code == 422


def test_reason_accepts_mock_site_wire_payload() -> None:
    """Verifies that full mock-site checkout wire payload passes server validation."""
    wire_payload = {
        "task_id": "task-mock-checkout-001",
        "page": "Mock Checkout",
        "url_origin": "http://localhost:3000",
        "elements": [
            {"element_id": 1, "role": "link", "label": "Go to privacy canary test page →"},
            {"element_id": 8, "role": "combobox", "label": "Product"},
            {"element_id": 9, "role": "button", "label": "Place Order"},
        ],
        "fields": {
            "2": "[NAME_01]",
            "3": "[EMAIL_01]",
            "4": "[PHONE_01]",
            "5": "[PASSWORD_01]",
            "6": "[ADDRESS_01]",
            "7": "[FINANCIAL_01]",
        },
    }
    response = client.post("/reason", json=wire_payload)
    assert response.status_code == 200
    data = response.json()
    assert data["action"] == "wait"
    assert data["task_id"] == "task-mock-checkout-001"
