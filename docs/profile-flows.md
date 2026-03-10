# Profile and Consent Flows

`S-004` defines the shared interfaces and service logic for consent capture,
profile metrics updates, revocation, and profile-use enforcement. The transport
layer is intentionally deferred, so these contracts can plug into the API when
the HTTP framework is introduced.

## Endpoints

- `POST /api/v1/profile/consent`
- `POST /api/v1/profile/metrics`
- `POST /api/v1/profile/consent/revoke`

## Consent Contract

- Consent writes require the active policy version configured by the service.
- Acceptance stores an immutable event with timestamp, IP address, and
  fingerprint metadata.
- Revocation appends a second immutable event and immediately blocks profile
  reads and writes until consent is re-accepted.

## Profile Schema

- `conditionPrimary`
- `severityBand`: `low`, `medium`, or `high`
- `symptomTags`
- `lifestyleTags`

The service only stores the minimized fields required for matching. All profile
fields are encrypted at the service boundary before they are written to the
store.

## Error Codes

- `CONSENT_REQUIRED`
- `CONSENT_REVOKED`
- `PROFILE_VALIDATION_ERROR`

## Observability

- `consent_accept_total`
- `consent_revoke_total`
- `profile_update_success_total`
- `consent_enforcement_denied_total`

Consent and profile access decisions are also appended to an audit stream for
traceability.
