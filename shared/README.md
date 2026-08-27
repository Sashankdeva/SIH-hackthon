# shared/

Frozen contracts between the extension and the server. Both sides must honor
these exactly — a mismatch here is the single most common way to lose a
whole afternoon to "why isn't the action executing."

- **`schemas/sanitized-context.schema.json`** — the *only* payload shape
  allowed to leave the browser. The extension's Privacy Firewall builds it;
  the server's `SanitizedContext` Pydantic model (`server/app/models/context.py`)
  parses it. If you need a new field, add it here first, then update both
  implementations in the same PR.
- **`schemas/action.schema.json`** — the structured action the server is
  allowed to return. The extension's action validator
  (`extension/src/action/validator.ts`) rejects anything that doesn't match
  this shape before it's ever executed.

Changing either schema is a cross-team decision — see
`PS26171_Role1_Extension.pdf` and `PS26171_Role4_Server.pdf`: the schema
freeze is an explicit Day-1 task for both roles, together.
