"""
FastAPI / HTTPX connection-lifecycle optimization — performance measurement.

Measures the ACTUAL, real-Ollama cost of constructing a new
httpx.AsyncClient per /reason or /complete call ("BEFORE" — every call
sets OllamaReasoningClient/CompletionProbe's `_http_client` to None, the
original fallback path) against reusing one lifespan-managed client
("AFTER" — the same shared httpx.AsyncClient a real FastAPI app would
install via app/main.py's `lifespan`).

Requires a real, reachable Ollama with the configured model already
pulled (see app/config.py) — this is a measurement script, not a test;
it exits early with a clear message if Ollama isn't reachable rather
than fabricating numbers.

Run from server/ with the project's venv active:
    python -m benchmarks.http_lifecycle_benchmark

Methodology notes (read before trusting any number this prints):
  - BEFORE/AFTER calls for /reason and /complete are INTERLEAVED
    (before, after, before, after, ...), not run as two separate
    blocks — this controls for any system-level drift over the run
    (thermal state, VRAM residency, OS scheduler noise) that a blocked
    design would confound with the thing actually being measured.
  - A warm-up call precedes every measured phase so cold-start model
    loading (~30s per this project's own prior measurements) never
    contaminates a "connection overhead" number — every timed call here
    is against an already-resident model.
  - The connection/setup-overhead micro-benchmark hits Ollama's cheap
    /api/tags (no generation) specifically to isolate httpx client
    construction cost from LLM inference time, which otherwise
    dominates and would hide a few hundred milliseconds of overhead
    inside multi-second totals.
  - Concurrency numbers are real wall-clock from this one machine's one
    Ollama instance at whatever GPU/CPU it has; they say nothing about
    how Ollama would behave under a different OLLAMA_NUM_PARALLEL
    setting or hardware, which is exactly the kind of claim the phase
    spec warns against extrapolating.
"""

from __future__ import annotations

import asyncio
import json
import statistics
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx

from app.config import load_settings
from app.llm.client import OllamaReasoningClient
from app.llm.completion import CompletionProbe
from app.models.context import SanitizedContext

RESULTS_PATH = Path(__file__).parent / "results" / "http_lifecycle_benchmark.json"

CONTEXT = SanitizedContext(
    task_id="bench-lifecycle",
    task="place the order",
    page="Mock Checkout",
    url_origin="http://localhost:8000",
    elements=[
        {"element_id": 1, "role": "input:text", "label": "[PERSON_NAME_01]"},
        {"element_id": 2, "role": "input:email", "label": "[EMAIL_01]"},
        {"element_id": 3, "role": "button", "label": "Place Order"},
    ],
    fields={"1": "[PERSON_NAME_01]", "2": "[EMAIL_01]"},
)


@dataclass
class Stats:
    n: int
    mean_ms: float
    p50_ms: float
    p95_ms: float
    p99_ms: float
    min_ms: float
    max_ms: float


def compute_stats(samples_s: list[float]) -> Stats:
    ms = sorted(s * 1000 for s in samples_s)
    n = len(ms)

    def pct(p: float) -> float:
        idx = min(n - 1, max(0, round(p * (n - 1))))
        return ms[idx]

    return Stats(
        n=n,
        mean_ms=round(statistics.mean(ms), 1),
        p50_ms=round(pct(0.50), 1),
        p95_ms=round(pct(0.95), 1),
        p99_ms=round(pct(0.99), 1),
        min_ms=round(ms[0], 1),
        max_ms=round(ms[-1], 1),
    )


async def check_ollama_reachable(base_url: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(f"{base_url}/api/tags")
            return r.status_code == 200
    except httpx.HTTPError:
        return False


# ---------------------------------------------------------------------------
# 1. Pure connection/setup overhead — isolated from LLM inference entirely
# ---------------------------------------------------------------------------


async def measure_connection_overhead(base_url: str, n: int) -> dict[str, Stats]:
    per_call_times: list[float] = []
    shared_times: list[float] = []

    shared = httpx.AsyncClient()
    try:
        for _ in range(n):
            t0 = time.perf_counter()
            async with httpx.AsyncClient() as c:
                await c.get(f"{base_url}/api/tags")
            per_call_times.append(time.perf_counter() - t0)

            t0 = time.perf_counter()
            await shared.get(f"{base_url}/api/tags")
            shared_times.append(time.perf_counter() - t0)
    finally:
        await shared.aclose()

    return {"per_call_client": compute_stats(per_call_times), "shared_client": compute_stats(shared_times)}


# ---------------------------------------------------------------------------
# 2. /reason end-to-end, interleaved BEFORE (per-call client) vs AFTER (shared)
# ---------------------------------------------------------------------------


async def measure_reason(n: int) -> dict[str, Stats]:
    client = OllamaReasoningClient()
    shared = httpx.AsyncClient()
    before: list[float] = []
    after: list[float] = []
    try:
        # Warm-up (not measured): ensures the model is already resident
        # in VRAM before any timed call.
        client.set_http_client(None)
        await client.propose_action(CONTEXT)

        for _ in range(n):
            client.set_http_client(None)
            t0 = time.perf_counter()
            await client.propose_action(CONTEXT)
            before.append(time.perf_counter() - t0)

            client.set_http_client(shared)
            t0 = time.perf_counter()
            await client.propose_action(CONTEXT)
            after.append(time.perf_counter() - t0)
    finally:
        client.set_http_client(None)
        await shared.aclose()

    return {"before_per_call_client": compute_stats(before), "after_shared_client": compute_stats(after)}


# ---------------------------------------------------------------------------
# 3. /complete end-to-end, same interleaved design
# ---------------------------------------------------------------------------


async def measure_complete(n: int) -> dict[str, Stats]:
    probe = CompletionProbe()
    shared = httpx.AsyncClient()
    before: list[float] = []
    after: list[float] = []
    try:
        probe.set_http_client(None)
        await probe.judge(CONTEXT)

        for _ in range(n):
            probe.set_http_client(None)
            t0 = time.perf_counter()
            await probe.judge(CONTEXT)
            before.append(time.perf_counter() - t0)

            probe.set_http_client(shared)
            t0 = time.perf_counter()
            await probe.judge(CONTEXT)
            after.append(time.perf_counter() - t0)
    finally:
        probe.set_http_client(None)
        await shared.aclose()

    return {"before_per_call_client": compute_stats(before), "after_shared_client": compute_stats(after)}


# ---------------------------------------------------------------------------
# 4. Concurrency — real wall-clock for 1 / 2 / 3 concurrent /reason calls
# ---------------------------------------------------------------------------


async def measure_concurrency(levels: list[int], trials: int) -> dict[int, dict[str, float]]:
    client = OllamaReasoningClient()
    shared = httpx.AsyncClient()
    client.set_http_client(shared)
    results: dict[int, dict[str, float]] = {}
    try:
        # Warm-up.
        await client.propose_action(CONTEXT)

        for level in levels:
            wall_times: list[float] = []
            for _ in range(trials):
                t0 = time.perf_counter()
                await asyncio.gather(*(client.propose_action(CONTEXT) for _ in range(level)))
                wall_times.append(time.perf_counter() - t0)
            results[level] = {
                "trials": trials,
                "mean_wall_s": round(statistics.mean(wall_times), 2),
                "min_wall_s": round(min(wall_times), 2),
                "max_wall_s": round(max(wall_times), 2),
                "mean_wall_per_request_s": round(statistics.mean(wall_times) / level, 2),
            }
    finally:
        client.set_http_client(None)
        await shared.aclose()

    return results


async def main() -> None:
    settings = load_settings()
    base_url = settings.ollama_base_url

    print(f"Checking Ollama at {base_url} ...")
    if not await check_ollama_reachable(base_url):
        print(
            "Ollama is not reachable — this benchmark requires a real, running "
            "Ollama with the configured model pulled. Aborting rather than "
            "fabricating numbers."
        )
        return
    print(f"Ollama reachable. Model configured: {settings.ollama_model}\n")

    report: dict[str, object] = {}

    print("[1/4] Connection/setup overhead (isolated, /api/tags, no generation) ...")
    conn = await measure_connection_overhead(base_url, n=30)
    report["connection_overhead"] = {k: asdict(v) for k, v in conn.items()}
    for k, v in conn.items():
        print(f"  {k}: mean={v.mean_ms}ms p50={v.p50_ms}ms p95={v.p95_ms}ms p99={v.p99_ms}ms (n={v.n})")

    print("\n[2/4] /reason end-to-end, interleaved before/after (n=15 each) ...")
    reason_stats = await measure_reason(n=15)
    report["reason"] = {k: asdict(v) for k, v in reason_stats.items()}
    for k, v in reason_stats.items():
        print(f"  {k}: mean={v.mean_ms}ms p50={v.p50_ms}ms p95={v.p95_ms}ms p99={v.p99_ms}ms (n={v.n})")

    print("\n[3/4] /complete end-to-end, interleaved before/after (n=15 each) ...")
    complete_stats = await measure_complete(n=15)
    report["complete"] = {k: asdict(v) for k, v in complete_stats.items()}
    for k, v in complete_stats.items():
        print(f"  {k}: mean={v.mean_ms}ms p50={v.p50_ms}ms p95={v.p95_ms}ms p99={v.p99_ms}ms (n={v.n})")

    print("\n[4/4] Concurrency (shared client), 1 vs 2 vs 3 concurrent /reason calls, 2 trials each ...")
    concurrency = await measure_concurrency([1, 2, 3], trials=2)
    report["concurrency"] = concurrency
    for level, stats in concurrency.items():
        print(
            f"  {level} concurrent: mean wall={stats['mean_wall_s']}s "
            f"(min={stats['min_wall_s']}s max={stats['max_wall_s']}s) "
            f"-> {stats['mean_wall_per_request_s']}s/request effective"
        )

    RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULTS_PATH.write_text(json.dumps(report, indent=2))
    print(f"\nFull results written to {RESULTS_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
