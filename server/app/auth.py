"""Optional API-key authentication for the sanitized-context endpoints.

Deliberately separate from app/llm/ — authentication is a transport/access
concern, not a reasoning concern. It runs as ASGI middleware, entirely
outside `propose_action`/`judge`, so nothing about the reasoning pipeline
needs to know whether auth is enabled, what the key is, or how it was
checked. See app/middleware.py's RequestSizeLimitMiddleware for the same
separation applied to request-size enforcement.

DESIGN
------
- API_KEY unset/empty (Settings.auth_enabled is False) -> every request
  passes through unauthenticated. This is the default: a teammate running
  the stub backend locally gets zero setup, exactly like every other
  default in app/config.py.
- API_KEY set -> every request to a sanitized-context endpoint
  (SANITIZED_CONTEXT_PATHS — the same boundary RequestSizeLimitMiddleware
  and RequestInspectorMiddleware already use) must carry a matching
  `X-API-Key` header. Missing and wrong both produce the SAME 401 —
  distinguishing them in the response would tell a caller which failure
  mode they hit, information they have no legitimate need for.
- /health is never gated. It reveals nothing beyond "the process is up",
  matching the phase's own explicit allowance ("health endpoint may
  remain unauthenticated unless there is a strong reason otherwise") —
  there isn't one here, and gating it would break the simplest possible
  liveness check for no security benefit.

SECURITY NOTES
--------------
- Comparison uses `secrets.compare_digest`, not `==`. A `==` comparison
  on strings short-circuits at the first mismatched character, so its
  timing leaks how many leading characters were correct — a real,
  practical channel for guessing a key one byte at a time.
  compare_digest runs in time dependent only on the length of its
  inputs, not their content.
- The key is NEVER written to a log line, an exception message, or a
  response body anywhere in this module. Startup logging (main.py)
  reports only *whether* auth is enabled, never the key's value.
- Runs BEFORE RequestSizeLimitMiddleware and RequestInspectorMiddleware
  in main.py's middleware stack, so an unauthorized request is rejected
  before its body is ever read, size-checked, or logged — an attacker
  without a valid key cannot spend server effort (or fill an audit log)
  by sending arbitrarily large or numerous bodies.
"""

import secrets

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.middleware import SANITIZED_CONTEXT_PATHS

API_KEY_HEADER = "X-API-Key"


class ApiKeyAuthMiddleware(BaseHTTPMiddleware):
    """Gates SANITIZED_CONTEXT_PATHS behind a shared API key when one is
    configured. See module docstring for the full design and the reasons
    behind each choice.
    """

    def __init__(self, app, api_key: str) -> None:
        super().__init__(app)
        self._api_key = api_key

    async def dispatch(self, request: Request, call_next):
        if not self._api_key:
            return await call_next(request)  # auth disabled

        if request.url.path in SANITIZED_CONTEXT_PATHS and request.method == "POST":
            provided = request.headers.get(API_KEY_HEADER, "")
            if not provided or not secrets.compare_digest(provided, self._api_key):
                return self._unauthorized()

        return await call_next(request)

    @staticmethod
    def _unauthorized() -> JSONResponse:
        return JSONResponse(
            status_code=401,
            content={
                "error": "unauthorized",
                "detail": f"missing or invalid {API_KEY_HEADER} header",
                "task_id": None,
            },
        )
