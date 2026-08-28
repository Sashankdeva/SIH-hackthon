# Architecture index

This repo implements the pipeline from
`docs/planning/PS26171_Research_Dossier.docx` and
`docs/planning/PS26171_Sprint_Plan.pdf`:

```
mock-site (test target)
    -> extension/src/vision-main   [MAIN world]  local vision (ONNX face detection + overlay)
           ^ event bridge only (CustomEvent) v         chrome.runtime.getURL() computed here
    -> extension/src/content       [ISOLATED world, the default] DOM/A11y capture
    -> extension/src/privacy       Tier-1 detect -> redact -> validate -> Privacy Firewall
    -> [sanitized payload, matches shared/schemas/sanitized-context.schema.json]
    -> server/app                  Context Validator -> ReasoningClient (local Ollama) -> ActionResponse
    -> [structured action, matches shared/schemas/action.schema.json]
    -> extension/src/action        validate -> execute
    -> extension/src/pvm           verify (Level 1) -> recovery loop
```

## Two triggers, deliberately separated

**Page load** runs perception + detection + redaction, always, with no
network call: faces blacked out, sensitive fields tokenised. Privacy
protection must not wait for the user to ask for it.

**A user-submitted task** (typed in the popup) is what triggers
reasoning and action. The agent never acts on a goal nobody gave it —
before this split it ran the whole pipeline on every page load and
picked whatever looked clickable, which is not "assisting with a task",
it's just reacting. `task` is now a required field on the sanitized
context schema, so a payload without one is a schema violation the
server rejects (`test_reason_requires_a_task`), and the task text is
the first thing in the model's prompt.

Verified live against the local Ollama model: the same page state with
three different tasks produced three different, correct actions —
"log in with my password" → `type_secret` on the password field,
"place the order" → `click` the Place Order button, "go back to the
home page" → `click` the Back link. The task genuinely drives the
decision; it isn't decoration.

Two content scripts run in two different JS worlds (see "Local vision
processing" below for why) — everything else is the single default
isolated world. The vision branch is local-only: face detections never
enter the sanitized payload (images were never part of that schema) —
they're redacted directly on the page and reported through the same
`PrivacyReport` the popup already displays.

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
| DOM/A11y perception (`perception/domCapture.ts`) | Firefox/other-browser vision path (untested there) |
| **Local vision model — ONNX Runtime Web, WebGPU with WASM fallback (`perception/faceDetector.ts`)** | Detecting anything other than faces (text-in-image OCR, objects) |
| Tier-1 DOM-rule PII detection + visual face detection | Tier-2 text-NER |
| Deterministic redaction + coverage validator, both DOM and visual | AI-assisted or semantic-obfuscation redaction |
| Local reasoning via Ollama (`OllamaReasoningClient`), stub default for the rest of the team | A hosted VLM reasoning over *visual* context — the vision model's output stays local; the server still only ever sees DOM-derived text |
| Level-1 deterministic verification | Level-2 semantic, Level-3 visual verification |
| PVM storage shape (`pvm/memory.ts`) | Real predict/hit caching logic |
| Basic privacy inspector (`extension/popup.html`) | Full telemetry dashboard (`dashboard/`) |
| — | Full 5-metric benchmark suite (`benchmarks/`) |
| — | Firefox compatibility, multi-site testing |

**Local vision was originally deferred for this sprint, then pulled
forward** — it's the component PS26171 names first and weights highest
(25% of the rubric, "accuracy of visual context from screen"). Shipping
zero visual perception was a bigger risk than the schedule pressure of
building a minimal, real version: face detection via a 1.2MB ONNX model
(Ultra-Light-Fast-Generic-Face-Detector-1MB, MIT licensed), run entirely
client-side. See "Local vision processing" below for what was actually
verified.

Priority rule, carried over from the original architecture docs: don't
build anything in the right-hand column before the left-hand column works
reliably end to end on the mock site.

## Local vision processing

Two content scripts, in two different worlds, talking only through DOM
`CustomEvent`s:

```
extension/src/content/index.ts        (ISOLATED world, the default)
    -> computes chrome.runtime.getURL() paths for ort/model/wasm
    -> dispatches document "privyvision:init-vision" {ort, model, wasmBase}
    -> listens for "privyvision:vision-result" (per image: faceCount)
       and "privyvision:vision-done", folds counts into PrivacyReport

extension/src/vision-main/index.ts     (MAIN world — manifest.json
                                         content_scripts[0], "world":"MAIN")
    -> listens for "privyvision:init-vision"
    -> perception/faceDetector.ts: loads ort.all.min.js, runs detection
    -> privacy/visualRedact.ts: draws the black-box overlay directly
    -> dispatches "privyvision:vision-result" per image, then "...-done"
```

Detections fold into the same `PrivacyReport` as DOM-field redactions
(category `"face"`, source `"visual"`) — one report, one popup, two
detection surfaces. Only face *counts* cross back to the isolated
world — never a DOM reference or the image itself; the isolated world
doesn't need either, since redaction already happened in the main world.

**Why two worlds, and why this took several attempts to get right** —
all found by testing live, none of it visible from reading the code
first:

1. Original design ran detection directly in the default (isolated)
   content script, loading `ort.all.min.js` via an injected `<script>`
   tag. That tag executes in the page's **main world** — an isolated
   world shares the DOM with the page but not arbitrary JS globals.
   `ort.all.min.js` does `var ort = ...` at its top level; the resulting
   global landed in the main world and was invisible to the isolated
   world trying to use it. First real-Chrome load: `ReferenceError: ort
   is not defined`. My own test tooling could not reproduce this at
   all — it doesn't model genuine isolated/main world separation — so
   several attempted fixes (indirect `eval`, `new Function()` with an
   explicit return) were each verified working in that tooling and then
   failed differently in real Chrome, because they were solving for a
   constraint the tooling didn't actually have.
2. `new Function(source)` avoids the ambient-global problem via an
   explicit `return`, but ONNX Runtime Web's own dynamic `import()`
   calls inside that source then fail to resolve
   (`Failed to fetch dynamically imported module`) — empirically, only
   a *directly, unwrapped* `<script>` tag or top-level eval keeps those
   imports working; any added function boundary breaks them.
3. The actual fix is Chrome's own documented mechanism for exactly this
   situation: declare a **second content script in the main world**
   (`manifest.json`, `"world": "MAIN"`), so a plain `<script>` tag
   loads `ort` into the same world that script runs in — no eval
   tricks needed anywhere. The isolated world keeps the one thing the
   main world can't have (`chrome.runtime.getURL`) and hands over just
   the resulting URLs.
4. `ort.env.wasm.numThreads` must be set to `1`. The default threaded
   WASM build needs cross-origin isolation (`SharedArrayBuffer`), which
   a plain page doesn't have. Without this, WASM session creation fails
   outright — this would have blocked the WASM fallback path too, not
   just WebGPU.
5. WebGPU session **creation** can succeed while the first real
   **inference** still throws (`[Mul] failed... dims [1,4420,2]`,
   observed live) — a try/catch around `InferenceSession.create()`
   alone does not catch this. `getSession()` runs a dummy warm-up
   inference before committing to a session.
6. WebGPU and WASM execution providers share one underlying WASM
   runtime *within a single loaded `ort` instance* — if WebGPU fails at
   the WASM-init step, a same-instance WASM fallback then fails too
   (`previous call to initWasm() failed`), even though it's a different
   provider. `loadOrtFresh()` re-injects the `<script>` tag for the
   fallback attempt rather than reusing the failed instance.
7. (Not ONNX-related) The redaction overlay's positioning math had a
   coordinate-frame bug: reading `img.offsetLeft`/`offsetTop` *before*
   forcing a static parent to `position: relative` reads them in the
   wrong frame, since that mutation changes what they mean. Caught by
   checking rendered box positions were within the image's bounds, not
   by reading the code — first attempt put boxes ~400px off target.

**Verified**: cross-checked against an independent Python implementation
(`onnxruntime` + PIL) of the same model on the same real test image at
the original 0.7 threshold — 44 faces in Python, 46 in the browser
(small, expected variance from canvas vs. PIL resize interpolation, not
a logic difference). The full event-driven pipeline (init → detect →
overlay → result × N → done) was verified end-to-end with this exact
protocol, including the WebGPU→fresh-WASM fallback succeeding cleanly.
~34ms WASM inference for a ~48-face group photo on this project's
hardware.

**Confirmed working in the real extension**: loaded unpacked in actual
Chrome (not simulated) against `vision-test.html`'s group photo — faces
correctly detected and blacked out, boxes precisely aligned, no `ort is
not defined`, no offset/positioning bug. This was the one piece my own
testing tools could never verify (they don't model true isolated/main
world separation), so it needed a real load to confirm — it now has one.

**Confidence threshold tuned from a real measurement, not a guess**: the
real-Chrome run above (at the original 0.7 threshold) visibly missed a
few faces — smaller/partially-occluded ones toward the back of the
group. Rather than just lower the threshold blindly, this was measured
in Python across four values on the same real image:

| Threshold | Raw candidates | After NMS |
|---|---|---|
| 0.7 (original) | 85 | 44 |
| 0.5 | 107 | 50 |
| 0.3 | 125 | 50 (no further gain over 0.5) |
| 0.2 | 146 | 54 |

0.5 sits at the recall "elbow" — a real +6-face improvement over 0.7,
with the plateau at 0.3 suggesting nothing meaningful is missed between
0.3 and 0.5. Visually re-confirmed at 0.5: all 50 boxes land on real
faces, no false positives on clothing/background. Shipped as the new
default in `CONFIDENCE_THRESHOLD`. This exact exercise — measured
precision/recall at multiple operating points, not a single unmeasured
number — is what PS26171's "recall and precision for detection of
sensitive/PII data" metric (20%) is actually asking for; the same
methodology should be run on the benchmark's real evaluation images,
not just this one test photo, before reporting a final number.


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
- `server/`: `pytest` passes 18/18 — the server rejecting a raw (non-redacted) email field, requiring a non-empty task, the Ollama response parser's malformed-JSON/disallowed-action/invented-element-id/token-in-value fallback paths, and the `type_secret` field-binding checks.

### A real security bug the task feature exposed

Giving the model an explicit task immediately surfaced something the
old goal-less pipeline never would have: asked to "log in with my
password", it proposed `element_id: 1` (the **email** field) paired
with `value_ref: "[PASSWORD_01]"`. Both halves passed validation
individually — a real element id, a real token on the page — because
they were checked *separately*. Together they mean "type the password
into the email box", which would submit the password in the clear.

Two independent fixes, because either alone is fragile:
1. **Prompt**: rule 3 now states that `element_id` and `value_ref` must
   point at the same element, and says why. Re-tested live — the model
   now correctly targets the password field.
2. **Server guard** (`_parse_response`): `type_secret` is rejected
   unless the target element exists, its label *is* the supplied
   `value_ref`, and its role actually contains "password". Locked down
   by `test_falls_back_when_secret_targets_the_wrong_field`, which
   asserts both the rejection and that the correctly-paired version
   still works.

This is the "never trust the model" rule the client-side action
validator already applied, extended to a case that only appears once
the agent has a goal worth pursuing.
- Local vision: verified live in a real browser (WASM path; WebGPU path falls back correctly per the bug above) against the real downloaded test image — 46 faces detected and redacted, cross-checked against an independent Python run of the same model (44 faces, expected small variance).
- Full pipeline verified live end-to-end against a running server: capture → detect (DOM + visual) → redact → Privacy Firewall → `/reason` → validate → execute → verify, with client/server SHA-256 hash matching on the outbound payload (see `docs/DEMO_VERIFICATION.md`).
- `shared/schemas/`: the two frozen contracts both the extension and server code mirror by hand — no codegen yet. If that drift becomes a problem, revisit generating the TS/Pydantic types from these JSON Schemas.
