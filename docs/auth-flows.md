# Auth Flows

`S-003` defines the shared interfaces and service logic for register, login,
logout, and refresh. The transport layer is intentionally deferred, so these
contracts can be reused when the API framework is introduced.

## Endpoints

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/refresh`

## Registration

- Allowed roles: `Member`, `Creator`
- Duplicate emails fail with `409 EMAIL_ALREADY_EXISTS`
- Successful registration immediately creates a session and returns access and
  refresh credentials

## Login

- Passwords are hashed with Node.js `scrypt`
- Failed logins increment lockout state without revealing account existence
- Lockout threshold and rate-limit windows are configurable

## Session Lifecycle

- Access token: signed, short-lived
- Refresh token: signed, rotating, session-bound
- Logout: revokes the current refresh chain and is idempotent
- Refresh: rotates the token chain and invalidates older refresh tokens

## Error Codes

- `EMAIL_ALREADY_EXISTS`
- `INVALID_CREDENTIALS`
- `ACCOUNT_LOCKED`
- `RATE_LIMITED`
