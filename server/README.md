# server/

FastAPI backend — owned by **Role 4 (Server AI)**. Receives sanitized
context only, reasons over it, returns one structured action.

| File | What it does |
|---|---|
| `app/main.py` | App instance, CORS (scoped to the mock site's origin), `/health`. |
| `app/models/context.py` | `SanitizedContext` — `extra="forbid"` rejects any field the schema didn't expect. |
| `app/models/action.py` | `ActionResponse` — mirrors `shared/schemas/action.schema.json`. |
| `app/validators/context_validator.py` | Server-side half of the privacy firewall — catches a redacted-looking-but-not field before it reaches reasoning. |
| `app/llm/client.py` | `ReasoningClient` interface + `StubReasoningClient`. **Day 1 task:** pick a real cloud API and implement a second class here — nothing else in the server should need to change. |
| `app/routes/reason.py` | The one endpoint the extension calls: `POST /reason`. |

Day-by-day tasks: `../docs/planning/PS26171_Role4_Server.pdf`.

## Setup

```bash
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt  # macOS/Linux

./.venv/Scripts/python.exe -m pytest -q      # run the test suite
./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8787
```

`tests/test_health.py` includes `test_reason_rejects_unredacted_field` —
this is the automated version of the canary-value privacy proof. Keep it
green; it's the cheapest possible regression check for the project's core
claim.

## Wiring in a real model (Day 2&ndash;3)

Implement a second `ReasoningClient` subclass in `app/llm/client.py`
calling your chosen cloud API, then swap the instance created in
`app/routes/reason.py`. The route, validator, and models don't change.
