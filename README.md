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
"Where each role starts" table and `docs/planning/PS26171_Sprint_Plan.pdf`
(one page per role) for day-by-day tasks.

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
./.venv/Scripts/python.exe -m pytest -q

# For Localhost Development:
./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8787

# For Cross-Laptop LAN Deployment (Laptop 2 hosting for Laptop 1):
./.venv/Scripts/python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8787
```
Runs against a stub reasoning backend by default — zero setup, no GPU
needed. Server AI runs the real thing locally via Ollama; see
`server/README.md`'s "Cross-Laptop / LAN Setup Guide" section.

**Mock site:**
```bash
python -m http.server 8000 --directory mock-site
```
Open `http://localhost:8000/index.html`.

All three are independent — any team member can run just their own piece.
Integration's Day-4 sync is where they get wired together for real.

## Status

- Extension: builds and typechecks clean (`npm run build`, `npm run typecheck`).
- Server: 18/18 tests passing — the privacy-firewall check, the
  required-task check, the local Ollama response parser's fallback
  paths, the `type_secret` field-binding checks, and the
  scroll/navigate parameter and same-origin guards.
- **The agent takes a task.** Type what you want done in the extension
  popup and press Run. Redaction still happens automatically on page
  load (privacy shouldn't wait to be asked), but reasoning and any
  action on the page only happen for a task you gave it. Verified live:
  the same page with three different tasks produced three different,
  correct actions — see `docs/ARCHITECTURE.md`, "Two triggers".
- **Local vision (face detection) is implemented and confirmed working
  in a real loaded Chrome extension** — not deferred, not just
  simulated. A 1.2MB ONNX model runs client-side (WebGPU with a
  verified WASM fallback), redacts faces directly on the page, and
  reports through the same privacy inspector as text-field redaction.
  This is PS26171's highest-weighted requirement (25%); see
  `docs/ARCHITECTURE.md`'s "Local vision processing" section — it runs
  as a second, main-world content script (a real Chrome
  isolated/main-world bug had to be found and fixed to get here, not
  just an ONNX quirk).
- Mock site: static, no build step. `vision-test.html` is a dedicated
  stress test (a ~48-face group photo); the main checkout page also
  carries a profile photo so the golden-path demo exercises both
  detection surfaces.
- Reasoning runs locally (Ollama, on Server AI's GPU), not via a cloud
  API — see `docs/ARCHITECTURE.md`'s "Reasoning backend" note for why
  that's a deliberate choice, not a privacy requirement.
- Still deferred on purpose: PVM caching, the full benchmark suite,
  dashboard, Firefox — see `docs/ARCHITECTURE.md`'s scope table.
