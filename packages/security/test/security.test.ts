import assert from "node:assert/strict";
import test from "node:test";

import {
  authorize,
  createSensitiveCrypto,
  decryptSensitiveProfile,
  encryptSensitiveProfile,
  ForbiddenError,
  protectedRoutes
} from "../src/index.ts";
import type {
  AuditEntry,
  AuditLogger,
  IdentityRecord,
  KeyResolver,
  Role
} from "../src/index.ts";

class MemoryAuditLogger implements AuditLogger {
  readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}

class StaticKeyResolver implements KeyResolver {
  constructor(private readonly keys: Record<string, string>) {}

  resolveKey(keyId: string): Uint8Array {
    const key = this.keys[keyId];
    if (!key) {
      throw new Error(`Unknown key ${keyId}`);
    }

    return Buffer.from(key, "utf8");
  }
}

const roleMatrix: Record<Role, string[]> = {
  Member: ["/api/v1/profile/me:GET", "/api/v1/profile/me:PATCH"],
  Creator: [
    "/api/v1/profile/me:GET",
    "/api/v1/profile/me:PATCH",
    "/api/v1/creator/stacks/publish:POST"
  ],
  Moderator: ["/api/v1/moderation/profiles/:userId:GET"],
  Admin: [
    "/api/v1/moderation/profiles/:userId:GET",
    "/api/v1/admin/users/:userId/roles:POST"
  ]
};

test("role allow and deny matrix is enforced across protected routes", () => {
  const roles: Role[] = ["Member", "Creator", "Moderator", "Admin"];

  for (const role of roles) {
    for (const route of protectedRoutes) {
      const logger = new MemoryAuditLogger();
      const identity: IdentityRecord = { userId: "user-1", role };
      const request = {
        requestId: `${role}-${route.method}-${route.route}`,
        route: route.route,
        action: route.action,
        resource: route.resource,
        token: {
          userId: "user-1",
          sessionId: "session-1",
          role: role === "Creator" ? "Member" : role
        },
        lookupIdentity: () => identity,
        auditLogger: logger
      };

      const allowed = roleMatrix[role].includes(`${route.route}:${route.method}`);
      if (allowed) {
        const context = authorize(route.permission)(request);
        assert.equal(context.auth.role, role);
        assert.equal(context.permission, route.permission);
        assert.equal(logger.entries.at(-1)?.outcome, "allowed");
      } else {
        assert.throws(
          () => authorize(route.permission)(request),
          (error) =>
            error instanceof ForbiddenError
            && error.status === 403
            && error.auditEntry.outcome === "denied"
        );
      }
    }
  }
});

test("encrypted sensitive field round-trip returns original plaintext", () => {
  const keyResolver = new StaticKeyResolver({
    "kms:test-key": "test-key-material"
  });
  const crypto = createSensitiveCrypto(keyResolver);
  const ciphertext = crypto.encryptSensitive("migraine history", "kms:test-key");
  const plaintext = crypto.decryptSensitive(ciphertext, "kms:test-key");

  assert.equal(plaintext, "migraine history");

  const encryptedProfile = encryptSensitiveProfile(
    {
      condition: "migraine history",
      lifestyle: "night-shift worker",
      bio: "public biography"
    },
    "kms:test-key",
    keyResolver
  );

  assert.equal(encryptedProfile.bio, "public biography");
  assert.equal(typeof encryptedProfile.condition?.ciphertext, "string");
  assert.equal(typeof encryptedProfile.lifestyle?.ciphertext, "string");

  const decryptedProfile = decryptSensitiveProfile(encryptedProfile, keyResolver);
  assert.deepEqual(decryptedProfile, {
    condition: "migraine history",
    lifestyle: "night-shift worker",
    bio: "public biography"
  });
});

test("unauthorized endpoint access is blocked and audited", () => {
  const logger = new MemoryAuditLogger();

  assert.throws(
    () =>
      authorize("admin:roles:write")({
        requestId: "req-admin-denied",
        route: "/api/v1/admin/users/:userId/roles",
        action: "assign",
        resource: "user-role",
        token: {
          userId: "member-1",
          sessionId: "session-1",
          role: "Member"
        },
        lookupIdentity: () => ({ userId: "member-1", role: "Member" }),
        auditLogger: logger
      }),
    (error) =>
      error instanceof ForbiddenError
      && error.status === 403
      && error.auditEntry.permission === "admin:roles:write"
  );

  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0]?.actor, "member-1");
  assert.equal(logger.entries[0]?.outcome, "denied");
  assert.equal(logger.entries[0]?.requestId, "req-admin-denied");
});

test("corrupted ciphertext fails safely without plaintext leakage", () => {
  const keyResolver = new StaticKeyResolver({
    "kms:test-key": "test-key-material"
  });
  const crypto = createSensitiveCrypto(keyResolver);
  const plaintext = "highly sensitive note";
  const ciphertext = crypto.encryptSensitive(plaintext, "kms:test-key");
  const corruptedCiphertext = `${ciphertext}corrupted`;

  assert.throws(
    () => crypto.decryptSensitive(corruptedCiphertext, "kms:test-key"),
    (error) =>
      error instanceof Error
      && "code" in error
      && error.code === "SENSITIVE_DECRYPT_ERROR"
      && !error.message.includes(plaintext)
  );
});
