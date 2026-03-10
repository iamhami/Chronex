# Chronex

Chronex starts as a small npm workspaces monorepo with separate API and web
runtime configuration modules. The current baseline covers `S-001 Setup
monorepo runtime config and secrets` and the shared auth flow primitives for
`S-003 Build signup/login flows for Member and Creator`.

## Structure

- `apps/api`: API runtime entrypoints and API-only environment contract.
- `apps/web`: web runtime entrypoints and public environment contract.
- `packages/config`: shared config loading, validation, and tests.
- `packages/auth`: shared auth service, token lifecycle, and auth flow tests.
- `docs/`: environment matrix and operational config inventory.

## Commands

- `npm test`: run config validation tests.
- `npm run check:env:api`: validate the API environment for the current shell.
- `npm run check:env:web`: validate the web environment for the current shell.

## Local Development

1. Copy `.env.local.example` to `.env.local`.
2. Replace placeholder secrets with local-only values.
3. Run the validation scripts before wiring app startup.
