from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.reason import router as reason_router

app = FastAPI(title="PrivyVision Server", version="0.1.0")

# Scoped to the mock site's localhost origin for this sprint — widen
# deliberately, not by accident, when the real target site is known.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

app.include_router(reason_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
