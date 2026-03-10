import assert from "node:assert/strict";
import test from "node:test";

import {
  createSensitiveFieldCipher,
  InMemoryKeyManagementService,
  SecurityTelemetry,
  SensitiveCryptoError,
  SensitiveCryptoService
} from "../src/index.ts";

test("sensitive crypto round-trips values through the configured key id", () => {
  const telemetry = new SecurityTelemetry();
  const cryptoService = new SensitiveCryptoService({
    keyManagementService: new InMemoryKeyManagementService({
      "kms-profile-v1": "chronex-local-key"
    }),
    telemetry
  });
  const cipher = createSensitiveFieldCipher("kms-profile-v1", cryptoService);

  const encrypted = cipher.encrypt("arthritis");
  const decrypted = cipher.decrypt(encrypted);

  assert.notEqual(encrypted, "arthritis");
  assert.equal(decrypted, "arthritis");
  assert.deepEqual(telemetry.getMetrics(), {
    rbac_allowed_requests_total: 0,
    rbac_denied_requests_total: 0,
    sensitive_decrypt_failures_total: 0
  });
});

test("decrypt failures increment the security metric and raise a typed error", () => {
  const telemetry = new SecurityTelemetry();
  const cryptoService = new SensitiveCryptoService({
    keyManagementService: new InMemoryKeyManagementService({
      "kms-profile-v1": "chronex-local-key"
    }),
    telemetry
  });

  assert.throws(
    () => cryptoService.decryptSensitive("enc:v1:kms-profile-v1:broken"),
    (error) => error instanceof SensitiveCryptoError
  );

  assert.deepEqual(telemetry.getMetrics(), {
    rbac_allowed_requests_total: 0,
    rbac_denied_requests_total: 0,
    sensitive_decrypt_failures_total: 1
  });
});
