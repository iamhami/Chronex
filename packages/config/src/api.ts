import {
  assertNoIssues,
  buildConfigHealthEvent,
  parseNodeEnv,
  readOptionalString,
  readRequiredPort,
  readRequiredString,
  resolveRawEnv
} from "./shared.ts";
import type { ApiEnv, ConfigHealthEvent, EnvLoadOptions } from "./types.ts";

export type LoadedApiEnv = {
  env: ApiEnv;
  healthEvent: ConfigHealthEvent;
};

export function inspectApiEnv(options: EnvLoadOptions = {}): LoadedApiEnv {
  const resolution = resolveRawEnv(options);
  const issues = [...resolution.issues];
  const nodeEnv = resolution.nodeEnv
    ?? parseNodeEnv(resolution.rawEnv.NODE_ENV ?? "", issues);
  const apiPort = readRequiredPort(resolution.rawEnv, "API_PORT", issues);
  const databaseUrl = readRequiredString(resolution.rawEnv, "DATABASE_URL", issues);
  const jwtSecret = readRequiredString(resolution.rawEnv, "JWT_SECRET", issues);
  const encryptionKeyId = readRequiredString(
    resolution.rawEnv,
    "ENCRYPTION_KEY_ID",
    issues
  );
  const stripeSecretKey = readOptionalString(
    resolution.rawEnv,
    "STRIPE_SECRET_KEY"
  );

  assertNoIssues(issues);

  const env: ApiEnv = {
    NODE_ENV: nodeEnv as ApiEnv["NODE_ENV"],
    API_PORT: apiPort as number,
    DATABASE_URL: databaseUrl as string,
    JWT_SECRET: jwtSecret as string,
    ENCRYPTION_KEY_ID: encryptionKeyId as string
  };

  if (stripeSecretKey) {
    env.STRIPE_SECRET_KEY = stripeSecretKey;
  }

  return {
    env,
    healthEvent: buildConfigHealthEvent(
      "api",
      env.NODE_ENV,
      resolution.envFileUsed,
      [
        "NODE_ENV",
        "API_PORT",
        "DATABASE_URL",
        "JWT_SECRET",
        "ENCRYPTION_KEY_ID",
        "STRIPE_SECRET_KEY"
      ]
    )
  };
}

export function loadApiEnv(options: EnvLoadOptions = {}): ApiEnv {
  return inspectApiEnv(options).env;
}
