# Chronex

Chronex starts as a small npm workspaces monorepo with separate API and web
runtime configuration modules. The current baseline covers `S-001 Setup
monorepo runtime config and secrets` and the shared auth flow primitives for
`S-003 Build signup/login flows for Member and Creator`, the Express security
middleware and encryption primitives for `S-002 Implement RBAC middleware and
encrypted fields`, the consent and profile domain service for `S-004 Add
consent capture and profile schema`, the stack draft/editor primitives for
`S-005 Build stack builder UI with templates and autosave`, and the versioned
redacted publish flow for `S-006 Implement publish flow creating redacted
purchasable artifact version`.

## Structure

- `apps/api`: API runtime entrypoints and API-only environment contract.
- `apps/web`: web runtime entrypoints and public environment contract.
- `packages/config`: shared config loading, validation, and tests.
- `packages/auth`: shared auth service, token lifecycle, and auth flow tests.
- `packages/security`: encryption utilities, decrypt-failure telemetry, and
  RBAC audit metrics.
- `packages/profile`: consent timeline, minimized profile contracts, and profile
  observability service logic.
- `packages/stacks`: template-backed draft persistence, editor state control,
  autosave behavior, preview rendering, and immutable publish/versioning logic.
- `docs/`: environment matrix, operational config inventory, and API contract
  notes.

## Commands

- `npm test`: run config, auth, security, profile, stack draft/editor, and API
  middleware tests.
- `npm run check:env:api`: validate the API environment for the current shell.
- `npm run check:env:web`: validate the web environment for the current shell.

## Local Development

1. Copy `.env.local.example` to `.env.local`.
2. Replace placeholder secrets with local-only values.
3. Run the validation scripts before wiring app startup.
