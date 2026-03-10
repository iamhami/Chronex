import { createServer } from "node:http";

import { AuthService } from "../../../packages/auth/src/index.ts";
import { loadEnv } from "./env.ts";
import { ProfileService } from "../../../packages/profile/src/index.ts";
import {
  createSensitiveFieldCipher,
  InMemoryKeyManagementService,
  SecurityTelemetry,
  SensitiveCryptoService
} from "../../../packages/security/src/index.ts";
import { StackDraftService } from "../../../packages/stacks/src/index.ts";
import { createApiApp } from "./app.ts";

export function startApiServer(): void {
  const env = loadEnv();
  const telemetry = new SecurityTelemetry();
  const cryptoService = new SensitiveCryptoService({
    keyManagementService: new InMemoryKeyManagementService({
      [env.ENCRYPTION_KEY_ID]: "chronex-local-development-only-key-material"
    }),
    telemetry
  });
  const profileService = new ProfileService({
    activePolicyVersion: "2026-03-01",
    cipher: createSensitiveFieldCipher(env.ENCRYPTION_KEY_ID, cryptoService)
  });
  const authService = new AuthService({
    jwtSecret: env.JWT_SECRET
  });
  const stackService = new StackDraftService();
  const app = createApiApp({
    authService,
    profileService,
    securityTelemetry: telemetry,
    stackService
  });

  createServer(app).listen(env.API_PORT);
}
