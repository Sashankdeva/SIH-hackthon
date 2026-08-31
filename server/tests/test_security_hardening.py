"""HOSTED SERVER SECURITY AND PRODUCTION HARDENING.

Covers: optional API-key auth (app/auth.py), configurable audit logging
(app/middleware.py's RequestInspectorMiddleware), request-size protection
on both sanitized-context endpoints, CORS as a deployment-aware but
non-authentication control, error responses that never leak internals,
and statelessness under concurrent multi-client load.

Every test builds its OWN app via app.main.create_app(settings) — see
that function's docstring for why: different tests need different
API_KEY/ALLOWED_ORIGINS/LOG_FULL_REQUEST_BODY values, and the module-level
`app` singleton (built once at import time) can't be reconfigured after
construction.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import API_KEY_HEADER
from app.config import load_settings
from app.llm.client import OllamaReasoningClient
from app.main import create_app
from app.routes import reason as reason_route
from tests.conftest import action_json, ollama_transport

BASE_SETTINGS = load_settings()


def settings_with(**overrides):
    return dataclasses.replace(BASE_SETTINGS, **overrides)


def reason_payload(**overrides) -> dict:
    body = {
        "task_id": "task-1",
        "task": "place the order",
        "page": "Mock Checkout",
        "url_origin": "http://localhost:8000",
        "elements": [{"element_id": 1, "role": "button", "label": "Place Order"}],
        "fields": {},
    }
    body.update(overrides)
    return body


@pytest.fixture
def ollama_backend_for(monkeypatch):
    """Swaps the module-level reasoning client for one on a mock
    transport, mirroring test_reason_endpoint.py's own fixture — reused
    here rather than duplicated, since every app built by create_app
    shares the SAME reason_route._client singleton.
    """

    def use():
        monkeypatch.setattr(
            reason_route,
            "_client",
            OllamaReasoningClient(
                model="test-model",
                base_url="http://localhost:11434",
                timeout_s=5.0,
                # element_id=1 matches reason_payload()'s single element
                # below (id 1) — action_json()'s own default (6) doesn't
                # exist in that context and gets ActionRejected instead
                # of the 200 these tests are actually testing for.
                transport=ollama_transport(response_text=action_json(element_id=1)),
            ),
        )

    return use


# ===========================================================================
# 1. Authentication
# ===========================================================================


class TestAuthentication:
    def test_disabled_by_default_requires_no_header(self):
        app = create_app(settings_with(api_key=""))
        client = TestClient(app)
        r = client.post("/reason", json=reason_payload())
        assert r.status_code == 200  # stub backend; no header sent at all

    def test_enabled_with_valid_key_succeeds(self, ollama_backend_for):
        ollama_backend_for()
        app = create_app(settings_with(api_key="s3cr3t-key"))
        client = TestClient(app)
        r = client.post("/reason", json=reason_payload(), headers={API_KEY_HEADER: "s3cr3t-key"})
        assert r.status_code == 200
        assert r.json()["action"] == "click"

    def test_enabled_missing_key_rejected(self):
        app = create_app(settings_with(api_key="s3cr3t-key"))
        client = TestClient(app)
        r = client.post("/reason", json=reason_payload())
        assert r.status_code == 401
        assert r.json() == {
            "error": "unauthorized",
            "detail": f"missing or invalid {API_KEY_HEADER} header",
            "task_id": None,
        }

    def test_enabled_invalid_key_rejected(self):
        app = create_app(settings_with(api_key="s3cr3t-key"))
        client = TestClient(app)
        r = client.post("/reason", json=reason_payload(), headers={API_KEY_HEADER: "wrong-key"})
        assert r.status_code == 401
        assert r.json()["error"] == "unauthorized"

    def test_missing_and_invalid_key_get_the_SAME_response(self):
        """Distinguishing the two would tell a caller which failure mode
        they hit — information they have no legitimate need for.
        """
        app = create_app(settings_with(api_key="s3cr3t-key"))
        client = TestClient(app)
        missing = client.post("/reason", json=reason_payload())
        invalid = client.post("/reason", json=reason_payload(), headers={API_KEY_HEADER: "nope"})
        assert missing.status_code == invalid.status_code == 401
        assert missing.json() == invalid.json()

    def test_complete_endpoint_is_also_gated(self):
        app = create_app(settings_with(api_key="s3cr3t-key"))
        client = TestClient(app)
        r = client.post("/complete", json=reason_payload())
        assert r.status_code == 401

    def test_health_stays_unauthenticated_even_when_auth_is_enabled(self):
        app = create_app(settings_with(api_key="s3cr3t-key"))
        client = TestClient(app)
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}

    def test_non_loopback_host_without_api_key_logs_a_security_warning(self, caplog):
        """SERVER PHASE S7 — the one exposure combination that actually
        matters: HOST opened beyond loopback (LAN/Radmin) while API_KEY
        is unset. This must not pass silently."""
        with caplog.at_level("WARNING"):
            create_app(settings_with(host="26.39.161.6", api_key=""))
        assert "SECURITY" in caplog.text
        assert "API_KEY is unset" in caplog.text
        assert "26.39.161.6" in caplog.text  # the interface, not a secret

    def test_non_loopback_host_with_api_key_set_does_not_warn(self, caplog):
        with caplog.at_level("WARNING"):
            create_app(settings_with(host="26.39.161.6", api_key="s3cr3t-key"))
        assert "SECURITY" not in caplog.text

    def test_loopback_host_without_api_key_does_not_warn(self, caplog):
        with caplog.at_level("WARNING"):
            create_app(settings_with(host="127.0.0.1", api_key=""))
        assert "SECURITY" not in caplog.text

    def test_key_never_appears_in_the_error_response_body(self):
        app = create_app(settings_with(api_key="s3cr3t-canary-value"))
        client = TestClient(app)
        r = client.post("/reason", json=reason_payload(), headers={API_KEY_HEADER: "wrong-guess"})
        assert "s3cr3t-canary-value" not in r.text
        assert "wrong-guess" not in r.text

    def test_key_never_appears_in_logs_success_or_failure(self, caplog, ollama_backend_for):
        ollama_backend_for()
        secret_key = "s3cr3t-canary-in-logs-9f21"
        app = create_app(settings_with(api_key=secret_key))
        client = TestClient(app)

        with caplog.at_level("DEBUG"):
            client.post("/reason", json=reason_payload(), headers={API_KEY_HEADER: secret_key})  # valid
            client.post("/reason", json=reason_payload(), headers={API_KEY_HEADER: "guess-1"})  # invalid
            client.post("/reason", json=reason_payload())  # missing

        assert secret_key not in caplog.text
        assert "guess-1" not in caplog.text

    def test_uses_constant_time_comparison_not_string_equality(self):
        """Reads app/auth.py's own source rather than trying to measure
        a timing side-channel in a unit test (which would be flaky by
        nature) — the actual guarantee is that the code PATH is
        constant-time, not that a particular measurement proves it.
        """
        import inspect

        from app import auth

        source = inspect.getsource(auth.ApiKeyAuthMiddleware.dispatch)
        assert "secrets.compare_digest" in source
        assert "provided == self._api_key" not in source
        assert "provided != self._api_key" not in source


# ===========================================================================
# 9 (partial). Authentication performance
# ===========================================================================


class TestAuthPerformance:
    def test_valid_key_comparison_overhead_is_negligible(self):
        import secrets

        key = "a" * 64
        candidate = "a" * 64
        n = 10_000
        t0 = time.perf_counter()
        for _ in range(n):
            secrets.compare_digest(candidate, key)
        elapsed_ms = (time.perf_counter() - t0) * 1000
        per_call_us = (elapsed_ms * 1000) / n
        print(f"\n[auth perf] {n} compare_digest calls: {elapsed_ms:.2f}ms total, {per_call_us:.3f}us/call")
        # Generous bound — the real claim is "microseconds", not this
        # specific number; this just catches something pathological.
        assert per_call_us < 50

    def test_end_to_end_overhead_of_auth_enabled_vs_disabled_is_small(self, ollama_backend_for):
        ollama_backend_for()
        n = 20

        def timed_requests(app, headers: dict) -> float:
            client = TestClient(app)
            t0 = time.perf_counter()
            for _ in range(n):
                client.post("/reason", json=reason_payload(), headers=headers)
            return (time.perf_counter() - t0) * 1000 / n

        app_no_auth = create_app(settings_with(api_key=""))
        app_with_auth = create_app(settings_with(api_key="bench-key"))

        no_auth_ms = timed_requests(app_no_auth, {})
        with_auth_ms = timed_requests(app_with_auth, {API_KEY_HEADER: "bench-key"})
        print(f"\n[auth perf] mean per-request: no-auth={no_auth_ms:.3f}ms auth={with_auth_ms:.3f}ms")
        # The whole claim under test: auth overhead is dwarfed by ANY
        # real reasoning call (hundreds to thousands of ms against real
        # Ollama). A few ms of TestClient/stub overhead either way is
        # not what's being measured — the bound here is generous on
        # purpose.
        assert with_auth_ms < no_auth_ms + 20


# ===========================================================================
# 2 & 3. Audit logging / privacy logging audit
# ===========================================================================


class TestAuditLogging:
    def _read_last_log_line(self, log_path: Path) -> dict:
        lines = log_path.read_text(encoding="utf-8").strip().splitlines()
        return json.loads(lines[-1])

    def test_full_body_logging_disabled_by_default_omits_parsed_body(self, monkeypatch, tmp_path, ollama_backend_for):
        ollama_backend_for()
        log_path = tmp_path / "reason_requests.jsonl"
        monkeypatch.setattr("app.middleware.LOG_PATH", log_path)

        app = create_app(settings_with(log_full_request_body=False))
        client = TestClient(app)
        client.post("/reason", json=reason_payload())

        record = self._read_last_log_line(log_path)
        assert "parsed_body" not in record
        assert record["path"] == "/reason"
        assert "sha256" in record
        assert "body_size" in record
        assert "status_code" in record
        assert "elapsed_ms" in record

    def test_full_body_logging_when_explicitly_enabled_includes_the_body(self, monkeypatch, tmp_path, ollama_backend_for):
        ollama_backend_for()
        log_path = tmp_path / "reason_requests.jsonl"
        monkeypatch.setattr("app.middleware.LOG_PATH", log_path)

        app = create_app(settings_with(log_full_request_body=True))
        client = TestClient(app)
        client.post("/reason", json=reason_payload(task_id="canary-task-id"))

        record = self._read_last_log_line(log_path)
        assert record["parsed_body"]["task_id"] == "canary-task-id"

    def test_status_and_timing_are_always_recorded_regardless_of_full_body_flag(
        self, monkeypatch, tmp_path, ollama_backend_for
    ):
        ollama_backend_for()
        log_path = tmp_path / "reason_requests.jsonl"
        monkeypatch.setattr("app.middleware.LOG_PATH", log_path)

        app = create_app(settings_with(log_full_request_body=False))
        client = TestClient(app)
        client.post("/reason", json=reason_payload())

        record = self._read_last_log_line(log_path)
        assert record["status_code"] == 200
        assert isinstance(record["elapsed_ms"], (int, float))

    def test_no_secret_in_logs_when_full_body_logging_is_disabled(self, monkeypatch, tmp_path):
        """A raw-secret-shaped field gets rejected (see the privacy
        verification tests below) — this proves the REJECTED request's
        body never reaches the log either, when logging is off.
        """
        log_path = tmp_path / "reason_requests.jsonl"
        monkeypatch.setattr("app.middleware.LOG_PATH", log_path)

        app = create_app(settings_with(log_full_request_body=False))
        client = TestClient(app)
        raw_secret = "CANARY_RAW_PASSWORD_9f2a"
        client.post(
            "/reason",
            json=reason_payload(fields={"1": raw_secret}, elements=[{"element_id": 1, "role": "input:password", "label": "[PASSWORD_01]"}]),
        )

        assert raw_secret not in log_path.read_text(encoding="utf-8")

    def test_documented_tradeoff_full_body_logging_enabled_DOES_capture_a_rejected_secret(self, monkeypatch, tmp_path):
        """The other half of the same proof: enabling LOG_FULL_REQUEST_BODY
        is explicitly documented (.env.example, middleware.py) as
        synthetic-data-only for exactly this reason — verifying the
        tradeoff is real, not just asserting it in a comment.
        """
        log_path = tmp_path / "reason_requests.jsonl"
        monkeypatch.setattr("app.middleware.LOG_PATH", log_path)

        app = create_app(settings_with(log_full_request_body=True))
        client = TestClient(app)
        raw_secret = "CANARY_RAW_PASSWORD_9f2a"
        client.post(
            "/reason",
            json=reason_payload(fields={"1": raw_secret}, elements=[{"element_id": 1, "role": "input:password", "label": "[PASSWORD_01]"}]),
        )

        assert raw_secret in log_path.read_text(encoding="utf-8")


# ===========================================================================
# 4. Request-size protection — both endpoints, boundary values
# ===========================================================================


class TestRequestSizeProtection:
    def _padded_body(self, target_bytes: int) -> bytes:
        base = reason_payload()
        overhead = len(json.dumps(base).encode("utf-8"))
        pad_len = max(0, target_bytes - overhead - len('"pad":""'))
        base["pad"] = "a" * pad_len
        body = json.dumps(base).encode("utf-8")
        # json.dumps of varying pad lengths can land a byte or two off
        # due to quoting; trim/pad the pad field itself to hit exactly.
        diff = target_bytes - len(body)
        base["pad"] = "a" * max(0, pad_len + diff)
        return json.dumps(base).encode("utf-8")

    @pytest.mark.parametrize("path", ["/reason", "/complete"])
    def test_body_at_exactly_the_limit_is_accepted_for_parsing(self, path, monkeypatch):
        # "Accepted for parsing" — not necessarily 200, since the extra
        # `pad` field makes this an invalid SanitizedContext (extra="forbid").
        # The point under test is that it is NOT rejected as 413.
        app = create_app(settings_with(max_request_body_bytes=2000))
        client = TestClient(app)
        body = self._padded_body(2000)
        assert len(body) == 2000
        r = client.post(path, content=body, headers={"Content-Type": "application/json"})
        assert r.status_code != 413

    @pytest.mark.parametrize("path", ["/reason", "/complete"])
    def test_body_one_byte_over_the_limit_is_rejected_413(self, path):
        app = create_app(settings_with(max_request_body_bytes=2000))
        client = TestClient(app)
        body = self._padded_body(2001)
        assert len(body) == 2001
        r = client.post(path, content=body, headers={"Content-Type": "application/json"})
        assert r.status_code == 413
        assert r.json()["error"] == "request_too_large"

    @pytest.mark.parametrize("path", ["/reason", "/complete"])
    def test_normal_small_body_is_unaffected(self, path, ollama_backend_for):
        ollama_backend_for()
        app = create_app(settings_with(max_request_body_bytes=65536))
        client = TestClient(app)
        r = client.post(path, json=reason_payload())
        assert r.status_code != 413


# ===========================================================================
# 5. CORS
# ===========================================================================


class TestCors:
    def test_allowed_origin_gets_header_on_success(self, ollama_backend_for):
        ollama_backend_for()
        app = create_app(settings_with(allowed_origins=("http://localhost:8000",)))
        client = TestClient(app)
        r = client.post("/reason", json=reason_payload(), headers={"Origin": "http://localhost:8000"})
        assert r.headers.get("access-control-allow-origin") == "http://localhost:8000"

    def test_disallowed_origin_gets_no_header_on_success(self, ollama_backend_for):
        ollama_backend_for()
        app = create_app(settings_with(allowed_origins=("http://localhost:8000",)))
        client = TestClient(app)
        r = client.post("/reason", json=reason_payload(), headers={"Origin": "http://evil.example.com"})
        assert "access-control-allow-origin" not in {k.lower() for k in r.headers}

    def test_allowed_origin_gets_header_even_on_a_413_error(self):
        """Regression test for the ordering bug found and fixed this
        phase: CORSMiddleware must be OUTERMOST so an early rejection
        from RequestSizeLimitMiddleware still unwinds through it.
        """
        app = create_app(settings_with(max_request_body_bytes=10, allowed_origins=("http://localhost:8000",)))
        client = TestClient(app)
        r = client.post(
            "/reason",
            json=reason_payload(),
            headers={"Origin": "http://localhost:8000"},
        )
        assert r.status_code == 413
        assert r.headers.get("access-control-allow-origin") == "http://localhost:8000"

    def test_allowed_origin_gets_header_even_on_a_401_error(self):
        app = create_app(settings_with(api_key="k", allowed_origins=("http://localhost:8000",)))
        client = TestClient(app)
        r = client.post("/reason", json=reason_payload(), headers={"Origin": "http://localhost:8000"})
        assert r.status_code == 401
        assert r.headers.get("access-control-allow-origin") == "http://localhost:8000"

    def test_allowed_origins_configurable_via_settings(self, ollama_backend_for):
        ollama_backend_for()
        app = create_app(settings_with(allowed_origins=("http://my-custom-origin.example",)))
        client = TestClient(app)
        r = client.post(
            "/reason", json=reason_payload(), headers={"Origin": "http://my-custom-origin.example"}
        )
        assert r.headers.get("access-control-allow-origin") == "http://my-custom-origin.example"
        r2 = client.post("/reason", json=reason_payload(), headers={"Origin": "http://localhost:8000"})
        assert "access-control-allow-origin" not in {k.lower() for k in r2.headers}


# ===========================================================================
# 6. Error handling — no internals ever leak
# ===========================================================================


class TestErrorHandling:
    def test_unhandled_exception_never_leaks_its_message_to_the_client(self, monkeypatch):
        app = create_app(settings_with())
        client = TestClient(app, raise_server_exceptions=False)

        def boom(*a, **k):
            raise RuntimeError("leaked detail: /etc/secret/path API_KEY=should-never-appear")

        monkeypatch.setattr(reason_route._client, "propose_action", boom)
        r = client.post("/reason", json=reason_payload())

        assert r.status_code == 500
        assert r.json() == {"error": "internal_error", "detail": "internal server error", "task_id": None}
        assert "should-never-appear" not in r.text
        assert "/etc/secret/path" not in r.text
        assert "Traceback" not in r.text

    def test_reason_failure_never_fabricates_an_action_response(self, monkeypatch):
        app = create_app(settings_with())
        client = TestClient(app, raise_server_exceptions=False)
        monkeypatch.setattr(
            reason_route._client, "propose_action", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        )
        r = client.post("/reason", json=reason_payload())
        assert "action" not in r.json()

    def test_complete_failure_never_returns_complete_true(self, monkeypatch):
        from app.routes import complete as complete_route

        app = create_app(settings_with())
        client = TestClient(app, raise_server_exceptions=False)
        monkeypatch.setattr(
            complete_route._probe, "judge", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        )
        r = client.post("/complete", json=reason_payload())
        assert r.status_code != 200
        assert r.json().get("complete") is not True


# ===========================================================================
# 10. Multi-client / statelessness under concurrency
# ===========================================================================


class TestMultiClientStatelessness:
    def test_sequential_requests_from_different_clients_do_not_cross_contaminate(self, ollama_backend_for):
        ollama_backend_for()
        app = create_app(settings_with())
        client = TestClient(app)

        r_a = client.post("/reason", json=reason_payload(task_id="client-A-task"))
        r_b = client.post("/reason", json=reason_payload(task_id="client-B-task"))

        assert r_a.json()["task_id"] == "client-A-task"
        assert r_b.json()["task_id"] == "client-B-task"

    def test_concurrent_requests_from_different_clients_get_their_own_task_id_back(self, ollama_backend_for):
        ollama_backend_for()
        app = create_app(settings_with())

        async def go():
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as ac:
                results = await asyncio.gather(
                    *(ac.post("/reason", json=reason_payload(task_id=f"client-{i}")) for i in range(8))
                )
                return results

        results = asyncio.run(go())
        for i, r in enumerate(results):
            assert r.status_code == 200
            assert r.json()["task_id"] == f"client-{i}"

    def test_no_server_side_session_or_browser_state_is_stored(self):
        """Structural check: SanitizedContext carries its own history,
        and nothing in the reasoning path keys a mutable store by client
        identity. Checks for the actual PATTERN (a dict/cache literal
        assigned to a name suggesting per-client state) rather than the
        word "session" — that word legitimately appears in this
        codebase's own comments explaining that it does NOT keep one.
        """
        import inspect
        import re

        from app.routes import complete as complete_route_mod
        from app.routes import reason as reason_route_mod

        store_pattern = re.compile(r"\b\w*(session|client_id|per_client)\w*\s*[:=]\s*(\{\}|dict\(\))")
        for mod in (reason_route_mod, complete_route_mod):
            source = inspect.getsource(mod)
            assert not store_pattern.search(source), f"found a possible per-client store in {mod.__name__}"


# ===========================================================================
# 11. Privacy verification — synthetic secret-shaped values
# ===========================================================================


class TestPrivacyVerification:
    def test_sanitized_value_is_accepted(self, ollama_backend_for):
        ollama_backend_for()
        app = create_app(settings_with())
        client = TestClient(app)
        r = client.post(
            "/reason",
            json=reason_payload(fields={"1": "[PASSWORD_01]"}, elements=[{"element_id": 1, "role": "input:password", "label": "[PASSWORD_01]"}]),
        )
        assert r.status_code == 200

    def test_raw_secret_shaped_value_is_rejected(self):
        app = create_app(settings_with())
        client = TestClient(app)
        r = client.post(
            "/reason",
            json=reason_payload(
                fields={"1": "hunter2-not-a-token"},
                elements=[{"element_id": 1, "role": "input:password", "label": "hunter2-not-a-token"}],
            ),
        )
        assert r.status_code == 422
        assert r.json()["error"] == "context_rejected"

    def test_rejected_raw_secret_never_appears_in_the_error_response(self):
        app = create_app(settings_with())
        client = TestClient(app)
        raw_secret = "CANARY_RAW_SECRET_IN_ERROR_9f2a"
        r = client.post(
            "/reason",
            json=reason_payload(
                fields={"1": raw_secret},
                elements=[{"element_id": 1, "role": "input:password", "label": raw_secret}],
            ),
        )
        assert raw_secret not in r.text

    def test_raw_secret_never_reaches_ollama_prompt_construction(self, monkeypatch):
        """assert_context_is_sanitized runs BEFORE propose_action —
        confirmed structurally by making propose_action itself fail the
        test if it's ever called for a rejected context.
        """
        app = create_app(settings_with())
        client = TestClient(app, raise_server_exceptions=False)

        def fail_if_called(*a, **k):
            raise AssertionError("propose_action must never run for an unsanitized context")

        monkeypatch.setattr(reason_route._client, "propose_action", fail_if_called)
        r = client.post(
            "/reason",
            json=reason_payload(fields={"1": "raw-value"}, elements=[{"element_id": 1, "role": "input:password", "label": "raw-value"}]),
        )
        assert r.status_code == 422
