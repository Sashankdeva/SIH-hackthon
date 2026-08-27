# server/

FastAPI backend — owned by **Role 4 (Server AI)**. Receives sanitized
context only, reasons over it, returns one structured action.

| File | What it does |
|---|---|
| `app/main.py` | App instance, CORS (scoped to the mock site's origin), `/health`. |
| `app/models/context.py` | `SanitizedContext` — `extra="forbid"` rejects any field the schema didn't expect. |
| `app/models/action.py` | `ActionResponse` — mirrors `shared/schemas/action.schema.json`. |
| `app/validators/context_validator.py` | Server-side half of the privacy firewall — catches a redacted-looking-but-not field before it reaches reasoning. |
| `app/llm/client.py` | `ReasoningClient` interface, `StubReasoningClient` (default), `OllamaReasoningClient` (local model). |
| `app/routes/reason.py` | The one endpoint the extension calls: `POST /reason`. Picks the backend via `REASONING_BACKEND`. |

## Setup

```bash
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt  # macOS/Linux

./.venv/Scripts/python.exe -m pytest -q      # run the test suite — 6 passed
./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8787
```

`tests/test_health.py` includes `test_reason_rejects_unredacted_field` —
this is the automated version of the canary-value privacy proof. Keep it
green; it's the cheapest possible regression check for the project's
core claim. `tests/test_llm_client.py` covers the Ollama response
parser, including its fallback path when the local model returns
malformed JSON.

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

`OLLAMA_MODEL` overrides the model name if you pull a different one.
`OllamaReasoningClient` fails safe: any network error or malformed JSON
from the model falls back to a `wait` action with `confidence: 0.0`
rather than ever forwarding something unvalidated to the extension.

**For the rest of the team:** leave `REASONING_BACKEND` unset. You don't
need Ollama installed to develop against a live `/reason` endpoint.
