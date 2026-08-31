"""Server configuration, read once from the environment.

Everything machine-specific lives here and nowhere else — no absolute
paths, no hostnames baked into call sites. Defaults are chosen so a
teammate can clone the repo and run the server with zero setup (the
stub backend); Server AI overrides REASONING_BACKEND locally.
"""

import os
from dataclasses import dataclass

DEFAULT_MODEL = "qwen2.5:7b-instruct"
DEFAULT_OLLAMA_URL = "http://localhost:11434"

# Generous because a cold Ollama has to page the model into VRAM before
# it emits a token — measured ~30s cold, ~2-5s warm on this project's
# hardware. Too short a timeout turns a normal first request into a
# spurious "model unavailable".
DEFAULT_TIMEOUT_S = 60.0

# SERVER PHASE S6.1 — fixes a measured production bug (S6's audit):
# Ollama, when neither of these is set, loads this model at a 4096-token
# RUNTIME context (confirmed via /api/ps) despite the model's true
# 32768-token capacity (/api/show) — and the actual usable PROMPT budget
# measured out to exactly 2050 tokens regardless of num_predict, not
# simply "4096 minus a reservation". Any page above ~100-150 interactive
# elements (a realistic count, not a stress-test number) silently
# exceeded that, and Ollama truncated the prompt rather than erroring —
# dropping the correct target element and/or the entire rules/safety
# section, while the model still returned a confidently wrong,
# schema-valid, validator-accepted action. Measured precisely: correct
# through 100 elements (3314 real prompt tokens), broken at 150 (2050 —
# the plateau).
#
# DEFAULT_OLLAMA_NUM_CTX = 16384. Chosen from directly measured VRAM
# cost on this project's actual hardware (RTX 5070 Laptop, 8151 MiB
# total), not guessed:
#     num_ctx=4096  -> 4528 MiB   (today's implicit default)
#     num_ctx=8192  -> 4756 MiB   (+228 MiB)
#     num_ctx=16384 -> 5212 MiB   (+684 MiB from default)
#     num_ctx=32768 -> 5959 MiB   (+1431 MiB) — measured to leave only
#                                   ~356 MiB of the 8151 MiB total free
#                                   on this machine's actual concurrent
#                                   load (desktop compositor, browser
#                                   GPU acceleration, etc.), too tight
#                                   for a safe default.
# 16384 gives a generous ~4x increase over the broken default for a
# modest, measured +684 MiB, and was directly re-verified against the
# exact sizes that were broken: 150/250/300/500 elements all now render
# their FULL, untruncated prompt (4414/6614/7714/12114 real tokens
# respectively — all well inside 16384) and pick the correct target.
# 1000 elements (explicitly a stress-test size, not a realistic one) can
# still exceed this — see ContextTooLarge in app/llm/errors.py, which
# fails loudly rather than letting that happen silently.
DEFAULT_OLLAMA_NUM_CTX = 16384

# DEFAULT_OLLAMA_NUM_PREDICT = 200. The action/completion grammar output
# is tiny — measured 41-58 tokens across every case in this project's
# benchmarks — so 200 is already a ~3.5x margin, not a guess. Shared by
# /reason and /complete rather than configured separately: both outputs
# are equally tiny, and splitting this into two settings would be
# configuration surface this project's own settings module doesn't
# otherwise need. At num_ctx=16384 the 200-token reservation costs
# ~1.2% of the window, all headroom.
DEFAULT_OLLAMA_NUM_PREDICT = 200

# 127.0.0.1 by default — loopback-only, matching every prior run
# command in this repo. Set HOST=0.0.0.0 (or a specific LAN interface
# address) only when another laptop needs to reach this server; see
# server/README.md, "Running on the LAN."
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787

# 64 KiB. Real payloads observed in production logging are 120-1100
# bytes (task + a handful of elements); this leaves generous headroom
# for a page with many elements or a long step history while still
# bounding memory/CPU spent on a single request before it ever reaches
# the model. See app/middleware.py's RequestSizeLimitMiddleware — this
# is checked before the body is fully buffered, not after.
DEFAULT_MAX_REQUEST_BODY_BYTES = 65_536

# Unset by default: authentication is OPT-IN, not opt-out. A teammate
# cloning this repo for local development against the stub backend gets
# zero setup, exactly like every other default here — see
# app/auth.py for the enable/disable behavior this drives.
DEFAULT_API_KEY = ""

# Full-body audit logging defaults OFF. The original canary-verification
# design (app/middleware.py's RequestInspectorMiddleware) logged every
# request's full parsed body unconditionally — the right call for a
# single-developer machine proving redaction to itself, the wrong
# default for anything a second machine can reach. Hash + size + status
# + timing are retained unconditionally (see middleware.py) — that is
# what "operational/canary auditing" needs without ever persisting
# content. Set to true only for a deliberate, synthetic-data-only
# privacy demonstration; see .env.example for the warning.
DEFAULT_LOG_FULL_REQUEST_BODY = False

# Preserves this project's ORIGINAL hardcoded CORS scope exactly — the
# mock site's own localhost origin — as the default so making this
# configurable changes nothing for anyone who doesn't set ALLOWED_ORIGINS.
DEFAULT_ALLOWED_ORIGINS = "http://localhost:8000,http://127.0.0.1:8000"


@dataclass(frozen=True)
class Settings:
    reasoning_backend: str
    ollama_model: str
    ollama_base_url: str
    ollama_timeout_s: float
    ollama_num_ctx: int
    ollama_num_predict: int
    host: str
    port: int
    max_request_body_bytes: int
    api_key: str
    log_full_request_body: bool
    allowed_origins: tuple[str, ...]

    @property
    def uses_ollama(self) -> bool:
        return self.reasoning_backend == "ollama"

    @property
    def auth_enabled(self) -> bool:
        return self.api_key != ""


def _parse_bool(raw: str, default: bool) -> bool:
    normalized = raw.strip().lower()
    if normalized == "":
        return default
    return normalized in ("1", "true", "yes", "on")


def _parse_origins(raw: str) -> tuple[str, ...]:
    return tuple(origin.strip() for origin in raw.split(",") if origin.strip())


def load_settings() -> Settings:
    return Settings(
        reasoning_backend=os.getenv("REASONING_BACKEND", "stub").strip().lower(),
        ollama_model=os.getenv("OLLAMA_MODEL", DEFAULT_MODEL).strip(),
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", DEFAULT_OLLAMA_URL).strip().rstrip("/"),
        ollama_timeout_s=float(os.getenv("OLLAMA_TIMEOUT_S", DEFAULT_TIMEOUT_S)),
        ollama_num_ctx=int(os.getenv("OLLAMA_NUM_CTX", DEFAULT_OLLAMA_NUM_CTX)),
        ollama_num_predict=int(os.getenv("OLLAMA_NUM_PREDICT", DEFAULT_OLLAMA_NUM_PREDICT)),
        host=os.getenv("HOST", DEFAULT_HOST).strip(),
        port=int(os.getenv("PORT", DEFAULT_PORT)),
        max_request_body_bytes=int(os.getenv("MAX_REQUEST_BODY_BYTES", DEFAULT_MAX_REQUEST_BODY_BYTES)),
        # .strip() only — never .lower(): an API key is a secret token,
        # not a case-insensitive identifier like the other settings here.
        api_key=os.getenv("API_KEY", DEFAULT_API_KEY).strip(),
        log_full_request_body=_parse_bool(
            os.getenv("LOG_FULL_REQUEST_BODY", ""), DEFAULT_LOG_FULL_REQUEST_BODY
        ),
        allowed_origins=_parse_origins(os.getenv("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS)),
    )
