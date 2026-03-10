import assert from "node:assert/strict";
import test from "node:test";

import { AuthError, AuthService } from "../src/index.ts";

function createService() {
  let now = 1_700_000_000_000;

  return {
    advance(ms: number) {
      now += ms;
    },
    service: new AuthService({
      jwtSecret: "chronex-test-secret",
      lockoutThreshold: 3,
      lockoutDurationMs: 60_000,
      rateLimitMaxAttempts: 10,
      rateLimitWindowMs: 60_000,
      now: () => now
    })
  };
}

test("happy path registration and login work for Member and Creator", () => {
  const { service } = createService();

  const memberRegistration = service.register(
    {
      email: "member@example.com",
      password: "MemberPassword!123",
      role: "Member"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "member-device"
    }
  );

  assert.equal(memberRegistration.role, "Member");
  assert.deepEqual(memberRegistration.permissions, [
    "profile:read:self",
    "profile:write:self"
  ]);

  const memberLogin = service.login(
    {
      email: "member@example.com",
      password: "MemberPassword!123"
    },
    {
      ipAddress: "127.0.0.2",
      fingerprint: "member-device-2"
    }
  );

  assert.equal(memberLogin.role, "Member");
  assert.deepEqual(memberLogin.permissions, [
    "profile:read:self",
    "profile:write:self"
  ]);

  const creatorRegistration = service.register(
    {
      email: "creator@example.com",
      password: "CreatorPassword!123",
      role: "Creator"
    },
    {
      ipAddress: "127.0.0.3",
      fingerprint: "creator-device"
    }
  );

  assert.equal(creatorRegistration.role, "Creator");
  assert.deepEqual(creatorRegistration.permissions, [
    "profile:read:self",
    "profile:write:self",
    "creator:stack:publish"
  ]);
});

test("duplicate email registration is blocked with EMAIL_ALREADY_EXISTS", () => {
  const { service } = createService();

  service.register(
    {
      email: "duplicate@example.com",
      password: "Password!123",
      role: "Member"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "first-device"
    }
  );

  assert.throws(
    () =>
      service.register(
        {
          email: "duplicate@example.com",
          password: "Password!123",
          role: "Creator"
        },
        {
          ipAddress: "127.0.0.2",
          fingerprint: "second-device"
        }
      ),
    (error) =>
      error instanceof AuthError
      && error.code === "EMAIL_ALREADY_EXISTS"
      && error.status === 409
  );
});

test("incorrect password attempts trigger the lockout window and audit events", () => {
  const { service, advance } = createService();

  service.register(
    {
      email: "lockout@example.com",
      password: "CorrectPassword!123",
      role: "Member"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "lockout-device"
    }
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () =>
        service.login(
          {
            email: "lockout@example.com",
            password: "WrongPassword!123"
          },
          {
            ipAddress: "127.0.0.1",
            fingerprint: "lockout-device"
          }
        ),
      (error) =>
        error instanceof AuthError
        && error.code === "INVALID_CREDENTIALS"
    );
  }

  assert.throws(
    () =>
      service.login(
        {
          email: "lockout@example.com",
          password: "WrongPassword!123"
        },
        {
          ipAddress: "127.0.0.1",
          fingerprint: "lockout-device"
        }
      ),
    (error) =>
      error instanceof AuthError
      && error.code === "ACCOUNT_LOCKED"
      && error.status === 423
  );

  assert.throws(
    () =>
      service.login(
        {
          email: "lockout@example.com",
          password: "CorrectPassword!123"
        },
        {
          ipAddress: "127.0.0.1",
          fingerprint: "lockout-device"
        }
      ),
    (error) =>
      error instanceof AuthError
      && error.code === "ACCOUNT_LOCKED"
  );

  const eventTypes = service.listAuditEvents().map((event) => event.type);
  assert.ok(eventTypes.includes("login_failure"));
  assert.ok(eventTypes.includes("account_locked"));

  advance(60_001);

  const unlockedLogin = service.login(
    {
      email: "lockout@example.com",
      password: "CorrectPassword!123"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "lockout-device"
    }
  );

  assert.equal(unlockedLogin.role, "Member");
});

test("role propagation is preserved in auth responses and middleware context", () => {
  const { service } = createService();

  const response = service.register(
    {
      email: "creator-context@example.com",
      password: "CreatorPassword!123",
      role: "Creator"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "creator-context-device"
    }
  );

  assert.equal(response.role, "Creator");
  assert.ok(response.permissions.includes("creator:stack:publish"));

  const context = service.authenticateAccessToken(response.accessToken);
  assert.equal(context.userId, response.userId);
  assert.equal(context.role, "Creator");
  assert.deepEqual(context.permissions, response.permissions);
});

test("refresh rotation and logout revocation behave correctly", () => {
  const { service } = createService();

  const response = service.register(
    {
      email: "refresh@example.com",
      password: "RefreshPassword!123",
      role: "Member"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "refresh-device"
    }
  );

  const refreshed = service.refresh({
    refreshToken: response.refreshToken,
    ipAddress: "127.0.0.1",
    fingerprint: "refresh-device"
  });

  assert.equal(refreshed.userId, response.userId);
  assert.notEqual(refreshed.refreshToken, response.refreshToken);

  assert.throws(
    () =>
      service.refresh({
        refreshToken: response.refreshToken,
        ipAddress: "127.0.0.1",
        fingerprint: "refresh-device"
      }),
    (error) =>
      error instanceof AuthError
      && error.code === "INVALID_CREDENTIALS"
  );

  const logoutResult = service.logout({
    refreshToken: refreshed.refreshToken,
    ipAddress: "127.0.0.1",
    fingerprint: "refresh-device"
  });

  assert.deepEqual(logoutResult, { ok: true });

  assert.throws(
    () =>
      service.refresh({
        refreshToken: refreshed.refreshToken,
        ipAddress: "127.0.0.1",
        fingerprint: "refresh-device"
      }),
    (error) =>
      error instanceof AuthError
      && error.code === "INVALID_CREDENTIALS"
  );
});
