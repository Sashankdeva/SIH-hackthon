# Deployment Guide

Server setup, client setup, environment variables, security configuration,
startup commands, and troubleshooting for running this project across two
real machines: an LLM-host laptop (FastAPI + Ollama + Qwen) and a client
laptop (Chrome + the extension only).

See `docs/FINAL_FIELD_TEST_RUNBOOK.md` for the step-by-step procedure to
actually validate a deployment once it's set up. This document is the
reference for *getting it running*; that one is the reference for
*proving it works*.

## Topology

```
CLIENT LAPTOP                              LLM HOST LAPTOP
Chrome + Extension                         FastAPI
  - privacy firewall                         - /reason, /complete, /health
  - DOM capture                            localhost:11434
  - action validation/execution              - Ollama
  - PVM L1/L2/L3, recovery                     - Qwen 2.5 7B
  - persistent memory (IndexedDB)
        │
        │  http://llm-host.local:8787  (or a LAN IP fallback — see below)
        ▼
  FastAPI on the LLM host
```

The client never needs Ollama or Qwen installed. Ollama is never reachable
from the client, or from anywhere on the LAN — only the LLM-host laptop's
own FastAPI process talks to it, over `localhost`.

---

## Server setup (LLM-host laptop)

### 1. Python environment

```bash
cd server
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt  # macOS/Linux
```

### 2. Ollama

1. Install [Ollama](https://ollama.com).
2. Pull the model:
   ```bash
   ollama pull qwen2.5:7b-instruct
   ```
   (~4.7 GB download; fits an 8 GB-VRAM GPU at Q4 quantization alongside
   Chrome + this server.)
3. Confirm it's running and reachable locally:
   ```bash
   ollama list                         # shows the model, with its size
   curl http://localhost:11434/api/tags
   ```
4. Confirm Ollama is bound to loopback only — this is the single most
   important network-exposure check on this machine:
   ```bash
   # Windows
   Get-NetTCPConnection -LocalPort 11434 -State Listen
   # macOS/Linux
   lsof -iTCP:11434 -sTCP:LISTEN
   ```
   `LocalAddress` must read `127.0.0.1`. If it reads `0.0.0.0`, something
   has set `OLLAMA_HOST` to a LAN-facing value — unset it and restart
   Ollama before continuing. **Never** set `OLLAMA_BASE_URL` (the
   server's own config) to anything other than `http://localhost:11434`.

### 3. Environment variables

Copy `.env.example` to `.env` for reference (the app reads real process
environment variables via `os.getenv`, not the file directly — export
them in your shell or use a process manager/`.env` loader).

| Variable | Safe default | Set for this deployment to |
|---|---|---|
| `HOST` | `127.0.0.1` | This machine's real LAN IP (see step 4) — never `0.0.0.0` unless you specifically need every interface |
| `PORT` | `8787` | `8787` (or your choice) |
| `REASONING_BACKEND` | `stub` | `ollama` |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | leave as default |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | leave as default — **never** a LAN address |
| `OLLAMA_TIMEOUT_S` | `60` | leave as default (covers cold-start VRAM loading) |
| `MAX_REQUEST_BODY_BYTES` | `65536` | leave as default |
| `API_KEY` | (empty) | a long random value — `openssl rand -hex 32` — for any deployment reachable by a machine you don't personally control |
| `LOG_FULL_REQUEST_BODY` | `false` | leave `false` unless you are personally running a synthetic-data-only privacy demo on this exact machine |
| `ALLOWED_ORIGINS` | `http://localhost:8000,http://127.0.0.1:8000` | the mock site's real origin on the CLIENT laptop (usually unchanged — the mock site is served from `localhost:8000` on whichever machine runs Chrome) |

### 4. Find this machine's LAN IP

```bash
ipconfig            # Windows — "IPv4 Address" under your active adapter
# ip -4 addr show   # Linux
# ipconfig getifaddr en0   # macOS
```

Use this IP (or the hostname from the **Hostname resolution** section
below) as `HOST`.

### 5. Windows Firewall rule

```powershell
# Elevated PowerShell
New-NetFirewallRule -DisplayName "PrivyVision LLM host" `
  -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
```

(The first inbound connection attempt often prompts Windows Firewall
automatically — accept for at least "Private networks" if so.)

### 6. Start FastAPI

```bash
# Windows PowerShell
$env:HOST = "<this-machine's-LAN-IP>"
$env:PORT = "8787"
$env:REASONING_BACKEND = "ollama"
$env:API_KEY = "<your-generated-key>"
./.venv/Scripts/python.exe -m app.main
```

```bash
# macOS/Linux
HOST=<lan-ip> PORT=8787 REASONING_BACKEND=ollama API_KEY=<key> \
  ./.venv/bin/python -m app.main
```

`python -m app.main` reads `HOST`/`PORT`/everything else from the
environment and calls `uvicorn.run(...)` itself — no CLI flags to
remember, and no `--reload` (a reload-enabled server spawns a supervisor
process and is not appropriate for a deployment).

### 7. Verify `/health`

From the SAME machine first:
```bash
curl http://<lan-ip>:8787/health
# {"status":"ok"}
```
Then from the client laptop, once it's on the same network (see below).

### 8. Verify authentication is active (if `API_KEY` is set)

```bash
curl -X POST http://<lan-ip>:8787/reason -H "Content-Type: application/json" -d '{}'
# expect: 401 {"error":"unauthorized",...}

curl -X POST http://<lan-ip>:8787/reason -H "X-API-Key: <your-key>" -H "Content-Type: application/json" -d '{...valid sanitized context...}'
# expect: 200 (or a reasoning-specific error, never 401)
```

### 9. Confirm safe logging

```bash
tail server/logs/reason_requests.jsonl
```
Each line should show `path`, `sha256`, `body_size`, `status_code`,
`elapsed_ms` — and, unless you deliberately set
`LOG_FULL_REQUEST_BODY=true`, **no** `parsed_body` key.

---

## Client setup (client laptop)

**Requirements: Chrome only. No Python, no Ollama, no GPU, no model.**

### 1. Supported browser

Chrome or a Chromium-based browser supporting Manifest V3 extensions
(Edge, Brave). This has been developed and tested against desktop Chrome.

### 2. Build the extension

The extension itself needs to be built once (on any machine with Node —
this can be the LLM-host laptop, then copy the `extension/` folder over,
or directly on the client if it has Node too):

```bash
cd extension
npm install
npm run build
```

### 3. Set `host_permissions` for the LLM host

Edit `extension/manifest.json` **before** the build above, adding the
LLM host's origin:

```json
"host_permissions": [
  "http://localhost/*",
  "http://127.0.0.1/*",
  "http://llm-host.local:8787/*"
]
```

This is required — Chrome blocks a content script's cross-origin
`fetch()` at the extension-permission level regardless of any other
setting if the target origin isn't listed here. Add only the specific
host:port you're targeting; do not widen this to a wildcard.

### 4. Load the unpacked extension

`chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the `extension/` folder (the one containing `manifest.json`).

### 5. Serve the mock site (or use the real target site)

```bash
cd mock-site
python -m http.server 8000
```
Open `http://localhost:8000/index.html` in Chrome.

### 6. Configure the server URL and API key

Click the extension icon → popup → **Server** section:
- **Server URL**: `http://llm-host.local:8787/reason` (or the LAN-IP
  fallback — see below). The `/complete` endpoint is derived
  automatically; you only ever configure this one address.
- **API key**: only needed if the LLM host has `API_KEY` set. Leave
  blank otherwise — the client sends no `X-API-Key` header at all when
  this field is empty, which is exactly what an unauthenticated server
  expects.

### 7. Confirm LAN connectivity

```bash
ping llm-host.local
curl http://llm-host.local:8787/health
```

---

## Hostname resolution: `llm-host.local`

`.local` names resolve via mDNS (Bonjour/Avahi), which is **not
universal**. Do not assume it works on an unfamiliar network.

| Platform | mDNS support |
|---|---|
| macOS | Built in (Bonjour). Rename the machine under *System Settings → General → Sharing* if needed. |
| Linux | Install and enable `avahi-daemon`. |
| Windows | **Not built in.** Install *Bonjour Print Services*, or skip the hostname entirely (see fallback below). |

### Fallback: LAN IP, without hardcoding it into the app

If `.local` resolution doesn't work on the network you're actually on:

1. On the LLM-host laptop: `ipconfig` (or `ip addr`/`ifconfig`) to find
   its real LAN IP.
2. On the client: set the extension popup's **Server URL** to
   `http://<that-ip>:8787/reason` instead of the hostname.
3. Add that same IP (not just the hostname) to `manifest.json`'s
   `host_permissions`.

Nothing in the application code ever hardcodes an IP or hostname —
`app/config.py`'s `HOST`/`PORT` and the extension's `serverUrl` (in
`chrome.storage.local`) are the only places either one lives, both
runtime-configured. Falling back to an IP is a configuration change on
two machines, never a code change.

---

## Security configuration summary

| Control | Where | Default | Notes |
|---|---|---|---|
| API key | `API_KEY` (server) + popup "API key" (client) | disabled | Constant-time comparison; missing and wrong key get an identical 401; never logged |
| Full-body logging | `LOG_FULL_REQUEST_BODY` | `false` | Hash/size/status/timing always recorded regardless |
| CORS | `ALLOWED_ORIGINS` | mock site's localhost origin | Browser-enforced only — not authentication |
| Request size | `MAX_REQUEST_BODY_BYTES` | 64 KiB | Applies to both `/reason` and `/complete` |
| Ollama exposure | `OLLAMA_BASE_URL` + Ollama's own bind | loopback-only | Verify with `Get-NetTCPConnection`/`lsof`, not just config text |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Client gets a network error, not even a 4xx | `host_permissions` missing the LLM host's origin | Add it to `manifest.json`, rebuild, reload the unpacked extension |
| `ping llm-host.local` fails | mDNS not supported on this OS/network | Use the LAN-IP fallback above |
| `/health` unreachable from the client but works locally on the host | Firewall blocking the port, or `HOST` bound to `127.0.0.1` instead of the LAN IP | Re-check the firewall rule and `HOST` value |
| Every request gets `401 unauthorized` | Client's popup API key doesn't match the server's `API_KEY`, or is blank while the server has one set | Re-enter the matching key in the popup, click Save, reload the target page |
| `/reason` returns `503 model_unavailable` | Ollama not running, or `OLLAMA_BASE_URL` wrong | `ollama serve` / check `curl http://localhost:11434/api/tags` on the LLM host |
| First request after starting takes ~30s | Normal — cold Ollama paging the model into VRAM | Not a bug; `OLLAMA_TIMEOUT_S=60` exists specifically to survive this |
| Audit log has no `parsed_body` and you expected one | `LOG_FULL_REQUEST_BODY` is `false` (the safe default) | Only set `true` for a synthetic-data-only demo on your own machine, and remember to turn it back off |
| A repeated task doesn't seem to get faster on the second run | Memory hit conditions weren't met (page structure changed, task text differs, or `/reason` chose a `type`/`type_secret` action, which is never persisted) | Expected — see the PVM memory phase's own documented invalidation rules; this is not a bug |
