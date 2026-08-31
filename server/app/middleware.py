import hashlib
import json
import logging
import time
from pathlib import Path

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger("privacy_proof")

LOG_PATH = Path(__file__).resolve().parent.parent / "logs" / "reason_requests.jsonl"

#: Endpoints that accept a sanitized context from the client, and so are
#: subject to both the size limit and the privacy audit trail.
#:
#: /complete was added alongside /reason deliberately. It receives the
#: SAME payload shape over the SAME trust boundary, so leaving it out
#: would have left an unaudited path to the model — and the canary proof
#: ("no raw PII reached the server") is only as strong as its coverage.
#: Bounding its body size matters for the same reason it does on
#: /reason: an unbounded body can be spent on parsing and a model call
#: before anything rejects it.
SANITIZED_CONTEXT_PATHS = ("/reason", "/complete")


class RequestSizeLimitMiddleware(BaseHTTPMiddleware):
    """Rejects an oversized /reason body before anything expensive runs —
    before it's logged, before Pydantic parses it, and long before a
    model call. Registered ahead of RequestInspectorMiddleware in
    main.py (Starlette runs middleware in the order added) so an
    oversized body never reaches that middleware's own
    `await request.body()`, which buffers the whole thing with no cap
    of its own.

    Checks Content-Length first, cheaply, before reading anything. The
    actual enforcement reads the body via `request.body()` — the same
    call RequestInspectorMiddleware makes — rather than iterating
    `request.stream()` directly: Starlette's BaseHTTPMiddleware replays
    the body to downstream middleware/the route ONLY from what
    `.body()` cached on the shared request object (see
    `starlette.middleware.base._CachedRequest.wrapped_receive`); reading
    via `.stream()` instead leaves that cache empty and every downstream
    handler sees a request with no body at all, regardless of what a
    hand-built `receive` closure is later passed to `call_next` — that
    closure is not what actually gets used. This was caught by the
    existing test suite failing across the board (every request, valid
    or not, started coming back "Field required" for the whole body)
    the first time this middleware was written against `.stream()`.

    A consequence of relying on `.body()`: this still fully buffers a
    request before rejecting it, same as RequestInspectorMiddleware
    already did with no limit at all. This closes the "spend a model
    call/parse time on an oversized payload" gap, not the separate
    "memory spent buffering a very large body" one — a reverse proxy or
    ASGI-server-level cap would be the fix for that, if it's ever
    needed.
    """

    def __init__(self, app, max_bytes: int) -> None:
        super().__init__(app)
        self.max_bytes = max_bytes

    async def dispatch(self, request: Request, call_next):
        if request.url.path in SANITIZED_CONTEXT_PATHS and request.method == "POST":
            declared = request.headers.get("content-length")
            if declared is not None:
                try:
                    if int(declared) > self.max_bytes:
                        return self._too_large()
                except ValueError:
                    pass  # unparseable header — the actual read below still applies

            body = await request.body()
            if len(body) > self.max_bytes:
                return self._too_large()

        return await call_next(request)

    def _too_large(self) -> JSONResponse:
        return JSONResponse(
            status_code=413,
            content={
                "error": "request_too_large",
                "detail": f"request body exceeds the {self.max_bytes}-byte limit",
                "task_id": None,
            },
        )


class RequestInspectorMiddleware(BaseHTTPMiddleware):
    """Server-side half of the "Strong Privacy Verification" pattern in
    docs/planning/PS26171_Research_Dossier.docx: records the SHA-256 of
    the exact payload received on /reason and /complete, plus response
    status and timing, so a canary test can prove — not just claim —
    that no raw PII arrived, without that proof requiring the audit log
    itself to hold the sensitive content it's vouching for.

    `log_full_body` controls whether the actual parsed request body is
    ALSO persisted, in addition to the hash/size/status/timing that are
    always recorded:

    - False (the default — see app/config.py's DEFAULT_LOG_FULL_REQUEST_BODY):
      only hash + size + status + timing are written. This is what
      "operational/canary auditing" needs — proving a payload's identity
      and how the server handled it — without ever persisting the
      payload's content. Safe for a hosted, multi-client deployment.
    - True: the full parsed body is ALSO written, exactly as this
      middleware originally always did. Intended ONLY for a controlled,
      synthetic-data privacy demonstration on a single developer's own
      machine — if redaction ever fails, this is where you want that
      failure visible, not hidden. Never enable this against real user
      data or a deployment anyone else can reach; see .env.example's
      warning on LOG_FULL_REQUEST_BODY.
    """

    def __init__(self, app, log_full_body: bool = False) -> None:
        super().__init__(app)
        self._log_full_body = log_full_body

    async def dispatch(self, request: Request, call_next):
        if request.url.path in SANITIZED_CONTEXT_PATHS and request.method == "POST":
            body = await request.body()
            digest = hashlib.sha256(body).hexdigest()

            async def receive():
                return {"type": "http.request", "body": body, "more_body": False}

            request = Request(request.scope, receive)

            started = time.perf_counter()
            response = await call_next(request)
            elapsed_ms = (time.perf_counter() - started) * 1000
            self._log(request.url.path, body, digest, response.status_code, elapsed_ms)
            return response

        return await call_next(request)

    def _log(self, path: str, body: bytes, digest: str, status_code: int, elapsed_ms: float) -> None:
        record: dict[str, object] = {
            "path": path,
            "sha256": digest,
            "body_size": len(body),
            "status_code": status_code,
            "elapsed_ms": round(elapsed_ms, 2),
        }

        if self._log_full_body:
            try:
                record["parsed_body"] = json.loads(body)
            except json.JSONDecodeError:
                record["parsed_body"] = None

        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

        # Hash, size, status, and timing only to stdout — the full body
        # (when log_full_body is on) already lives in the JSONL audit
        # file above; echoing a possibly-unredacted body to the console
        # a second time would just double the exposure of the thing
        # being audited.
        logger.info(
            "REQUEST path=%s sha256=%s bytes=%d status=%d ms=%.1f",
            path, digest, len(body), status_code, elapsed_ms,
        )
