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
