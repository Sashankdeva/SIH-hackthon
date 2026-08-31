# Final Field Test Runbook

Step-by-step procedure for the first real two-device field test: a Chrome
extension on a client laptop, talking over a real LAN to a FastAPI +
Ollama + Qwen 2.5 7B server on a second laptop.

Read `docs/DEPLOYMENT.md` first if either machine isn't already set up —
this document assumes both are running and reachable, and walks through
*proving* the deployment works, not building it.

**Honesty note.** Every item in this runbook was designed and, where the
verification method says so, exercised on a single-machine approximation
(one machine acting as both "client" and "LLM host" over its own real
LAN IP, with a real Ollama and real Qwen behind it) — see the project's
own two-laptop-validation and final-report documents for that evidence.
Nothing in this file should be read as a claim that a second physical
laptop or a real Chrome window has already run this procedure. The
**Acceptance Matrix** at the end marks, item by item, what is actually
verified versus what still requires the real hardware this runbook is
written for.

---

## Preflight

Run on BOTH machines before anything else.

### Connectivity

```bash
# From the client laptop
ping llm-host.local
# If that fails, see docs/DEPLOYMENT.md's "Hostname resolution" section
# for the LAN-IP fallback, and use the IP for every step below instead.
```

### Hostname resolution

Confirm which form actually works on this network:
- `llm-host.local` resolves → use it everywhere below.
- It doesn't → use the LAN IP from `ipconfig`/`ip addr` on the LLM host,
  and substitute it for `llm-host.local` in every command in this
  runbook. Do not hardcode this IP into `manifest.json`,
  `chrome.storage.local`, or any application code — it only ever goes
  into the extension popup's Server URL field and, if needed,
  `manifest.json`'s `host_permissions`, both of which are configuration,
  not code.

### `/health`

```bash
curl http://llm-host.local:8787/health
# {"status":"ok"}
```

### API authentication (if `API_KEY` is set on the server)

```bash
curl -X POST http://llm-host.local:8787/reason -H "Content-Type: application/json" -d '{}'
# expect 401 — proves auth is actually enforced, not just configured
```
Then confirm the extension popup's API key field (Server section) has
the matching value saved.

---

## Single-step test

1. Load the extension in Chrome on the client laptop (`chrome://extensions`
   → Developer mode → Load unpacked).
2. Open the mock site (`http://localhost:8000/index.html`, served locally
   on the CLIENT laptop — the mock site itself never needs to be on the
   LLM host).
3. Open the popup, submit a single-action task (e.g. "click the Place
   Order button").
4. Confirm, in order:
   - The extension sends exactly one `/reason` request (DevTools →
     Network tab, or the console's `[privacy-proof]` log line).
   - The LLM host's log shows the request arriving
     (`server/logs/reason_requests.jsonl`, or console output).
   - Qwen produces a response (`ollama ps` on the LLM host shows it
     loaded, if this is the first request).
   - The action returns to the client.
   - `validateAction` runs (a console warning appears here ONLY if the
     action is ever rejected — silence means it passed).
   - The browser actually performs the action (visible on the page).
   - PVM verification logs a status (`[pipeline] verification: ...` in
     the console) — success, ambiguous, or failure.

---

## Multi-step test

Use several GENERAL task types — none of these should be a specific
commercial flow (no "add to Samsung cart" or similar hardcoded scenario):

| Type | Example task |
|---|---|
| Navigation | "Go to the privacy test page" |
| Search | "Search this page for [term]" (needs a page with a search box) |
| Multi-step form | "Fill in the checkout form and submit it" |
| Selection | "Choose the second product option" |
| Compound | "Scroll down and then submit the form" |
| Recovery | Pick a task where the obvious first action produces no visible change — confirm the loop tries something else rather than halting immediately |
| Task completion | Any of the above, ending in a real `/complete: true` |

For each: confirm the full sequence — capture → sanitize → `/reason` →
validate → execute → PVM → `/complete` → next step or a clean stop.
Real-model outcomes are not scripted; the guarantee to check is
structural: the loop never fabricates success, never skips a stage, and
always halts safely if it can't finish.

---

## Memory test

This is the one test that specifically needs a REAL content-script
lifecycle change — a page reload is sufficient (Chrome tears down and
reconstructs the content script on every navigation/reload); closing and
reopening the tab is a stronger version of the same thing.

1. **Run 1**: perform a task on the client. Confirm in the console: a
   memory miss, a real `/reason` call, execution, a PVM success, and (on
   success) the transition being recorded.
2. **Reload the page** (or close/reopen the tab) — this is the "recreate
   the extension lifecycle" step. Optionally inspect
   DevTools → Application → IndexedDB → `pvm-store` → `transitions` to
   confirm the record from run 1 survived the reload.
3. **Run 2**: repeat the IDENTICAL task on the SAME page state. Confirm:
   - Hydration runs (a console log reports the record count).
   - The remembered action is proposed WITHOUT a new `/reason` call for
     that step.
   - It still passes through `validateAction`, executes normally, and
     gets a real PVM verification — memory proposes, it never bypasses
     anything downstream.
4. Confirm the `/reason` call count for run 2 is lower than run 1 for
   the same task.

---

## Failure tests

Induce each of these on the client laptop and confirm the extension
fails safely — never executes an unvalidated action, never claims
success, never exposes a secret, never crashes the tab:

| Induce | Expected |
|---|---|
| Stop the FastAPI process on the LLM host | The current step fails cleanly; the tab stays usable |
| Wrong API key (if auth enabled) | A real 401; nothing executes |
| Stop Ollama on the LLM host, keep FastAPI running | A real 503 `model_unavailable`; nothing executes |
| Point the server URL at something returning an unrelated 200 response (e.g. `/health` in place of `/reason`) | The malformed response is rejected; nothing executes |
| Disable/unplug the client's network mid-task | A real connection timeout; the step fails, doesn't hang forever |
| Kill FastAPI right before a `/complete` call | The task is never reported as finished |

---

## Privacy test

Use synthetic data only — an obviously fake value like
`CANARY-DO-NOT-SEND-<random>` as a "password."

1. Fill the mock checkout form with synthetic values and submit a task.
2. Capture the real wire payload from BOTH ends:
   - Client: DevTools Console — every outbound call logs its exact bytes
     and SHA-256 (`[privacy-proof] exact bytes sent`).
   - Server: `tail server/logs/reason_requests.jsonl` on the LLM host.
3. Search both captures for the canary string:
   ```bash
   grep "CANARY-DO-NOT-SEND" server/logs/reason_requests.jsonl
   # must print nothing
   ```
4. Confirm the field appears as a redaction token (e.g. `[PASSWORD_01]`)
   in the captured payload, never as the raw value.

---

## Evidence collection

Save the following for the final project/demo record:

- **Architecture diagram** — `docs/ARCHITECTURE.md`'s existing diagram, or
  a screenshot of this runbook's topology section.
- **Client/server IP or hostname** — whatever `llm-host.local` resolved
  to (or the LAN-IP fallback used).
- **`/health` response** — terminal output or screenshot of the curl
  command above.
- **Authenticated `/reason`** — a request/response pair showing the
  `X-API-Key` header present and a 200 response (redact the key value
  itself before sharing this evidence anywhere).
- **`/complete`** — a request/response pair showing a real `true` or
  `false` verdict.
- **Sanitized request sample** — the exact JSON body captured in the
  privacy test, with redaction tokens visible.
- **No-secret-leakage proof** — the `grep` output showing zero matches,
  from the privacy test.
- **PVM escalation evidence** — a console log showing an L2 (or L3)
  escalation actually firing (`level: "L2"`, `escalatedFromLevel: "L1"`).
- **Memory hit evidence** — the console log line from the memory test's
  run 2 showing a hydrated hit and the reduced `/reason` count.
- **Latency measurements** — DevTools Network tab timings for `/reason`
  and `/complete`, and the total time for a multi-step task.
- **Test results** — the regression summary from this document's own
  Final Regression section.
- **Screenshots/video** — of the popup, the DevTools Network tab during
  a task, and the IndexedDB record in Application tab, if desired for
  the demo.

---

## Acceptance Matrix

| Requirement | Verification method | Expected result | Status | Evidence |
|---|---|---|---|---|
| Client works without Ollama | Client codebase has zero Ollama/Qwen dependency (grep confirms no reference anywhere in `extension/src/`); every real-network test this project ran drove the real client code with no Ollama on the client side | Task completes via a remote `/reason` call alone | **VERIFIED NOW** (structurally, and via single-machine real-network tests) — a literal second physical machine that never had Ollama installed has not yet run it | `extension/tests/e2eRealNetwork.test.ts` |
| Client works without Qwen | Same as above | Same as above | **VERIFIED NOW** (same caveat) | Same |
| Remote reasoning works (`/reason` over LAN) | Real HTTP POST to a real FastAPI+Ollama server via the machine's real LAN IP (not `localhost`) | Real Qwen-produced action returned, HTTP 200 | **VERIFIED NOW** | `server` connection-lifecycle and two-laptop-validation phase reports; measured `/reason` latency ~0.9–1.9s |
| Privacy boundary works | Canary secret sent through the real client pipeline, captured at both the outbound payload and the real server log | Canary string absent from both | **VERIFIED NOW** | `tests/e2eRealNetwork.test.ts`'s form-fill test; `grep` against `reason_requests.jsonl` |
| PVM works locally | Real production loop (`runTask`), real model decisions, on a fixture designed to force L1-ambiguous → L2 escalation | L2 fires and resolves to a verified success | **VERIFIED NOW** for L1/L2; L3 and recovery covered by the existing regression suite (not re-triggered live with a real model this session) | e2e test: "PVM L2 escalation fires for real" |
| Completion works | Real `/complete` calls through a full task; a rejected/mismatched response is never treated as success (existing regression suite) | `true` ends the task, `false` continues, failure is never success | **VERIFIED NOW** | Two-laptop-validation report; `server/tests/test_completion_endpoint.py` |
| Memory works | Real IndexedDB-backed hydration across a simulated fresh content-script lifetime, over real network | Second run replays with 0 new `/reason` calls, still validated and PVM-verified | **VERIFIED NOW** (single-machine; a literal page reload in real Chrome has not been observed) | `tests/pvmMemoryPersistence.test.ts`, `tests/e2eRealNetworkLatency.test.ts` (133ms memory-hit vs ~1.9s cold) |
| Authentication works | Real auth-enabled FastAPI instance; client configured with a matching/missing key | Correct key → 200; missing/wrong → 401, never executed | **VERIFIED NOW** | `tests/e2eRealNetwork.test.ts`'s auth tests; `server/tests/test_security_hardening.py` |
| Ollama is not externally exposed | Actual socket inspection (`Get-NetTCPConnection`/`lsof`), not configuration text | Port 11434 bound to `127.0.0.1` only | **VERIFIED NOW** | Server security-hardening phase report |
| Multi-step task works | A real 3-step task driven end-to-end over real network with real Qwen decisions | All 3 steps execute, verify, and the task completes | **VERIFIED NOW** | `tests/e2eRealNetworkLatency.test.ts` (3-step task, ~5.2s total) |
| A second physical laptop runs the extension in real Chrome | — | — | **REQUIRES SECOND LAPTOP + REQUIRES REAL CHROME** | Not yet performed |
| Real `.local` mDNS resolution across two physical hosts | — | — | **REQUIRES SECOND LAPTOP** | Not yet performed (Windows specifically needs Bonjour installed — see `docs/DEPLOYMENT.md`) |
| Chrome's real `host_permissions` enforcement | — | — | **REQUIRES REAL CHROME** | Simulated via test stubs only |
| Popup UI (server URL / API key fields) renders and functions | — | — | **REQUIRES REAL CHROME** | Code reviewed and typechecked, not visually confirmed in a real browser window |
| Windows Firewall prompt/rule on a genuinely separate machine | — | — | **REQUIRES SECOND LAPTOP** | Not yet performed |

---

## Final Regression

Run before signing off on any deployment:

```bash
# Extension
cd extension
npm run typecheck && npm run typecheck:tests
npm test                    # vitest
npm run test:integration    # node:test, including real-network e2e (skips if no live server)
npm run build

# Server
cd ../server
./.venv/Scripts/python.exe -m pytest -q
```

**Known, pre-existing, non-regression items** (report separately, do not
treat as failures):
- `server/tests/test_completion_regression_live.py::test_completion_verdict_matches_ground_truth[ML1]` —
  documented live-model nondeterminism on one borderline case. Confirmed
  across many runs this project's own history to flip independent of any
  code change. Not a security or correctness regression.
- `extension/src/perception/__tests__/stress.test.ts`'s large-DOM timing
  assertion — a wall-clock threshold test, occasionally flaky under
  system load, confirmed to pass reliably in isolation.

Do not weaken, skip, or delete either test to make a run look cleaner —
their honest status is exactly what's recorded above.
