# mock-site/

Static test site — Integration's Day-1 deliverable (`../docs/planning/PS26171_Role6_Integration.pdf`).
Every other role is blocked until this exists, so it ships first.

- **`index.html`** — a checkout-style page with the fields the official
  rubric expects the agent to handle: name, email, phone, password,
  address, payment, a product selector, and a submit button.
- **`privacy-test.html`** — the dedicated canary page. Seeded with fake
  PII values prefixed `CANARY_` so the team can prove, not just claim,
  that none of them reach the server raw.

## Run it

No build step — plain static HTML/CSS.

```bash
python -m http.server 8000 --directory mock-site
```

Then open `http://localhost:8000/index.html`. The extension's
`host_permissions` and content-script `matches` in
`extension/manifest.json` are scoped to `localhost`/`127.0.0.1` —
keep serving it from here, not `file://`, or the extension won't inject.
