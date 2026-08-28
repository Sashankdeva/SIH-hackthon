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


@dataclass(frozen=True)
class Settings:
    reasoning_backend: str
    ollama_model: str
    ollama_base_url: str
    ollama_timeout_s: float

    @property
    def uses_ollama(self) -> bool:
        return self.reasoning_backend == "ollama"


def load_settings() -> Settings:
    return Settings(
        reasoning_backend=os.getenv("REASONING_BACKEND", "stub").strip().lower(),
        ollama_model=os.getenv("OLLAMA_MODEL", DEFAULT_MODEL).strip(),
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", DEFAULT_OLLAMA_URL).strip().rstrip("/"),
        ollama_timeout_s=float(os.getenv("OLLAMA_TIMEOUT_S", DEFAULT_TIMEOUT_S)),
    )
