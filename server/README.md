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

Every failure — regardless of cause — has the same body shape:
`{"error": <code>, "detail": <human-readable message>, "task_id": <string or null>}`.
`task_id` is `null` only when the request never parsed far enough to
contain one.

| Status | `error` | Cause |
|---|---|---|
| 200 | — | A validated action, matching `ActionResponse` exactly |
| 413 | `request_too_large` | Body exceeded `MAX_REQUEST_BODY_BYTES` — rejected before parsing or any model call |
| 422 | `invalid_request` | Request never reached reasoning: malformed JSON, a missing/wrong-typed field, an invalid enum value (e.g. a bad `history` outcome) |
| 422 | `context_rejected` | Request parsed, but a `fields` value isn't a redaction token — the privacy check rejected it before reasoning ran |
| 422 | `action_rejected` | Model answered, but the *action it proposed* failed deterministic validation (invented element, token misuse, off-origin navigation, code in a value…) |
| 502 | `model_output_invalid` | Model answered with something that isn't a single JSON object (prose, truncated JSON, an array) |
| 503 | `model_unavailable` | Ollama unreachable, model not pulled, or timed out |
| 500 | `internal_error` | An unanticipated server-side failure. The real exception and traceback are logged server-side only — never in the response |

`invalid_request` and `context_rejected` are deliberately separate codes
even though both are 422: one is "your request doesn't parse," the
other is "your request parsed but isn't sanitized." Conflating them
would make it harder for a client to know what to fix. Same reasoning
kept `action_rejected` distinct from both — that one is about the
*model's* output, not the client's request at all.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Interface FastAPI binds to. Loopback-only by default; see **Running on the LAN** below. |
| `PORT` | `8787` | Port FastAPI listens on. |
| `REASONING_BACKEND` | `stub` | `ollama` for the real model |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Model tag |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint — keep this pointed at `localhost`; see **Running on the LAN** |
| `OLLAMA_TIMEOUT_S` | `60` | Generous — a cold model pages into VRAM before emitting a token |
| `MAX_REQUEST_BODY_BYTES` | `65536` (64 KiB) | `/reason`/`/complete` request bodies larger than this get 413, before parsing or any model call. Real payloads measured 120-1100 bytes; this default leaves generous headroom |
| `API_KEY` | (empty — disabled) | Requires a matching `X-API-Key` header on `/reason`/`/complete` when set. See `.env.example` and `app/auth.py`. |
| `LOG_FULL_REQUEST_BODY` | `false` | Whether the audit log persists full request bodies, not just hash/size/status/timing. Synthetic-data-only demos only — see `.env.example`. |
| `ALLOWED_ORIGINS` | `http://localhost:8000,http://127.0.0.1:8000` | Comma-separated CORS allow-list. See `.env.example` for what this does and doesn't protect. |

See `docs/DEPLOYMENT.md` for the full setup/troubleshooting guide, including these three.

Copy `.env.example` to `.env` for reference — the app reads these from
the real process environment (`os.getenv`, in `app/config.py`), not from
the file directly, so export them in your shell or use a process
manager/`.env` loader of your choice.

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

## Running on the LAN

This server is designed to run standalone, on its own machine, serving
one or more browser-extension clients over the network — not only as a
same-laptop `localhost` process. The reasoning core (`app/llm/`,
`app/models/`, `app/validators/`) has no knowledge of hosting or
network topology at all; only binding and the Ollama endpoint change.

**Ollama must stay reachable from this machine only.** Every request to
Ollama originates from this FastAPI process itself
(`app/llm/client.py`'s `OllamaReasoningClient`, via `OLLAMA_BASE_URL`).
No other machine — not even a client extension — ever talks to Ollama
directly. Leave `OLLAMA_BASE_URL=http://localhost:11434` and leave
Ollama's own binding at its default (loopback); do not set an
`OLLAMA_HOST` that exposes Ollama itself to the network. FastAPI is the
only thing that needs to be LAN-reachable — Ollama does not.

**Steps:**

1. Find this machine's LAN IP:
   ```bash
   ipconfig            # Windows — look for "IPv4 Address" under your active adapter
   # ifconfig / ip a    # macOS/Linux
   ```
2. Set `HOST` to `0.0.0.0` (any interface) or to that specific IP (that
   interface only), and optionally `PORT` if you don't want the
   default:
   ```bash
   # Windows PowerShell
   $env:HOST = "0.0.0.0"
   $env:PORT = "8787"
   $env:REASONING_BACKEND = "ollama"
   ./.venv/Scripts/python.exe -m app.main
   ```
   ```bash
   # macOS/Linux
   HOST=0.0.0.0 PORT=8787 REASONING_BACKEND=ollama ./.venv/bin/python -m app.main
   ```
   `python -m app.main` reads `HOST`/`PORT` from the environment (via
   `app/config.py`) and calls `uvicorn.run(...)` itself — no CLI flags
   to remember. The `uvicorn app.main:app --reload --port 8787` form
   used elsewhere in this README still works for local dev with hot
   reload; `--reload` just isn't compatible with the settings-driven
   `python -m app.main` entry point, so pass `--host`/`--port` directly
   on that command line instead if you want both.
3. Allow inbound connections on that port through this machine's
   firewall (first LAN connection attempt will usually prompt Windows
   Firewall automatically; accept for at least "Private networks").
4. From another machine on the same network, confirm reachability
   before pointing an extension at it:
   ```bash
   curl http://<this-machine's-LAN-IP>:8787/health
   # {"status":"ok"}
   ```
5. On the client laptop, set the extension's Server URL (popup → Server
   field) to `http://<this-machine's-LAN-IP>:8787/reason`, and add that
   same origin to `extension/manifest.json`'s `host_permissions` before
   rebuilding — Chrome blocks the content script's fetch at the
   extension level if the origin isn't listed there, independent of
   what the popup field says. (Client-side change, not part of this
   server's setup — see `extension/README.md`.)

Optional API-key authentication exists — set `API_KEY` here and the
matching value in the extension popup's "API key" field (Server
section) to require it. Unset by default, matching every other setting
in this file. See `.env.example` and `docs/DEPLOYMENT.md` before
exposing this server beyond machines you personally control.

## Demoing without a local GPU

Two options if you're showing this on a laptop that isn't running Ollama:

**1. Stub mode (zero setup).** Leave `REASONING_BACKEND` unset on that
laptop. The whole privacy → redact → execute → verify loop runs and
proves itself; reasoning is always `wait` instead of a real action.

**2. Point at the GPU laptop over LAN.** Keep Ollama + this server
running here, and have the demo laptop's extension talk to it over
WiFi instead of `localhost` — see **Running on the LAN** above for the
full steps (binding, firewall, manifest permission). Both laptops need
to be on the same network.
