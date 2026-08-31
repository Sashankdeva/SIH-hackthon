"""Typed failures for the reasoning pipeline.

Every one of these is a refusal to act. None of them produce an action.

The server used to answer HTTP 200 with a fabricated `wait` action
whenever anything went wrong — model down, malformed JSON, security
violation. That conflates "the model told me to do nothing" with "I
could not obtain a trustworthy answer", and it hands the extension a
synthetic action it never asked for. The extension's own confidence
floor happened to reject those, which is luck, not design. Failures are
now explicit and carry an HTTP status.
"""


class ReasoningError(Exception):
    """Base: the server cannot supply a trustworthy action."""

    status_code = 500
    #: Short machine-readable tag for logs and the client. Never contains
    #: page content, model output, or anything derived from user data.
    code = "reasoning_error"

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class ModelUnavailable(ReasoningError):
    """Ollama is not reachable, the model is missing, or it timed out.

    503 rather than 500: the request was fine, the dependency was not,
    and retrying later is reasonable.
    """

    status_code = 503
    code = "model_unavailable"


class ModelOutputInvalid(ReasoningError):
    """The model answered, but not with usable JSON.

    502: an upstream dependency returned something we cannot work with.
    Covers prose instead of JSON, truncated JSON, and valid JSON that
    isn't an object.
    """

    status_code = 502
    code = "model_output_invalid"


class ActionRejected(ReasoningError):
    """The model produced a well-formed action that failed validation.

    422: the model is working, but this specific proposal is not safe or
    not coherent with the supplied context (invented element, token
    misuse, off-origin navigation, and so on). This is the deterministic
    security layer refusing — never the prompt.
    """

    status_code = 422
    code = "action_rejected"


class ContextRejected(ReasoningError):
    """The incoming request parsed fine, but its content isn't sanitized.

    422, and deliberately a different `code` from ActionRejected even
    though the status matches: this is the CLIENT's payload failing the
    privacy check, before reasoning ever runs — a different failure than
    the MODEL's output failing validation after reasoning ran. Conflating
    the two would make refusal reasons ambiguous to a client trying to
    distinguish "fix your request" from "the model proposed something
    unsafe."
    """

    status_code = 422
    code = "context_rejected"


class InvalidRequest(ReasoningError):
    """The request body failed schema validation — missing/extra fields,
    wrong types, invalid enum values, malformed nested objects (elements,
    history), or JSON that didn't parse at all.

    422, matching FastAPI's own default status for these cases; this
    class only exists so the response body has the same
    {error, detail, task_id} shape as every other refusal, instead of
    FastAPI's default {"detail": [...]} envelope. Raised only from
    main.py's RequestValidationError handler — reasoning never runs for
    a request that didn't parse, so nothing here reaches propose_action.
    """

    status_code = 422
    code = "invalid_request"


class RequestTooLarge(ReasoningError):
    """The request body exceeded the configured size limit.

    413, checked before the body is even fully buffered — see
    app/middleware.py's RequestSizeLimitMiddleware. A malicious or
    malformed client should not be able to spend server memory or CPU
    (JSON parsing, prompt construction, a model call) proportional to an
    arbitrarily large payload.
    """

    status_code = 413
    code = "request_too_large"


class ContextTooLarge(ReasoningError):
    """SERVER PHASE S6.1: the rendered prompt hit (or came within a
    small margin of) the configured num_ctx budget.

    413 — the same "too much for us to safely handle" status as
    RequestTooLarge, but discovered at a different layer: that check
    catches an oversized WIRE payload before parsing; this one catches
    an oversized RENDERED PROMPT after building it, using Ollama's own
    reported prompt_eval_count. Both share the same failure philosophy
    from app/llm/client.py's num_ctx/num_predict comment: fail loudly
    rather than let Ollama silently truncate a context and hand back a
    confidently-wrong, schema-valid answer.
    """

    status_code = 413
    code = "context_too_large"


class InternalError(ReasoningError):
    """Something failed that none of the above anticipated.

    500, and deliberately generic: the detail shown to the client never
    includes the original exception message or a traceback — both are
    logged server-side only (see main.py's catch-all handler). An
    internal bug is not evidence about what the client should change.
    """

    status_code = 500
    code = "internal_error"
