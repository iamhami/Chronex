# Security Baseline

`S-002` introduces the shared security primitives that the future API layer will
wrap.

## Roles

- `Member`
- `Creator`
- `Moderator`
- `Admin`

## Policy Rules

- Default deny for every protected route.
- Permissions are granted explicitly per role.
- `Admin` is not a blanket override role; it is only allowed where the policy map
  explicitly grants access.
- Authorization decisions are auditable and include actor, action, resource,
  request ID, permission, timestamp, and outcome.

## Middleware Chain

1. Parse auth token claims.
2. Resolve the current identity record.
3. Refresh role/permissions from identity when token role is stale.
4. Evaluate policy.
5. Attach request context or fail with `403 FORBIDDEN`.

## Sensitive Data Handling

- Sensitive profile fields are encrypted before persistence and decrypted only
  after retrieval in the service boundary.
- Ciphertext is versioned and bound to a key ID.
- Raw key material is not part of application config; production resolvers are
  expected to source key material from KMS or another secure provider.
