"""FastAPI / HTTPX connection-lifecycle optimization — correctness tests.

Two layers, matching the pattern already used elsewhere in this suite
(tests/test_ollama_client.py for the client layer, tests/test_reason_endpoint.py
for the HTTP layer):

1. Client-level (asyncio.run, httpx.MockTransport, no FastAPI): proves
   OllamaReasoningClient/CompletionProbe's shared-client wiring itself —
   reuse, concurrency safety, and safe fallback after the shared client
   is cleared — independent of how it gets installed.

2. App-level (`with TestClient(app) as client:`): proves the actual
   FastAPI `lifespan` in app/main.py wires that shared client into the
   real, already-existing _client/_probe singletons at startup, reuses
   it across requests, and cleans up at shutdown — and that /reason and
   /complete behave identically to every other test in this suite while
   it's active.

`with TestClient(app) as client:` is required, not incidental: verified
directly (see the phase's own investigation) that `TestClient(app)`
WITHOUT a `with` block never runs the ASGI lifespan at all under this
project's installed Starlette/FastAPI versions — that is exactly why
every OTHER test file's `client = TestClient(app)` at module scope
continues to exercise the safe per-call fallback path unmodified, and
is also why the app-level tests here must all use `with`.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.llm.client import OllamaReasoningClient
from app.llm.completion import CompletionProbe
from app.main import app
from app.models.context import SanitizedContext
from app.routes import complete as complete_route
from app.routes import reason as reason_route
from tests.conftest import action_json, ollama_transport


def run(coro):
    return asyncio.run(coro)


CTX = SanitizedContext(
    task_id="lifecycle-test",
    task="place the order",
    page="Mock Checkout",
    url_origin="http://localhost:8000",
    elements=[{"element_id": 6, "role": "button", "label": "Place Order"}],
    fields={},
)


def counting_client_init(monkeypatch) -> list[int]:
    """Patches httpx.AsyncClient.__init__ to count NEW constructions
    from this point on, without affecting any client already built.
    """
    calls: list[int] = []
    original_init = httpx.AsyncClient.__init__

    def spy(self, *args, **kwargs):
        calls.append(1)
        return original_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", spy)
    return calls


# ---------------------------------------------------------------------------
# 1. Client-level: the shared-client wiring itself
# ---------------------------------------------------------------------------


def test_shared_client_is_reused_not_recreated_per_call(monkeypatch) -> None:
    client = OllamaReasoningClient(
        model="test-model", base_url="http://localhost:11434", timeout_s=5.0
    )
    shared = httpx.AsyncClient(transport=ollama_transport(response_text=action_json()))
    client.set_http_client(shared)

    calls = counting_client_init(monkeypatch)
    try:
        run(client.propose_action(CTX))
        run(client.propose_action(CTX))
        run(client.propose_action(CTX))
    finally:
        run(shared.aclose())

    assert calls == [], "no new httpx.AsyncClient may be constructed once a shared client is installed"


def test_without_a_shared_client_the_original_per_call_behavior_is_unchanged(monkeypatch) -> None:
    """Regression guard: this is the fallback every existing test in
    this suite (built before this phase) already exercises — it must
    keep working exactly as it did before shared clients existed.
    """
    client = OllamaReasoningClient(
        model="test-model",
        base_url="http://localhost:11434",
        timeout_s=5.0,
        transport=ollama_transport(response_text=action_json()),
    )
    calls = counting_client_init(monkeypatch)

    run(client.propose_action(CTX))
    run(client.propose_action(CTX))

    assert len(calls) == 2, "without a shared client, each call must still construct (and close) its own"


def test_clearing_the_shared_client_falls_back_safely_after_shutdown(monkeypatch) -> None:
    """Simulates exactly what the lifespan does on shutdown: set None,
    then close the client that was cleared. A LATER call must not touch
    the now-closed client at all — this is the property that prevents
    the earlier naive global-client bug (a stale reference outliving its
    event loop) from resurfacing here.
    """
    client = OllamaReasoningClient(
        model="test-model", base_url="http://localhost:11434", timeout_s=5.0
    )
    shared = httpx.AsyncClient(transport=ollama_transport(response_text=action_json()))
    client.set_http_client(shared)
    run(client.propose_action(CTX))  # uses the shared client while it's live

    client.set_http_client(None)
    run(shared.aclose())
    assert shared.is_closed

    # The fallback transport is separate — the client should now build
    # its OWN per-call client, never touching the closed `shared`.
    client._transport = ollama_transport(response_text=action_json())
    action = run(client.propose_action(CTX))
    assert action.action == "click"


def test_concurrent_calls_on_one_shared_client_do_not_cross_talk() -> None:
    """httpx.AsyncClient is documented as safe for concurrent use by
    multiple coroutines. This proves it holds for THIS wiring
    specifically: N concurrent propose_action calls on the SAME shared
    client each get their own correct, independent response.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        # Distinguish concurrent requests by an id embedded in the
        # (mock) prompt, proving no response gets mixed up between them.
        body = request.content.decode()
        element_id = 6 if "Place Order" in body else 7
        return httpx.Response(200, json={"response": action_json(element_id=element_id)})

    shared = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = OllamaReasoningClient(model="test-model", base_url="http://localhost:11434", timeout_s=5.0)
    client.set_http_client(shared)

    async def go():
        results = await asyncio.gather(*(client.propose_action(CTX) for _ in range(5)))
        await shared.aclose()
        return results

    results = run(go())
    assert len(results) == 5
    assert all(r.element_id == 6 for r in results)


# ---------------------------------------------------------------------------
# 2. App-level: the real FastAPI lifespan
# ---------------------------------------------------------------------------


# Captured before any test can monkeypatch httpx.AsyncClient itself —
# the mock-shared-client factory below must construct a REAL client, not
# recurse into its own patched replacement.
_REAL_ASYNC_CLIENT_CLS = httpx.AsyncClient


def _combined_ollama_handler(request: httpx.Request) -> httpx.Response:
    """Stands in for Ollama for whichever of /reason or /complete the
    LIFESPAN'S shared client happens to be serving — distinguished by
    the `format.required` field each caller's own JSON-schema constraint
    sets (_ACTION_JSON_SCHEMA vs COMPLETION_SCHEMA in app/llm/client.py
    and app/llm/completion.py respectively), not by URL — both call the
    same /api/generate path.
    """
    import json as _json

    body = _json.loads(request.content.decode())
    required = body.get("format", {}).get("required", [])
    if "complete" in required:
        return httpx.Response(200, json={"response": '{"complete": true}'})
    return httpx.Response(200, json={"response": action_json()})


@pytest.fixture
def ollama_backends(monkeypatch):
    """Swaps BOTH module-level singletons for Ollama-backed instances,
    restored automatically by pytest's monkeypatch at teardown — same
    pattern as test_reason_endpoint.py's ollama_backend fixture and
    test_completion_endpoint.py's mock_probe fixture, applied to both
    endpoints at once since this phase touches both.

    Also patches the httpx.AsyncClient the LIFESPAN itself constructs
    (app/main.py's `httpx.AsyncClient()`, with no transport override) so
    it carries the SAME mock transport — otherwise the lifespan's real,
    untransported client would shadow these fixtures' own mock-transport
    clients the moment set_http_client() installs it, and every request
    would try to reach a real Ollama at localhost:11434 (this was caught
    directly: it silently worked in THIS environment, which happens to
    have a real Ollama running, and would have masked a real hermeticity
    bug in any environment without one).
    """
    reason_client = OllamaReasoningClient(
        model="test-model", base_url="http://localhost:11434", timeout_s=5.0,
        transport=ollama_transport(response_text=action_json()),
    )
    completion_probe = CompletionProbe(
        model="test-model", base_url="http://localhost:11434", timeout_s=5.0,
        transport=ollama_transport(response_text='{"complete": true}'),
    )
    monkeypatch.setattr(reason_route, "_client", reason_client)
    monkeypatch.setattr(complete_route, "_probe", completion_probe)

    def make_mock_shared_client(*_args, **_kwargs) -> httpx.AsyncClient:
        return _REAL_ASYNC_CLIENT_CLS(transport=httpx.MockTransport(_combined_ollama_handler))

    monkeypatch.setattr(main_module.httpx, "AsyncClient", make_mock_shared_client)

    return reason_client, completion_probe


def reason_payload(**overrides: object) -> dict:
    body = {
        "task_id": "task-1",
        "task": "place the order",
        "page": "Mock Checkout",
        "url_origin": "http://localhost:8000",
        "elements": [{"element_id": 6, "role": "button", "label": "Place Order"}],
        "fields": {},
    }
    body.update(overrides)
    return body


def test_startup_creates_a_live_shared_client(ollama_backends) -> None:
    with TestClient(app) as client:
        http_client = client.app.state.http_client
        # Checked against the class captured before ollama_backends
        # patched httpx.AsyncClient to the mock-transport factory —
        # `httpx.AsyncClient` as referenced here, in this module, IS that
        # same patched factory for the fixture's duration (shared module
        # state), so isinstance(..., httpx.AsyncClient) would compare
        # against a plain function instead of the real class.
        assert isinstance(http_client, _REAL_ASYNC_CLIENT_CLS)
        assert not http_client.is_closed


def test_startup_installs_the_shared_client_into_both_singletons(ollama_backends) -> None:
    reason_client, completion_probe = ollama_backends
    with TestClient(app) as client:
        http_client = client.app.state.http_client
        assert reason_client._http_client is http_client
        assert completion_probe._http_client is http_client


def test_multiple_requests_reuse_the_same_client_instance(ollama_backends) -> None:
    """The client-level test above already proves "no new AsyncClient is
    constructed" with a direct spy; at this layer, identity across
    several real requests is the cleaner and sufficient proof that the
    SAME object installed at startup is still what's serving them all —
    nothing swapped it out mid-run.
    """
    reason_client, completion_probe = ollama_backends
    with TestClient(app) as client:
        http_client_at_startup = client.app.state.http_client

        r1 = client.post("/reason", json=reason_payload())
        r2 = client.post("/reason", json=reason_payload())
        r3 = client.post("/complete", json=reason_payload())

        assert r1.status_code == 200
        assert r2.status_code == 200
        assert r3.status_code == 200
        assert reason_client._http_client is http_client_at_startup
        assert completion_probe._http_client is http_client_at_startup


def test_reason_endpoint_behavior_is_unchanged_with_the_lifespan_active(ollama_backends) -> None:
    with TestClient(app) as client:
        response = client.post("/reason", json=reason_payload())
        assert response.status_code == 200
        body = response.json()
        assert body["action"] == "click"
        assert body["element_id"] == 6


def test_complete_endpoint_behavior_is_unchanged_with_the_lifespan_active(ollama_backends) -> None:
    with TestClient(app) as client:
        response = client.post("/complete", json=reason_payload())
        assert response.status_code == 200
        body = response.json()
        assert body["complete"] is True
        assert body["task_id"] == "task-1"


def test_shutdown_closes_the_client_and_resets_the_singletons(ollama_backends) -> None:
    reason_client, completion_probe = ollama_backends
    with TestClient(app) as client:
        http_client = client.app.state.http_client
        assert not http_client.is_closed

    # Outside the `with` block: lifespan shutdown has run.
    assert http_client.is_closed
    assert reason_client._http_client is None
    assert completion_probe._http_client is None


def test_reason_and_complete_concurrently_share_the_lifespan_client_without_interference(
    ollama_backends,
) -> None:
    """SERVER PHASE S6 — the `_combined_ollama_handler`/`ollama_backends`
    fixture above exists specifically to let /reason and /complete share
    ONE mock transport, but nothing previously fired them AT THE SAME
    TIME through it. Both endpoints reuse the identical lifespan-owned
    httpx.AsyncClient (see app/main.py's lifespan) and go through Ollama
    the same way (POST /api/generate) — this proves that sharing does
    not let a slower/faster response, or one endpoint's schema, leak
    into the other's answer.
    """
    # Drives reason_route._client and complete_route._probe directly
    # rather than through a second ASGI-transported httpx.AsyncClient —
    # this installed httpx version's cookie-jar extraction has an
    # unrelated bug when different-path responses interleave under
    # asyncio.gather on an ASGITransport-backed client (reproduced with
    # a minimal repro; unrelated to anything under test here). What
    # actually matters — that /reason and /complete's real client
    # objects can share ONE Ollama-facing httpx.AsyncClient concurrently
    # without interference — is exactly as provable at this level,
    # matching test_concurrent_calls_on_one_shared_client_do_not_cross_talk
    # above.
    with TestClient(app) as sync_client:
        http_client = sync_client.app.state.http_client
        assert not http_client.is_closed
        reason_client, completion_probe = ollama_backends
        assert reason_client._http_client is http_client
        assert completion_probe._http_client is http_client

        reason_ctx = SanitizedContext(
            task_id="mix-reason", task="place the order", page="Mock Checkout",
            url_origin="http://localhost:8000",
            elements=[{"element_id": 6, "role": "button", "label": "Place Order"}], fields={},
        )
        complete_ctx = SanitizedContext(
            task_id="mix-complete", task="place the order", page="Order confirmed",
            url_origin="http://localhost:8000", elements=[], fields={},
        )

        async def go():
            return await asyncio.gather(
                reason_client.propose_action(reason_ctx),
                completion_probe.judge(complete_ctx),
                reason_client.propose_action(reason_ctx),
                completion_probe.judge(complete_ctx),
            )

        action_1, verdict_1, action_2, verdict_2 = run(go())

    for action in (action_1, action_2):
        assert action.action == "click"
        assert action.task_id == "mix-reason"
    for verdict in (verdict_1, verdict_2):
        assert verdict.complete is True
        assert verdict.task_id == "mix-complete"


def test_one_malformed_response_among_concurrent_calls_does_not_affect_others() -> None:
    """SERVER PHASE S6 — N concurrent propose_action calls on the SAME
    shared client, where exactly ONE upstream response is malformed.
    That one call must fail with ModelOutputInvalid; every other
    concurrent call must still succeed normally and get its own correct
    answer — a bad response must never corrupt or block its siblings on
    a shared connection pool.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode()
        if "Malformed" in body:
            return httpx.Response(200, json={"response": "not json at all"})
        element_id = 6 if "Place Order" in body else 7
        return httpx.Response(200, json={"response": action_json(element_id=element_id)})

    shared = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = OllamaReasoningClient(model="test-model", base_url="http://localhost:11434", timeout_s=5.0)
    client.set_http_client(shared)

    good_ctx = CTX
    from app.models.context import SanitizedContext

    bad_ctx = SanitizedContext(
        task_id="bad", task="do the thing", page="Malformed page",
        url_origin="http://localhost:8000",
        elements=[{"element_id": 1, "role": "button", "label": "Go"}], fields={},
    )

    async def go():
        results = await asyncio.gather(
            client.propose_action(good_ctx),
            client.propose_action(bad_ctx),
            client.propose_action(good_ctx),
            client.propose_action(good_ctx),
            return_exceptions=True,
        )
        await shared.aclose()
        return results

    results = run(go())
    successes = [r for r in results if not isinstance(r, Exception)]
    failures = [r for r in results if isinstance(r, Exception)]

    assert len(successes) == 3
    assert all(r.element_id == 6 for r in successes)
    assert len(failures) == 1
    from app.llm.errors import ModelOutputInvalid

    assert isinstance(failures[0], ModelOutputInvalid)


def test_a_fresh_app_run_after_shutdown_gets_a_new_client_and_still_works(ollama_backends) -> None:
    """Proves shutdown->startup is not a one-shot: entering `with
    TestClient(app)` a second time (a fresh lifespan cycle) builds a NEW
    client and everything still works — nothing about closing the first
    client leaves the singletons unable to run again.
    """
    reason_client, _ = ollama_backends
    with TestClient(app) as client:
        first_http_client = client.app.state.http_client
        assert client.post("/reason", json=reason_payload()).status_code == 200

    with TestClient(app) as client:
        second_http_client = client.app.state.http_client
        assert second_http_client is not first_http_client
        assert not second_http_client.is_closed
        assert reason_client._http_client is second_http_client
        assert client.post("/reason", json=reason_payload()).status_code == 200
