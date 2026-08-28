import hashlib
import json
import logging
from pathlib import Path

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

logger = logging.getLogger("privacy_proof")

LOG_PATH = Path(__file__).resolve().parent.parent / "logs" / "reason_requests.jsonl"


class RequestInspectorMiddleware(BaseHTTPMiddleware):
    """Server-side half of the "Strong Privacy Verification" pattern in
    docs/planning/PS26171_Research_Dossier.docx: records the exact
    payload received on /reason and its SHA-256 hash, so a canary test
    can prove — not just claim — that no raw PII arrived.

    Logs the FULL received body, on purpose: if redaction ever fails,
    this is exactly where you want that failure to be visible, not
    hidden. Never point this at a real deployment without redacting the
    log itself first.
    """

    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/reason" and request.method == "POST":
            body = await request.body()
            digest = hashlib.sha256(body).hexdigest()
            self._log(request, body, digest)

            async def receive():
                return {"type": "http.request", "body": body, "more_body": False}

            request = Request(request.scope, receive)

        return await call_next(request)

    def _log(self, request: Request, body: bytes, digest: str) -> None:
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = None

        record = {
            "path": request.url.path,
            "sha256": digest,
            "body_size": len(body),
            "parsed_body": parsed,
        }

        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

        # Hash and size only to stdout — the full body already lives in
        # the JSONL audit file that scripts/canary_check.py reads, and
        # echoing a possibly-unredacted body to the console a second
        # time just doubles the exposure of the thing being audited.
        logger.info("REASON_REQUEST sha256=%s bytes=%d", digest, len(body))
