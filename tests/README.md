# tests/

Cross-cutting integration/end-to-end tests — for later Playwright-driven
golden-path runs against the real extension + server + mock site
together (Phase 2, `PS26171_Sprint_Plan.pdf`).

Unit tests live next to the code they test, not here:

- `server/tests/` — FastAPI route and validator tests (`pytest`, already wired up and passing).
- Extension unit tests — not set up yet; add a `*.test.ts` convention here once Day 1&ndash;2 modules stabilize.
