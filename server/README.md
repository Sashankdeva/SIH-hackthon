# server/

FastAPI backend — owned by **Role 4 (Server AI)**. Receives sanitized
context only, reasons over it, returns one structured action.

| File | What it does |
|---|---|
| `app/main.py` | App instance, CORS (scoped to the mock site's origin), `/health`. |
| `app/models/context.py` | `SanitizedContext` — `extra="forbid"` rejects any field the schema didn't expect. |
| `app/models/action.py` | `ActionResponse` — mirrors `shared/schemas/action.schema.json`. |
| `app/validators/context_validator.py` | Server-side half of the privacy firewall — catches a redacted-looking-but-not field before it reaches reasoning. |
| `app/config.py` | All environment configuration in one place. No machine-specific paths anywhere else. |
| `app/llm/prompt.py` | Prompt construction — the only place the model's instructions live. |
| `app/llm/validation.py` | Deterministic security validation of model output. **This is the security boundary, not the prompt.** |
| `app/llm/errors.py` | Typed failures (`ModelUnavailable` 503, `ModelOutputInvalid` 502, `ActionRejected` 422). |
| `app/llm/client.py` | `ReasoningClient` interface, `StubReasoningClient` (default), `OllamaReasoningClient` (local model). |
| `app/routes/reason.py` | The one endpoint the extension calls: `POST /reason`. Picks the backend via `REASONING_BACKEND`. |

## Error contract

A failure is **never** HTTP 200. The extension must be able to tell "the
model deliberately chose to wait" from "the server could not produce a
trustworthy answer" — a fabricated `wait` makes those identical, which
is what this server used to do.

| Status | `error` | Cause |
|---|---|---|
| 200 | — | A validated action |
| 422 | `action_rejected` | Model answered, but the action failed deterministic validation (invented element, token misuse, off-origin navigation, code in a value…) |
| 502 | `model_output_invalid` | Model answered with something that isn't a single JSON object (prose, truncated JSON, an array) |
| 503 | `model_unavailable` | Ollama unreachable, model not pulled, or timed out |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `REASONING_BACKEND` | `stub` | `ollama` for the real model |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Model tag |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_TIMEOUT_S` | `60` | Generous — a cold model pages into VRAM before emitting a token |

## Setup

```bash
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt  # macOS/Linux

./.venv/Scripts/python.exe -m pytest -q      # 55 passed (52 hermetic + 3 real-Ollama integration, auto-skipped if absent)
./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8787
```

Test layout:

| File | Covers |
|---|---|
| `tests/test_health.py` | Endpoint basics + `test_reason_rejects_unredacted_field`, the automated canary-value privacy proof. Keep it green — cheapest regression check for the project's core claim. |
| `tests/test_validation.py` | The deterministic security layer: every action type, and every refusal (invented ids, token misuse, secret/field mismatch, off-origin + `javascript:` URLs, code in values, unexpected fields). |
| `tests/test_ollama_client.py` | Model-failure paths through a mocked transport: unreachable, timeout, model not pulled, prose, truncated JSON, arrays. |
| `tests/test_reason_endpoint.py` | HTTP status mapping — proves a failure is never 200-with-an-action. |
| `tests/test_privacy.py` | No raw values in the prompt, the response, or the logs. |
| `tests/test_integration_ollama.py` | Optional; runs against the real local model, auto-skips when Ollama isn't reachable. |

## Reasoning backend: local by design, not by default

**The privacy boundary is client-side redaction, not "no server."** By
the time anything reaches this server, PII is already replaced with
tokens like `[EMAIL_01]` — see `docs/ARCHITECTURE.md`. This project's
specific choice is to run the reasoning model **locally too**, on
Server AI's own GPU, rather than call a cloud API. That's a deliberate
step further than the architecture requires, not a workaround for a
privacy gap.

Because that needs a real GPU, the server **defaults to a stub** so the
other five roles can run `/reason` with zero setup:

```bash
# Default — no GPU, no model, always returns a harmless "wait":
./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8787
```

**Server AI, to run the real thing:**

1. Install [Ollama](https://ollama.com) (confirm with the team before
   downloading anything on a shared/lab machine).
2. `ollama pull qwen2.5:7b-instruct` (~4.7&nbsp;GB download; comfortably
   fits an 8GB-VRAM GPU at Q4 quantization alongside Chrome + this server).
3. `ollama serve` (usually already running as a background service after install — check `http://localhost:11434`).
4. Run the server with the Ollama backend selected:

   ```bash
   # Windows PowerShell
   $env:REASONING_BACKEND = "ollama"
   ./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8787
   ```

`OllamaReasoningClient` never forwards anything unvalidated, and never
substitutes an action for a failure — it raises a typed error that
becomes a 502/503/422 (see **Error contract** above).

**Measured on this project's RTX 5070 laptop, qwen2.5:7b-instruct:**
first call after a (re)start takes ~30s while the model loads into VRAM;
every call after that is ~1.5–5s. `OLLAMA_TIMEOUT_S` defaults to 60
specifically to survive that cold start rather than reporting a
spurious `model_unavailable`.

**Prompt is tuned, not guessed.** An earlier revision of rule 2
emphasised caution ("doing nothing is a CORRECT answer") and the 7B
model then answered `wait` to everything — measured 0/3 on a
three-task benchmark against 3/3 for the directive wording now in
`app/llm/prompt.py`. Don't re-add refusal encouragement without
re-running that comparison. `temperature` is pinned to 0 because at 0.1
the same page and task produced different actions across runs, which a
reproducible demo can't tolerate.

**For the rest of the team:** leave `REASONING_BACKEND` unset. You don't
need Ollama installed to develop against a live `/reason` endpoint.

## Demoing without a local GPU

Two options if you're showing this on a laptop that isn't running Ollama:

**1. Stub mode (zero setup).** Leave `REASONING_BACKEND` unset on that
laptop. The whole privacy → redact → execute → verify loop runs and
proves itself; reasoning is always `wait` instead of a real action.

**2. Point at the GPU laptop over LAN.** Keep Ollama + this server
running here, and have the demo laptop's extension talk to it over
WiFi instead of `localhost`:

1. On this machine, find the LAN IP (`ipconfig` → IPv4 Address) and run
   the server bound to all interfaces, not just localhost:
   ```bash
   ./.venv/Scripts/python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8787
   ```
2. On the demo laptop, open the extension's popup → Server field → set
   it to `http://<this-machine's-LAN-IP>:8787/reason` → Save.
3. **Before rebuilding**, add that same origin to
   `extension/manifest.json`'s `host_permissions` (e.g.
   `"http://192.168.1.23:8787/*"`) — the popup setting alone doesn't
   grant the extension permission to reach a new host. Then
   `npm run build` and reload the unpacked extension.

Both laptops need to be on the same network, and this machine's
firewall needs to allow inbound connections on port 8787.
