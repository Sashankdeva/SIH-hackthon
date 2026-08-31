"""Optional LIVE multi-step integration test against a real local Ollama.

Skipped automatically when Ollama isn't reachable or the model isn't
pulled — same guard as test_integration_ollama.py, whose fixture
pattern this file follows.

This does NOT test the multi-step LOOP (that's client/extension-owned
and explicitly out of scope this phase — see content/index.ts). It
proves the one thing that IS server-owned: given a realistic sequence
of page states and a growing sanitized history, does the real model
keep producing schema-valid, non-hallucinated actions at every step,
without the server holding any state between calls?

Each step below is an independent client.propose_action() call — the
history from the previous step is built by hand here, exactly as
extension/src/content/index.ts's runTask() loop would build it in
production. No real personal data anywhere: this is a shopping-cart
flow with no login/PII fields at all.

Run it deliberately with:
    pytest tests/test_integration_multistep_live.py -v -s
"""

import time

import httpx
import pytest

from app.config import load_settings
from app.llm.client import OllamaReasoningClient
from app.models.action import ActionResponse
from app.models.context import CapturedElement, SanitizedContext, StepRecord

_settings = load_settings()


def _ollama_available() -> bool:
    try:
        response = httpx.get(f"{_settings.ollama_base_url}/api/tags", timeout=2.0)
        if response.status_code != 200:
            return False
        names = {m.get("name") for m in response.json().get("models", [])}
        return _settings.ollama_model in names
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _ollama_available(),
    reason=f"Ollama with model {_settings.ollama_model!r} not reachable at {_settings.ollama_base_url}",
)

TASK = "add the samsung phone to the cart"
ORIGIN = "http://localhost:8000"


def _ctx(task_id: str, page: str, elements: list[dict], history: list[StepRecord]) -> SanitizedContext:
    return SanitizedContext(
        task_id=task_id,
        task=TASK,
        page=page,
        url_origin=ORIGIN,
        elements=[CapturedElement(**el) for el in elements],
        fields={},
        history=history,
    )


def _assert_no_hallucinated_target(action: ActionResponse, valid_ids: set[int]) -> None:
    if action.element_id is not None:
        assert action.element_id in valid_ids, (
            f"model targeted element_id={action.element_id}, not in the supplied set {valid_ids}"
        )


def test_progressive_add_to_cart_flow_produces_valid_non_hallucinated_actions() -> None:
    client = OllamaReasoningClient()
    task_id = "live-multistep-cart-001"
    history: list[StepRecord] = []
    latencies_ms: list[float] = []

    # ---- Step 1: identify the product on a listing page ----
    step1_elements = [
        {"element_id": 1, "role": "link", "label": "View Pixel 8 - $699"},
        {"element_id": 2, "role": "link", "label": "View Samsung Galaxy S24 - $799"},
        {"element_id": 3, "role": "link", "label": "View iPhone 15 - $999"},
    ]
    ctx1 = _ctx(task_id, "Product listing", step1_elements, history)
    t0 = time.perf_counter()
    action1 = _run(client, ctx1)
    latencies_ms.append((time.perf_counter() - t0) * 1000)
    _assert_no_hallucinated_target(action1, {1, 2, 3})
    assert action1.step_id == 1
    print(f"\n[step 1 identify product] -> {action1.action} element_id={action1.element_id} "
          f"confidence={action1.confidence:.2f} ({latencies_ms[-1]:.0f}ms)")
    history.append(
        StepRecord(step=1, action=action1.action, element_id=action1.element_id, element_label="Samsung link", outcome="success")
    )

    # ---- Step 2: open the product (a preview panel now shows a details link) ----
    step2_elements = [
        {"element_id": 1, "role": "link", "label": "View Pixel 8 - $699"},
        {"element_id": 2, "role": "link", "label": "View Samsung Galaxy S24 - $799"},
        {"element_id": 3, "role": "link", "label": "View iPhone 15 - $999"},
        {"element_id": 4, "role": "button", "label": "Open Samsung Galaxy S24 details"},
    ]
    ctx2 = _ctx(task_id, "Product listing (Samsung preview expanded)", step2_elements, history)
    t0 = time.perf_counter()
    action2 = _run(client, ctx2)
    latencies_ms.append((time.perf_counter() - t0) * 1000)
    _assert_no_hallucinated_target(action2, {1, 2, 3, 4})
    assert action2.step_id == 2
    print(f"[step 2 open product]     -> {action2.action} element_id={action2.element_id} "
          f"confidence={action2.confidence:.2f} ({latencies_ms[-1]:.0f}ms)")
    history.append(
        StepRecord(step=2, action=action2.action, element_id=action2.element_id, element_label="Open details button", outcome="success")
    )

    # ---- Step 3: select a required option (storage) before Add to Cart works ----
    step3_elements = [
        {"element_id": 1, "role": "button", "label": "128GB"},
        {"element_id": 2, "role": "button", "label": "256GB"},
        {"element_id": 3, "role": "button", "label": "512GB"},
        {"element_id": 4, "role": "button", "label": "Add to Cart (select storage first)"},
        {"element_id": 5, "role": "link", "label": "Back to listing"},
    ]
    ctx3 = _ctx(task_id, "Product: Samsung Galaxy S24", step3_elements, history)
    t0 = time.perf_counter()
    action3 = _run(client, ctx3)
    latencies_ms.append((time.perf_counter() - t0) * 1000)
    _assert_no_hallucinated_target(action3, {1, 2, 3, 4, 5})
    assert action3.step_id == 3
    # Any storage size is a legitimate answer — the task never specified
    # one. What matters is it picked A storage button, not the disabled
    # Add to Cart or the Back link.
    print(f"[step 3 select option]    -> {action3.action} element_id={action3.element_id} "
          f"confidence={action3.confidence:.2f} ({latencies_ms[-1]:.0f}ms)")
    chosen_storage = action3.element_id
    history.append(
        StepRecord(step=3, action=action3.action, element_id=chosen_storage, element_label="storage option", outcome="success")
    )

    # ---- Step 4: add to cart, now that storage is selected ----
    step4_elements = [
        {"element_id": 1, "role": "button", "label": "128GB (selected)" if chosen_storage == 1 else "128GB"},
        {"element_id": 2, "role": "button", "label": "256GB (selected)" if chosen_storage == 2 else "256GB"},
        {"element_id": 3, "role": "button", "label": "512GB (selected)" if chosen_storage == 3 else "512GB"},
        {"element_id": 4, "role": "button", "label": "Add to Cart"},
        {"element_id": 6, "role": "button", "label": "Buy Now"},
        {"element_id": 5, "role": "link", "label": "Back to listing"},
    ]
    ctx4 = _ctx(task_id, "Product: Samsung Galaxy S24", step4_elements, history)
    t0 = time.perf_counter()
    action4 = _run(client, ctx4)
    latencies_ms.append((time.perf_counter() - t0) * 1000)
    _assert_no_hallucinated_target(action4, {1, 2, 3, 4, 5, 6})
    assert action4.step_id == 4
    print(f"[step 4 add to cart]      -> {action4.action} element_id={action4.element_id} "
          f"confidence={action4.confidence:.2f} ({latencies_ms[-1]:.0f}ms)")

    print(f"\nlatencies (ms): {[round(m) for m in latencies_ms]}")
    print(f"mean latency: {sum(latencies_ms) / len(latencies_ms):.0f}ms")

    # The one hard assertion about step 4's CONTENT: it must not invent
    # anything, and every prior step must have been schema-valid — both
    # already checked above. Whether it correctly avoids "Buy Now" /
    # re-clicking storage is reasoning QUALITY, reported, not asserted,
    # to keep this test from being flaky against normal model variance.
    if action4.action == "click" and action4.element_id == 4:
        print("[step 4] correctly targeted Add to Cart")
    else:
        print(f"[step 4] NOTE: did not click Add to Cart (got action={action4.action}, "
              f"element_id={action4.element_id}) — reasoning-quality observation, not a failure")


def _run(client: OllamaReasoningClient, ctx: SanitizedContext) -> ActionResponse:
    import asyncio

    return asyncio.run(client.propose_action(ctx))
