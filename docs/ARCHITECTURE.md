# Architecture index

This repo implements the pipeline from
`docs/planning/PS26171_Research_Dossier.docx` and
`docs/planning/PS26171_Sprint_Plan.pdf`:

```
mock-site (test target)
    -> extension/src/perception   DOM/A11y capture
    -> extension/src/privacy      Tier-1 detect -> redact -> validate -> Privacy Firewall
    -> [sanitized payload, matches shared/schemas/sanitized-context.schema.json]
    -> server/app                 Context Validator -> ReasoningClient (local Ollama) -> ActionResponse
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

## Reasoning backend: local, not cloud

The privacy boundary is the redaction step, not "avoid the cloud" — a
sanitized payload contains no identifying content regardless of where it's
reasoned over (the official PS26171 text explicitly allows a cloud-hosted
model during SIH). This project's specific choice, though, is to run the
reasoning model **locally**, on Server AI's own GPU, via
`OllamaReasoningClient` (`server/app/llm/client.py`) — a deliberate step
further than the architecture requires, not a fix for a privacy gap that
existed. See `server/README.md` for setup.

Because that needs a real GPU, `/reason` **defaults to `StubReasoningClient`**
(`REASONING_BACKEND` unset) so the other five roles can develop against a
live endpoint with zero setup. Only Server AI's machine runs
`REASONING_BACKEND=ollama` day to day; anyone testing the *real* reasoning
path routes their client at that machine specifically.

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
| Local reasoning via Ollama (`OllamaReasoningClient`), stub default for the rest of the team | A hosted VLM (vision reasoning) — not needed while perception is DOM-only |
| Level-1 deterministic verification | Level-2 semantic, Level-3 visual verification |
| PVM storage shape (`pvm/memory.ts`) | Real predict/hit caching logic |
| Basic privacy inspector (`extension/popup.html`) | Full telemetry dashboard (`dashboard/`) |
| — | Full 5-metric benchmark suite (`benchmarks/`) |
| — | Firefox compatibility, multi-site testing |

Priority rule, carried over from the original architecture docs: don't
build anything in the right-hand column before the left-hand column works
reliably end to end on the mock site.

## Where each role starts

Day-by-day breakdown for all six roles is in
`docs/planning/PS26171_Sprint_Plan.pdf` (pages 3&ndash;8, one per role).
This table is just the folder map:

| Role | Folder(s) |
|---|---|
| 1 — Extension & Execution | `extension/src/background/`, `extension/src/content/`, `extension/src/action/` |
| 2 — Perception & Local Inference | `extension/src/perception/` |
| 3 — Privacy Guard & Redaction | `extension/src/privacy/`, `extension/src/popup/` |
| 4 — Server AI | `server/app/llm/`, `server/app/routes/` — hosts the local Ollama model on their own GPU |
| 5 — PVM & Verification | `extension/src/pvm/` |
| 6 — Integration, Benchmark & Demo | `mock-site/`, root-level wiring, `benchmarks/` (later), `dashboard/` (later) |

## Verified so far

- `extension/`: `npm run typecheck` and `npm run build` both pass — bundles are in `extension/dist/`.
- `server/`: `pytest` passes 6/6 — includes the server rejecting a payload with a raw (non-redacted) email field, plus the Ollama response parser's malformed-JSON and disallowed-action fallback paths.
- `shared/schemas/`: the two frozen contracts both the extension and server code mirror by hand — no codegen yet. If that drift becomes a problem, revisit generating the TS/Pydantic types from these JSON Schemas.
