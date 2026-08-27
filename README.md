# SIH26171 — Privacy-Preserving Browser Agent

ISRO, SIH 2026. A browser extension that perceives a page locally, redacts
sensitive fields before any network call, sends only sanitized context to
a server for reasoning, and executes the returned action locally.

Full background: `docs/planning/PS26171_Research_Dossier.docx`. Current
schedule: `docs/planning/PS26171_Sprint_Plan.pdf` (5-day sprint to 80%
functional, deadline 1 Sept 2026). Module map and scope decisions:
`docs/ARCHITECTURE.md`.

## Layout

```
extension/     Manifest V3 browser extension — perception, privacy, action, pvm submodules
server/        FastAPI backend — context validation + reasoning
shared/        Frozen JSON-schema contracts both sides mirror
mock-site/     Static test site (checkout form + canary PII page)
docs/          Architecture index
benchmarks/    Deferred past Sept 1 — see benchmarks/README.md
dashboard/     Deferred past Sept 1 — see dashboard/README.md
tests/         Cross-cutting integration tests (later)
```

Six roles, six folders, one owner each — see `docs/ARCHITECTURE.md`'s
"Where each role starts" table and the six
`docs/planning/PS26171_Role*.pdf` files for day-by-day tasks.

## Quick start

**Extension:**
```bash
cd extension
npm install
npm run build
```
Then `chrome://extensions` &rarr; Developer mode &rarr; Load unpacked &rarr; select `extension/`.

**Server:**
```bash
cd server
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
./.venv/Scripts/python.exe -m pytest -q                          # should show 3 passed
./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8787
```

**Mock site:**
```bash
python -m http.server 8000 --directory mock-site
```
Open `http://localhost:8000/index.html`.

All three are independent — any team member can run just their own piece.
Integration's Day-4 sync is where they get wired together for real.

## Status

- Extension: builds and typechecks clean (`npm run build`, `npm run typecheck`).
- Server: 3/3 tests passing, including the automated privacy-firewall check.
- Mock site: static, no build step.
- Everything past DOM-based perception/redaction (local vision model, PVM
  caching, benchmarks, dashboard) is deferred on purpose — see
  `docs/ARCHITECTURE.md`'s scope table before adding to those areas.
