# Stack Publish Flows

`S-006` extends the stack drafting package with immutable artifact publishing,
deterministic redaction, checksum verification, and idempotent publish retries.

## Endpoint

- `POST /api/v1/stacks/:id/publish`

Requests accept pricing metadata and either an `Idempotency-Key` header or a
`requestKey` body field for idempotent retries.

## Publish State Machine

1. `draft`
2. `validating`
3. `publishing`
4. `published`

The publish event trace records state transitions and stage durations for
validation and publishing.

## Validation Gates

- Required output sections must exist with content.
- Prohibited field labels must be absent from draft content.
- Pricing metadata must contain a positive amount, currency, and internal SKU.

Validation failures return `PUBLISH_VALIDATION_FAILED`.

## Redaction and Artifacts

- Restricted field lines are stripped from draft content.
- Email addresses and phone numbers are masked deterministically.
- Published artifacts are stored with an immutable version number and SHA-256
  checksum.
- Payload references use the format `artifact://<stackId>/v<version>/<checksum>`.

## Failure and Idempotency Rules

- Invalid redaction rules or empty redacted output return `REDACTION_FAILED`.
- Persist or checksum verification failures return `ARTIFACT_PERSIST_FAILED`.
- Reusing the same request key returns the original artifact without creating a
  second version.

## Publish Metrics

- `publish_attempt_total`
- `publish_success_total`
- `publish_validation_failure_total`
- `redaction_failure_total`
