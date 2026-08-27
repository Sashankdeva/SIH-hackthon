# Architecture index

This repo implements the pipeline from
`docs/planning/PS26171_Research_Dossier.docx` and
`docs/planning/PS26171_Sprint_Plan.pdf`:

```
mock-site (test target)
    -> extension/src/perception   DOM/A11y capture
    -> extension/src/privacy      Tier-1 detect -> redact -> validate -> Privacy Firewall
    -> [sanitized payload, matches shared/schemas/sanitized-context.schema.json]
    -> server/app                 Context Validator -> ReasoningClient -> ActionResponse
    -> [structured action, matches shared/schemas/action.schema.json]
    -> extension/src/action       validate -> execute
    -> extension/src/pvm          verify (Level 1) -> recovery loop
```

No raw PII crosses the line between `extension/src/privacy` and
`server/`. That line is enforced twice — once client-side
(`sanitizedContext.ts` refuses to emit anything with incomplete redaction
coverage) and once server-side (`context_validator.py` rejects anything
that doesn't look like a redaction token). Two independent checks on the
same invariant, not one.

## Why modules live where they do

The original planning docs sketch `perception/`, `privacy-guard/`, and
`pvm/` as top-level folders. In this scaffold they're submodules inside
`extension/src/` instead, because all three compile into the same
browser-extension bundle and share the same message bus
(`extension/src/messaging/bus.ts`) — splitting them into separate npm
packages would add build complexity with no benefit for a 5-day sprint.
Each still has its own folder, README ownership line, and only one role
touches it, which is what "modular" actually needs to mean here.

## Scope this sprint vs. deferred (see `docs/planning/PS26171_Sprint_Plan.pdf`, §1)

| In this scaffold now | Deferred past 1 Sept 2026 |
|---|---|
| DOM/A11y perception (`perception/domCapture.ts`) | Local vision model — ONNX Runtime Web + WebGPU/WASM/CPU fallback |
| Tier-1 DOM-rule PII detection | Tier-2 text-NER, Tier-3 visual/face detection |
| Deterministic redaction + coverage validator | AI-assisted or semantic-obfuscation redaction |
| Cloud LLM/VLM via `ReasoningClient` interface | Self-hosted open-weight model |
| Level-1 deterministic verification | Level-2 semantic, Level-3 visual verification |
| PVM storage shape (`pvm/memory.ts`) | Real predict/hit caching logic |
| Basic privacy inspector (`extension/popup.html`) | Full telemetry dashboard (`dashboard/`) |
| — | Full 5-metric benchmark suite (`benchmarks/`) |
| — | Firefox compatibility, multi-site testing |

Priority rule, carried over from the original architecture docs: don't
build anything in the right-hand column before the left-hand column works
reliably end to end on the mock site.

## Where each role starts

See the per-role PDFs for the day-by-day breakdown — this table is just
the folder map:

| Role | PDF (in `docs/planning/`) | Folder(s) |
|---|---|---|
| 1 — Extension & Execution | `PS26171_Role1_Extension.pdf` | `extension/src/background/`, `extension/src/content/`, `extension/src/action/` |
| 2 — Perception & Local Inference | `PS26171_Role2_Perception.pdf` | `extension/src/perception/` |
| 3 — Privacy Guard & Redaction | `PS26171_Role3_Privacy.pdf` | `extension/src/privacy/`, `extension/src/popup/` |
| 4 — Server AI | `PS26171_Role4_Server.pdf` | `server/app/llm/`, `server/app/routes/` |
| 5 — PVM & Verification | `PS26171_Role5_Pvm.pdf` | `extension/src/pvm/` |
| 6 — Integration, Benchmark & Demo | `PS26171_Role6_Integration.pdf` | `mock-site/`, root-level wiring, `benchmarks/` (later), `dashboard/` (later) |

## Verified so far

- `extension/`: `npm run typecheck` and `npm run build` both pass — bundles are in `extension/dist/`.
- `server/`: `pytest` passes 3/3, including a test that the server rejects a payload with a raw (non-redacted) email field.
- `shared/schemas/`: the two frozen contracts both the extension and server code mirror by hand — no codegen yet. If that drift becomes a problem, revisit generating the TS/Pydantic types from these JSON Schemas.
