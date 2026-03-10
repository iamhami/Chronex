import assert from "node:assert/strict";
import test from "node:test";

import { ProfileError, ProfileService, type SensitiveFieldCipher } from "../src/index.ts";

function createCipher(keyId = "kms-profile-v1"): SensitiveFieldCipher {
  return {
    keyId,
    encrypt(value: string): string {
      return `enc:${keyId}:${Buffer.from(value, "utf8").toString("base64url")}`;
    },
    decrypt(value: string): string {
      const prefix = `enc:${keyId}:`;
      if (!value.startsWith(prefix)) {
        throw new Error("Unexpected ciphertext prefix.");
      }

      return Buffer.from(value.slice(prefix.length), "base64url").toString("utf8");
    }
  };
}

function createService() {
  let now = Date.parse("2026-03-10T12:00:00.000Z");

  return {
    advance(ms: number) {
      now += ms;
    },
    service: new ProfileService({
      activePolicyVersion: "2026-03-01",
      cipher: createCipher(),
      now: () => now
    })
  };
}

const meta = {
  ipAddress: "127.0.0.1",
  fingerprint: "profile-device"
};

test("consent acceptance stores an immutable timeline and exposes the active record", () => {
  const { service, advance } = createService();

  const accepted = service.acceptConsent(
    {
      userId: "usr_123",
      policyVersion: "2026-03-01"
    },
    meta
  );

  advance(1_000);

  const revoked = service.revokeConsent(
    {
      userId: "usr_123"
    },
    meta
  );

  assert.equal(accepted.status, "active");
  assert.equal(revoked.status, "revoked");
  assert.equal(service.listConsentEvents("usr_123").length, 2);
  assert.deepEqual(service.getMetrics(), {
    consent_accept_total: 1,
    consent_revoke_total: 1,
    profile_update_success_total: 0,
    consent_enforcement_denied_total: 0
  });
});

test("policy version mismatches are rejected before consent is recorded", () => {
  const { service } = createService();

  assert.throws(
    () =>
      service.acceptConsent(
        {
          userId: "usr_123",
          policyVersion: "2026-02-01"
        },
        meta
      ),
    (error) =>
      error instanceof ProfileError
      && error.code === "PROFILE_VALIDATION_ERROR"
      && error.status === 409
  );

  assert.equal(service.listConsentEvents("usr_123").length, 0);
});

test("profile writes require active consent and increment denial metrics", () => {
  const { service } = createService();

  assert.throws(
    () =>
      service.updateProfile(
        {
          userId: "usr_123",
          conditionPrimary: "arthritis",
          severityBand: "medium",
          symptomTags: ["joint-pain"],
          lifestyleTags: ["walking"]
        },
        meta
      ),
    (error) =>
      error instanceof ProfileError
      && error.code === "CONSENT_REQUIRED"
      && error.status === 403
  );

  assert.deepEqual(service.getMetrics(), {
    consent_accept_total: 0,
    consent_revoke_total: 0,
    profile_update_success_total: 0,
    consent_enforcement_denied_total: 1
  });
});

test("profile updates are validated, encrypted at rest, and support partial updates", () => {
  const { service, advance } = createService();
  service.acceptConsent(
    {
      userId: "usr_123",
      policyVersion: "2026-03-01"
    },
    meta
  );

  const created = service.updateProfile(
    {
      userId: "usr_123",
      conditionPrimary: "arthritis",
      severityBand: "medium",
      symptomTags: ["joint-pain", "fatigue"],
      lifestyleTags: ["walking"]
    },
    meta
  );

  advance(1_000);

  const updated = service.updateProfile(
    {
      userId: "usr_123",
      lifestyleTags: ["walking", "swimming"]
    },
    meta
  );

  const stored = service.store.findProfileByUserId("usr_123");
  assert.ok(stored);
  assert.notEqual(stored.conditionPrimaryCiphertext, "arthritis");
  assert.equal(created.conditionPrimary, "arthritis");
  assert.equal(updated.conditionPrimary, "arthritis");
  assert.deepEqual(updated.lifestyleTags, ["walking", "swimming"]);
  assert.deepEqual(updated.symptomTags, ["joint-pain", "fatigue"]);
  assert.equal(service.listChangeLog("usr_123").length, 2);
  assert.deepEqual(service.getMetrics(), {
    consent_accept_total: 1,
    consent_revoke_total: 0,
    profile_update_success_total: 2,
    consent_enforcement_denied_total: 0
  });

  assert.throws(
    () =>
      service.updateProfile(
        {
          userId: "usr_123",
          symptomTags: ["joint-pain", "joint-pain"]
        },
        meta
      ),
    (error) =>
      error instanceof ProfileError
      && error.code === "PROFILE_VALIDATION_ERROR"
      && error.status === 422
  );

  assert.throws(
    () =>
      service.updateProfile(
        {
          userId: "usr_123",
          symptomTags: "joint-pain" as unknown as string[]
        },
        meta
      ),
    (error) =>
      error instanceof ProfileError
      && error.code === "PROFILE_VALIDATION_ERROR"
      && error.status === 422
  );
});

test("revocation blocks profile reads and writes until consent is accepted again", () => {
  const { service, advance } = createService();
  service.acceptConsent(
    {
      userId: "usr_123",
      policyVersion: "2026-03-01"
    },
    meta
  );
  service.updateProfile(
    {
      userId: "usr_123",
      conditionPrimary: "arthritis",
      severityBand: "high",
      symptomTags: ["joint-pain"],
      lifestyleTags: ["stretching"]
    },
    meta
  );

  advance(1_000);

  service.revokeConsent(
    {
      userId: "usr_123"
    },
    meta
  );

  assert.throws(
    () => service.getProfile({ userId: "usr_123" }, meta),
    (error) => error instanceof ProfileError && error.code === "CONSENT_REVOKED"
  );
  assert.throws(
    () =>
      service.updateProfile(
        {
          userId: "usr_123",
          lifestyleTags: ["stretching", "cycling"]
        },
        meta
      ),
    (error) => error instanceof ProfileError && error.code === "CONSENT_REVOKED"
  );

  advance(1_000);

  service.acceptConsent(
    {
      userId: "usr_123",
      policyVersion: "2026-03-01"
    },
    meta
  );

  const profile = service.getProfile({ userId: "usr_123" }, meta);
  assert.equal(profile.severityBand, "high");
  assert.deepEqual(service.getMetrics(), {
    consent_accept_total: 2,
    consent_revoke_total: 1,
    profile_update_success_total: 1,
    consent_enforcement_denied_total: 2
  });
  assert.deepEqual(
    service
      .listAuditEvents()
      .map((event) => event.type),
    [
      "consent_accepted",
      "profile_updated",
      "consent_revoked",
      "consent_enforcement_denied",
      "consent_enforcement_denied",
      "consent_accepted",
      "profile_read"
    ]
  );
});
