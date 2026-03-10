# API Security Flows

`S-002` is implemented as a real Express middleware stack in `apps/api` plus a
shared security package for encryption and telemetry.

## Middleware Chain

1. Request ID assignment
2. Bearer token parsing
3. Access token validation
4. Identity lookup from the auth store
5. Role refresh and permission resolution
6. Route-level `authorize(permission)` enforcement

The identity lookup step intentionally rebuilds permissions from the current
user record instead of trusting stale token permissions.

## Protected Routes

- `POST /api/v1/profile/consent`
- `POST /api/v1/profile/metrics`
- `POST /api/v1/profile/consent/revoke`
- `GET /api/v1/profile/me`
- `GET /api/v1/profile/:userId`
- `GET /api/v1/creator/publish-capability`
- `GET /api/v1/admin/security/metrics`

## Encryption Boundary

- Sensitive profile fields are encrypted before store writes.
- Sensitive profile fields are decrypted only inside the profile service.
- Malformed or corrupted ciphertexts return `500` without leaking plaintext.

## Security Telemetry

- `rbac_allowed_requests_total`
- `rbac_denied_requests_total`
- `sensitive_decrypt_failures_total`

Audit events record actor, action, resource, request ID, timestamp, and
outcome for allow/deny decisions. Decrypt failures are captured as security
incidents.
