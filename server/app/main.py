import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.auth import ApiKeyAuthMiddleware
from app.config import Settings, load_settings
from app.middleware import RequestInspectorMiddleware, RequestSizeLimitMiddleware
from app.routes import complete as complete_route
from app.routes import reason as reason_route
from app.routes.complete import router as complete_router
from app.routes.reason import router as reason_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Owns ONE httpx.AsyncClient for the whole process, created and torn
    down on the SAME event loop that serves every request — this is the
    fix for the connection-overhead measurement (a new AsyncClient per
    /reason or /complete call cost ~436ms) without repeating the earlier
    naive attempt (a client built at module-import time, before any
    event loop exists, which raised "RuntimeError: Event loop is closed"
    the moment it outlived the loop it was implicitly bound to).

    A FastAPI `lifespan` runs its startup half INSIDE the loop uvicorn
    already started before the first request, and its shutdown half
    before that loop stops — so the client's lifetime is exactly the
    loop's lifetime, never longer. Installed into the existing
    _client/_probe singletons (built once at router-import time, see
    app/routes/reason.py and app/routes/complete.py) via
    set_http_client(), rather than replacing how they're constructed.

    set_http_client(None) on shutdown is not ceremony: without it, the
    singletons would keep a reference to a now-CLOSED client, and the
    next call would fail against it instead of safely falling back to
    OllamaReasoningClient/CompletionProbe's original per-call behavior.
    """
    http_client = httpx.AsyncClient()
    app.state.http_client = http_client
    reason_route._client.set_http_client(http_client)
    complete_route._probe.set_http_client(http_client)
    try:
        yield
    finally:
        reason_route._client.set_http_client(None)
        complete_route._probe.set_http_client(None)
        await http_client.aclose()


def _task_id_from_body(body: object) -> str | None:
    """Best-effort task_id extraction from a request that failed to
    parse — so a client can still tie a rejection to the task it asked
    about, matching every other error response's shape, even though
    reasoning never validated (or ran) for this request.
    """
    if isinstance(body, dict):
        value = body.get("task_id")
        if isinstance(value, str):
            return value
    return None


def create_app(settings: Settings) -> FastAPI:
    """Builds one, fully-configured FastAPI app from a Settings instance.

    Extracted into a factory (rather than building `app` once at module
    scope from a module-level `_settings`) specifically so tests can
    construct an app with DIFFERENT settings — a custom API_KEY, a
    different ALLOWED_ORIGINS list, LOG_FULL_REQUEST_BODY toggled — as an
    independent instance, without monkeypatching Starlette's internal
    middleware stack (which isn't meant to be mutated after construction)
    or relying on environment variables set before this module was first
    imported (which wouldn't work: Python caches the import, and several
    other test files already import `app.main` first). The module-level
    `app` below is just `create_app(load_settings())` — production
    behavior is unchanged by this refactor.
    """
    # Startup visibility into security-relevant configuration —
    # deliberately reports only WHETHER each control is on, never a
    # secret value (the API key itself never appears in a log line
    # anywhere in this codebase).
    logger.info(
        "security_config auth_enabled=%s log_full_request_body=%s allowed_origins=%s",
        settings.auth_enabled,
        settings.log_full_request_body,
        ",".join(settings.allowed_origins),
    )
    if settings.log_full_request_body:
        logger.warning(
            "LOG_FULL_REQUEST_BODY is enabled — every /reason and /complete request body "
            "will be persisted in full to %s. Use synthetic data only.",
            "server/logs/reason_requests.jsonl",
        )
    # SERVER PHASE S7 — the loopback-only default (app/config.py's
    # DEFAULT_HOST) is safe with auth disabled, but nothing previously
    # signalled the one combination that genuinely matters: HOST opened
    # to a LAN/Radmin-reachable interface WHILE API_KEY is still unset.
    # That combination lets any client that can reach the interface call
    # /reason and /complete with no authentication at all — exactly the
    # case docs/DEPLOYMENT.md already tells an operator to set API_KEY
    # for, but the server itself said nothing if they forgot. A WARNING,
    # not a refusal: a deliberate, single-trusted-network demo without
    # auth is still a legitimate operator choice, just one this should
    # not make silently.
    if settings.host not in ("127.0.0.1", "localhost") and not settings.auth_enabled:
        logger.warning(
            "SECURITY: HOST=%s is not loopback-only, but API_KEY is unset — /reason and "
            "/complete will accept requests from anyone who can reach this interface with "
            "no authentication. Set API_KEY (see .env.example) for any deployment reachable "
            "by a machine you don't personally control.",
            settings.host,
        )

    app = FastAPI(title="PrivyVision Server", version="0.1.0", lifespan=lifespan)

    # MIDDLEWARE ORDER — read this before reordering anything here.
    #
    # Starlette's add_middleware builds an onion: the LAST middleware
    # added is the OUTERMOST layer, so it sees every request first and
    # every response (including one returned early by an inner layer)
    # last. Verified directly (this is the opposite of what an earlier
    # version of this file's comments claimed): a probe request built to
    # trip RequestSizeLimitMiddleware's 413 showed the response missing
    # its Access-Control-Allow-Origin header entirely, because
    # CORSMiddleware was registered BEFORE (i.e. INSIDE) it — the 413
    # short-circuited before ever reaching CORS's outer wrap. In a real
    # browser, that 413 would have been an opaque, unreadable "network
    # error" instead of a response the extension's fetch() could parse.
    #
    # Registered here in the REVERSE of their intended execution order so
    # the actual request-time sequence is:
    #   CORS -> auth -> size limit -> request inspector -> route
    # and the response-time sequence (unwinding) is the exact mirror, so
    # EVERY response — success or an early rejection from any layer —
    # passes back out through CORS and gets a correct header.
    app.add_middleware(RequestInspectorMiddleware, log_full_body=settings.log_full_request_body)

    # Runs before RequestInspectorMiddleware: an oversized body is
    # rejected here and never reaches that middleware's own body
    # buffering/logging.
    app.add_middleware(RequestSizeLimitMiddleware, max_bytes=settings.max_request_body_bytes)

    # Runs before size-limit and the inspector: an unauthorized request
    # is rejected before its body is ever read, size-checked, or logged.
    # See app/auth.py. A no-op pass-through when API_KEY is unset.
    app.add_middleware(ApiKeyAuthMiddleware, api_key=settings.api_key)

    # Outermost of all: every response, including a 401/413 from the
    # layers above, unwinds through here and gets correct CORS headers.
    #
    # CORS PROTECTS: which BROWSER-based origins may READ this server's
    # responses via fetch()/XHR from a web page. It is enforced by the
    # BROWSER, not this server — the server still processes and answers
    # every request regardless of Origin; a disallowed origin simply
    # doesn't get the Access-Control-Allow-Origin header, so the
    # browser's own fetch() throws instead of returning a response.
    # CORS DOES NOT PROTECT: against any non-browser client (curl, a
    # Python script, another server) — none of them consult or enforce
    # CORS headers at all. It is not authentication and must never be
    # treated as one; see app/auth.py's API_KEY for the actual access
    # control. It also does not protect Ollama — Ollama has no HTTP
    # layer of its own reachable here; it stays bound to localhost only
    # (see app/config.py's OLLAMA_BASE_URL comment).
    # EXTENSION HOST_PERMISSIONS: a SEPARATE, Chrome-specific mechanism
    # from CORS. A Manifest V3 content script's fetch() is additionally
    # gated by its own extension's `host_permissions` — Chrome refuses
    # the fetch at the extension-permission level if the target origin
    # isn't listed there, before CORS is even consulted. Both must allow
    # a request: host_permissions decides whether the extension may
    # attempt the fetch at all; CORS then decides whether the browser
    # will let the extension's JS read the response.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_methods=["POST", "GET"],
        allow_headers=["*"],
    )

    app.include_router(reason_router)
    app.include_router(complete_router)

    @app.exception_handler(RequestValidationError)
    async def invalid_request_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        """Normalizes FastAPI's default {"detail": [...]} validation-error
        shape to the same {error, detail, task_id} envelope every other
        /reason failure uses. Covers: malformed JSON, missing required
        fields, wrong types, invalid enum values (e.g. a history entry's
        outcome), and malformed nested objects (elements, history) —
        every case is a request that never reached reasoning at all.

        The individual field messages (`exc.errors()`) describe the
        client's OWN submitted shape, not this server's internals — safe
        to return, unlike a traceback.
        """
        detail = "; ".join(
            f"{'.'.join(str(p) for p in e['loc'] if p != 'body')}: {e['msg']}" for e in exc.errors()
        )
        return JSONResponse(
            status_code=422,
            content={
                "error": "invalid_request",
                "detail": detail or "request body failed validation",
                "task_id": _task_id_from_body(exc.body),
            },
        )

    @app.exception_handler(Exception)
    async def internal_error_handler(request: Request, exc: Exception) -> JSONResponse:
        """Catch-all for anything the typed error hierarchy didn't
        anticipate. The full exception is logged server-side only —
        `logger.exception` includes the traceback in the log record,
        never in the response — so a bug here can be diagnosed without
        ever exposing implementation details (traceback, file paths,
        environment values) to a client.
        """
        logger.exception("unhandled_exception path=%s", request.url.path)
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "detail": "internal server error", "task_id": None},
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


_settings = load_settings()
app = create_app(_settings)


if __name__ == "__main__":
    # `python -m app.main` — binds to HOST/PORT from the environment
    # (see app/config.py), so a LAN-facing run doesn't require anyone to
    # remember uvicorn CLI flags. `uvicorn app.main:app --reload` (see
    # README) is still the right choice for local dev with hot reload;
    # --reload requires uvicorn's own process supervision and doesn't
    # apply here.
    import uvicorn

    uvicorn.run(app, host=_settings.host, port=_settings.port)
