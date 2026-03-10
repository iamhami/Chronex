import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  AuthService,
  createOpaqueId,
  hashPassword,
  resolvePermissions,
  signToken
} from "../../../packages/auth/src/index.ts";
import type { AuthUserRecord, Role } from "../../../packages/auth/src/types.ts";
import { ProfileService } from "../../../packages/profile/src/index.ts";
import {
  createSensitiveFieldCipher,
  InMemoryKeyManagementService,
  SecurityTelemetry,
  SensitiveCryptoService
} from "../../../packages/security/src/index.ts";
import { StackDraftService } from "../../../packages/stacks/src/index.ts";
import { createApiApp } from "../src/app.ts";

type RequestOptions = {
  token?: string;
  method?: string;
  body?: object;
  fingerprint?: string;
};

function createHarness() {
  let now = Date.parse("2026-03-10T12:00:00.000Z");
  const telemetry = new SecurityTelemetry();
  const authService = new AuthService({
    jwtSecret: "chronex-test-secret",
    now: () => now,
    rateLimitMaxAttempts: 20,
    rateLimitWindowMs: 60_000
  });
  const cryptoService = new SensitiveCryptoService({
    keyManagementService: new InMemoryKeyManagementService({
      "kms-profile-v1": "chronex-local-development-only-key-material"
    }),
    telemetry
  });
  const profileService = new ProfileService({
    activePolicyVersion: "2026-03-01",
    cipher: createSensitiveFieldCipher("kms-profile-v1", cryptoService),
    now: () => now
  });
  const stackService = new StackDraftService({
    now: () => now
  });
  const app = createApiApp({
    authService,
    profileService,
    securityTelemetry: telemetry,
    stackService
  });

  return {
    advance(ms: number) {
      now += ms;
    },
    app,
    authService,
    now: () => now,
    profileService,
    stackService,
    telemetry
  };
}

async function withServer<T>(
  app: ReturnType<typeof createApiApp>,
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

async function request(
  baseUrl: string,
  path: string,
  options: RequestOptions = {}
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      "x-device-fingerprint": options.fingerprint ?? "test-device"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  return {
    status: response.status,
    json: await response.json()
  };
}

function seedUser(
  harness: ReturnType<typeof createHarness>,
  role: Role,
  email: string
): { token: string; user: AuthUserRecord } {
  const user: AuthUserRecord = {
    id: createOpaqueId("usr"),
    email,
    passwordHash: hashPassword("AdminPassword!123"),
    role,
    failedLoginCount: 0,
    createdAt: harness.now()
  };
  harness.authService.store.saveUser(user);

  const token = signToken(
    {
      type: "access",
      userId: user.id,
      role,
      sessionId: createOpaqueId("sess"),
      permissions: resolvePermissions(role),
      iat: harness.now(),
      exp: harness.now() + 900_000
    },
    "chronex-test-secret"
  );

  return { token, user };
}

function createPricingMetadata(overrides: Partial<{
  amountCents: number;
  currency: string;
  internalSku: string;
}> = {}) {
  return {
    amountCents: overrides.amountCents ?? 9900,
    currency: overrides.currency ?? "usd",
    internalSku: overrides.internalSku ?? "STACK-001"
  };
}

function createPublishableDraft(
  harness: ReturnType<typeof createHarness>,
  creator: { userId: string; accessToken: string }
) {
  const actor = {
    userId: creator.userId,
    role: "Creator" as const,
    sessionId: "sess_publish",
    permissions: resolvePermissions("Creator")
  };
  const created = harness.stackService.createDraft(actor, {
    creatorId: creator.userId,
    templateId: "creator-standard"
  });

  return harness.stackService.saveDraft(actor, {
    stackId: created.stackId,
    expectedRevision: created.revision,
    source: "manual",
    sections: created.sections.map((section) => ({
      ...section,
      content: ({
        summary: "Creator summary with creator@example.com and +1 (555) 111-2222.",
        problem: "Users struggle to assemble the right workflow quickly.",
        solution: "Chronex packages the solution as a reusable operating stack.",
        proof: "Used successfully across 32 internal launches.",
        offer: "Annual access includes templates, training, and support."
      })[section.type] ?? section.content
    }))
  });
}

test("express RBAC middleware enforces the allow/deny matrix across protected routes", async () => {
  const harness = createHarness();
  const member = harness.authService.register(
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
  const creator = harness.authService.register(
    {
      email: "creator@example.com",
      password: "CreatorPassword!123",
      role: "Creator"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "creator-device"
    }
  );
  const admin = seedUser(harness, "Admin", "admin@example.com");

  await withServer(harness.app, async (baseUrl) => {
    let response = await request(baseUrl, "/api/v1/profile/consent", {
      method: "POST",
      token: member.accessToken,
      body: {
        policyVersion: "2026-03-01"
      }
    });
    assert.equal(response.status, 200);

    response = await request(baseUrl, "/api/v1/profile/metrics", {
      method: "POST",
      token: member.accessToken,
      body: {
        conditionPrimary: "arthritis",
        severityBand: "medium",
        symptomTags: ["joint-pain"],
        lifestyleTags: ["walking"]
      }
    });
    assert.equal(response.status, 200);

    response = await request(baseUrl, "/api/v1/profile/me", {
      token: member.accessToken
    });
    assert.equal(response.status, 200);

    response = await request(
      baseUrl,
      `/api/v1/profile/${creator.userId}`,
      {
        token: member.accessToken
      }
    );
    assert.equal(response.status, 403);

    response = await request(baseUrl, "/api/v1/creator/publish-capability", {
      token: creator.accessToken
    });
    assert.equal(response.status, 200);

    response = await request(
      baseUrl,
      `/api/v1/profile/${member.userId}`,
      {
        token: admin.token
      }
    );
    assert.equal(response.status, 200);
  });
});

test("role resolution refreshes from the identity store instead of trusting stale token permissions", async () => {
  const harness = createHarness();
  const creator = harness.authService.register(
    {
      email: "stale-creator@example.com",
      password: "CreatorPassword!123",
      role: "Creator"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "creator-device"
    }
  );
  const currentUser = harness.authService.store.findUserById(creator.userId);
  assert.ok(currentUser);
  currentUser.role = "Member";
  harness.authService.store.saveUser(currentUser);

  await withServer(harness.app, async (baseUrl) => {
    const response = await request(
      baseUrl,
      "/api/v1/creator/publish-capability",
      {
        token: creator.accessToken
      }
    );

    assert.equal(response.status, 403);
    assert.equal(
      harness.telemetry
        .listAuditEvents()
        .at(-1)?.reason,
      "permission_denied"
    );
  });
});

test("missing role context returns 403 for otherwise valid tokens", async () => {
  const harness = createHarness();
  const creator = harness.authService.register(
    {
      email: "role-missing@example.com",
      password: "CreatorPassword!123",
      role: "Creator"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "creator-device"
    }
  );
  const currentUser = harness.authService.store.findUserById(creator.userId);
  assert.ok(currentUser);
  (currentUser as AuthUserRecord & { role?: Role }).role = undefined;
  harness.authService.store.saveUser(currentUser);

  await withServer(harness.app, async (baseUrl) => {
    const response = await request(baseUrl, "/api/v1/profile/me", {
      token: creator.accessToken
    });

    assert.equal(response.status, 403);
    assert.equal(
      harness.telemetry
        .listAuditEvents()
        .at(-1)?.reason,
      "identity_role_missing"
    );
  });
});

test("unauthorized admin route access is denied and audited", async () => {
  const harness = createHarness();
  const creator = harness.authService.register(
    {
      email: "creator-audit@example.com",
      password: "CreatorPassword!123",
      role: "Creator"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "creator-device"
    }
  );

  await withServer(harness.app, async (baseUrl) => {
    const response = await request(
      baseUrl,
      "/api/v1/admin/security/metrics",
      {
        token: creator.accessToken
      }
    );

    assert.equal(response.status, 403);
    const event = harness.telemetry
      .listAuditEvents()
      .find((entry) => entry.resource === "/api/v1/admin/security/metrics");
    assert.ok(event);
    assert.equal(event?.type, "rbac_denied");
    assert.equal(event?.action, "admin:roles:write");
  });
});

test("corrupted sensitive ciphertext returns 500 without leaking plaintext and records the incident", async () => {
  const harness = createHarness();
  const member = harness.authService.register(
    {
      email: "member-corrupt@example.com",
      password: "MemberPassword!123",
      role: "Member"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "member-device"
    }
  );

  await withServer(harness.app, async (baseUrl) => {
    let response = await request(baseUrl, "/api/v1/profile/consent", {
      method: "POST",
      token: member.accessToken,
      body: {
        policyVersion: "2026-03-01"
      }
    });
    assert.equal(response.status, 200);

    response = await request(baseUrl, "/api/v1/profile/metrics", {
      method: "POST",
      token: member.accessToken,
      body: {
        conditionPrimary: "arthritis",
        severityBand: "high",
        symptomTags: ["joint-pain"],
        lifestyleTags: ["stretching"]
      }
    });
    assert.equal(response.status, 200);

    const stored = harness.profileService.store.findProfileByUserId(member.userId);
    assert.ok(stored);
    stored.conditionPrimaryCiphertext = "enc:v1:kms-profile-v1:broken";
    harness.profileService.store.saveProfile(stored);

    response = await request(baseUrl, "/api/v1/profile/me", {
      token: member.accessToken
    });
    assert.equal(response.status, 500);
    const body = response.json as {
      error: { code: string; message: string };
    };
    assert.equal(body.error.code, "PROFILE_VALIDATION_ERROR");
    assert.ok(!JSON.stringify(body).includes("arthritis"));
    assert.deepEqual(harness.telemetry.getMetrics(), {
      rbac_allowed_requests_total: 3,
      rbac_denied_requests_total: 0,
      sensitive_decrypt_failures_total: 1
    });
    assert.equal(
      harness.telemetry
        .listAuditEvents()
        .at(-1)?.type,
      "sensitive_decrypt_failure"
    );
  });
});

test("creator publish endpoint returns a versioned redacted artifact", async () => {
  const harness = createHarness();
  const creator = harness.authService.register(
    {
      email: "publisher@example.com",
      password: "CreatorPassword!123",
      role: "Creator"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "creator-device"
    }
  );
  const draft = createPublishableDraft(harness, creator);

  await withServer(harness.app, async (baseUrl) => {
    const response = await request(
      baseUrl,
      `/api/v1/stacks/${draft.stackId}/publish`,
      {
        method: "POST",
        token: creator.accessToken,
        body: {
          pricingMetadata: createPricingMetadata()
        }
      }
    );

    assert.equal(response.status, 200);
    const body = response.json as {
      artifact: { version: number; pricingMetadata: { currency: string } };
      replayed: boolean;
    };
    assert.equal(body.artifact.version, 1);
    assert.equal(body.artifact.pricingMetadata.currency, "USD");
    assert.equal(body.replayed, false);

    const artifact = harness.stackService.listPublishedArtifactRecords(draft.stackId)[0];
    assert.ok(artifact);
    assert.ok(artifact?.redactedPayload.includes("[REDACTED]"));
    assert.ok(!artifact?.redactedPayload.includes("creator@example.com"));
  });
});

test("publish endpoint rejects incomplete drafts", async () => {
  const harness = createHarness();
  const creator = harness.authService.register(
    {
      email: "publisher-invalid@example.com",
      password: "CreatorPassword!123",
      role: "Creator"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "creator-device"
    }
  );
  const actor = {
    userId: creator.userId,
    role: "Creator" as const,
    sessionId: "sess_publish_invalid",
    permissions: resolvePermissions("Creator")
  };
  const draft = harness.stackService.createDraft(actor, {
    creatorId: creator.userId,
    templateId: "blank"
  });

  await withServer(harness.app, async (baseUrl) => {
    const response = await request(
      baseUrl,
      `/api/v1/stacks/${draft.stackId}/publish`,
      {
        method: "POST",
        token: creator.accessToken,
        body: {
          pricingMetadata: createPricingMetadata()
        }
      }
    );

    assert.equal(response.status, 422);
    const body = response.json as {
      error: { code: string };
    };
    assert.equal(body.error.code, "PUBLISH_VALIDATION_FAILED");
  });
});

test("publish endpoint replays idempotent retries without creating duplicate versions", async () => {
  const harness = createHarness();
  const creator = harness.authService.register(
    {
      email: "publisher-idempotent@example.com",
      password: "CreatorPassword!123",
      role: "Creator"
    },
    {
      ipAddress: "127.0.0.1",
      fingerprint: "creator-device"
    }
  );
  const draft = createPublishableDraft(harness, creator);

  await withServer(harness.app, async (baseUrl) => {
    const first = await request(
      baseUrl,
      `/api/v1/stacks/${draft.stackId}/publish`,
      {
        method: "POST",
        token: creator.accessToken,
        body: {
          requestKey: "publish-api-idempotent",
          pricingMetadata: createPricingMetadata()
        }
      }
    );
    const replay = await request(
      baseUrl,
      `/api/v1/stacks/${draft.stackId}/publish`,
      {
        method: "POST",
        token: creator.accessToken,
        body: {
          requestKey: "publish-api-idempotent",
          pricingMetadata: createPricingMetadata()
        }
      }
    );

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    const replayBody = replay.json as {
      artifact: { version: number };
      replayed: boolean;
    };
    assert.equal(replayBody.artifact.version, 1);
    assert.equal(replayBody.replayed, true);
    assert.equal(harness.stackService.listPublishedArtifacts(draft.stackId).length, 1);
  });
});
