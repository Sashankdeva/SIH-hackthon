# extension/

Manifest V3 browser extension — the project's runtime host. Owned primarily
by **Role 1 (Extension & Execution)**, but every other browser-side role
has a dedicated folder here that's theirs alone:

| Folder | Owner | What lives here |
|---|---|---|
| `src/background/` | Role 1 | Service worker — message router only. No persistent in-memory state (MV3 kills it after ~30s idle). |
| `src/content/` | Role 1 | Content script entry — orchestrates capture &rarr; detect &rarr; redact &rarr; (send) on each page load. |
| `src/popup/` | Role 1 / Role 3 | Privacy inspector UI shell. |
| `src/perception/` | **Role 2** | DOM/A11y capture (`domCapture.ts`) + local vision, ONNX face detection with WebGPU/WASM fallback (`faceDetector.ts`). |
| `src/vision-main/` | **Role 2** | A second content script that runs in the page's **main world**, not the default isolated one — required for the vision model to load at all. See `../docs/ARCHITECTURE.md`'s "Local vision processing." |
| `src/privacy/` | **Role 3** | Tier-1 PII detection, deterministic redaction, redaction validator, the Privacy Firewall (`sanitizedContext.ts`), visual redaction overlay (`visualRedact.ts`). |
| `src/action/` | **Role 1** | Client action validator + executor — the only code allowed to touch the real page. |
| `src/pvm/` | **Role 5** | Level-1 verification, recovery loop, bounded IndexedDB memory. |
| `src/messaging/` | shared | The typed message contract every module imports from — change it here, not ad hoc. Note: `vision-main/` does NOT use this bus — it can't, it has no `chrome.*` access. It talks to `content/` only via DOM `CustomEvent`s. |

Per-role day-by-day tasks: `../docs/planning/PS26171_Sprint_Plan.pdf`
(one page per role, pages 3&ndash;8).

## Setup

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build        # esbuild -> dist/background.js, dist/content.js, dist/vision-main.js, dist/popup.js
npm run dev           # same, in watch mode
```

## Load it in Chrome

1. `npm run build`
2. `chrome://extensions` &rarr; enable Developer mode &rarr; **Load unpacked** &rarr; select this `extension/` folder (the one containing `manifest.json`).
3. Serve the mock site (`mock-site/README.md`) and open `http://localhost:8000/index.html` — the content script only injects on `localhost`/`127.0.0.1` this sprint.
4. Open the DevTools console on that tab, and the service worker's console via the extension card's "service worker" link, to see the pipeline log each stage.

## The one contract you can't break alone

`src/action/types.ts` (`ActionRequest`) and the shape built by
`src/privacy/sanitizedContext.ts` both mirror files in `shared/schemas/`.
If you change one, update the other three in the same commit — see
`shared/README.md`.
