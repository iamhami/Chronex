# Environment Matrix

Chronex configuration is deterministic by environment and never falls back to
implicit defaults for required keys.

## Load Order

1. Runtime-injected process environment.
2. `.env.local` for local development only.
3. Schema validation.
4. Application startup.

## Matrix

| Environment | `NODE_ENV` | Source of truth | Local env file allowed | Validation rule |
| --- | --- | --- | --- | --- |
| Local | `development` | `.env.local` plus process env overrides | Yes | Missing or invalid keys fail startup |
| Staging | `staging` | Managed secret store / injected env | No | Any local env file fallback is rejected |
| Production | `production` | Managed secret store / injected env | No | Any local env file fallback is rejected |

## Path Rules

- Local config file path: repository root `./.env.local`
- Staging and production must not use `CHRONEX_ENV_FILE` or any local file path
- Process env always wins over `.env.local` when both provide the same key
