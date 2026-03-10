import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { loadApiEnv, inspectApiEnv } from "../src/api.ts";
import { inspectWebEnv } from "../src/web.ts";
import { ConfigValidationError } from "../src/errors.ts";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../", import.meta.url))
);
const validateEnvScript = path.join(repoRoot, "scripts/validate-env.ts");
const tsxBinary = path.join(repoRoot, "node_modules", ".bin", "tsx");

function makeTempDir(t: TestContext): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "chronex-env-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeLocalEnv(directory: string, content: string): void {
  writeFileSync(path.join(directory, ".env.local"), content);
}

test("api startup exits non-zero when a required key is missing", (t) => {
  const directory = makeTempDir(t);
  writeLocalEnv(
    directory,
    [
      "NODE_ENV=development",
      "API_PORT=4000",
      "JWT_SECRET=test-jwt",
      "ENCRYPTION_KEY_ID=chronex-local-key"
    ].join("\n")
  );

  const result = spawnSync(
    tsxBinary,
    [validateEnvScript, "api"],
    {
      cwd: directory,
      env: { ...process.env },
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /CONFIG_VALIDATION_ERROR/u);
  assert.match(result.stderr, /DATABASE_URL/u);
});

test("api validation rejects invalid numeric coercion for API_PORT", (t) => {
  const directory = makeTempDir(t);
  writeLocalEnv(
    directory,
    [
      "NODE_ENV=development",
      "API_PORT=not-a-number",
      "DATABASE_URL=postgres://localhost:5432/chronex",
      "JWT_SECRET=test-jwt",
      "ENCRYPTION_KEY_ID=chronex-local-key"
    ].join("\n")
  );

  assert.throws(
    () => loadApiEnv({ cwd: directory, runtimeEnv: {} }),
    (error) =>
      error instanceof ConfigValidationError
      && error.code === "CONFIG_VALIDATION_ERROR"
      && error.issues.some(
        (issue) => issue.field === "API_PORT" && issue.code === "invalid"
      )
  );
});

test("staging rejects local env file fallback", (t) => {
  const directory = makeTempDir(t);
  writeLocalEnv(
    directory,
    [
      "NODE_ENV=development",
      "API_PORT=4000",
      "DATABASE_URL=postgres://localhost:5432/chronex",
      "JWT_SECRET=test-jwt",
      "ENCRYPTION_KEY_ID=chronex-local-key"
    ].join("\n")
  );

  const result = spawnSync(
    tsxBinary,
    [validateEnvScript, "api"],
    {
      cwd: directory,
      env: {
        ...process.env,
        NODE_ENV: "staging",
        API_PORT: "4100",
        DATABASE_URL: "postgres://staging.example.com:5432/chronex",
        JWT_SECRET: "staging-jwt-secret",
        ENCRYPTION_KEY_ID: "chronex-staging-key",
        CHRONEX_ENV_FILE: ".env.local"
      },
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /CHRONEX_ENV_FILE/u);
  assert.match(result.stderr, /forbidden/u);
});

test("api env loads successfully for local, staging, and production", (t) => {
  const localDirectory = makeTempDir(t);
  writeLocalEnv(
    localDirectory,
    [
      "NODE_ENV=development",
      "API_PORT=4000",
      "DATABASE_URL=postgres://localhost:5432/chronex",
      "JWT_SECRET=local-jwt-secret",
      "ENCRYPTION_KEY_ID=chronex-local-key",
      "STRIPE_SECRET_KEY=sk_test_local"
    ].join("\n")
  );

  const localEnv = inspectApiEnv({ cwd: localDirectory, runtimeEnv: {} });
  assert.equal(localEnv.env.NODE_ENV, "development");
  assert.equal(localEnv.env.API_PORT, 4000);
  assert.equal(localEnv.healthEvent.envFileUsed, true);
  assert.equal(localEnv.healthEvent.source, "env-file+process-env");

  const stagingEnv = inspectApiEnv({
    runtimeEnv: {
      NODE_ENV: "staging",
      API_PORT: "4100",
      DATABASE_URL: "postgres://staging.example.com:5432/chronex",
      JWT_SECRET: "staging-jwt-secret",
      ENCRYPTION_KEY_ID: "chronex-staging-key",
      STRIPE_SECRET_KEY: "sk_test_stage"
    }
  });
  assert.equal(stagingEnv.env.NODE_ENV, "staging");
  assert.equal(stagingEnv.env.API_PORT, 4100);
  assert.equal(stagingEnv.healthEvent.source, "process-env");

  const productionEnv = inspectApiEnv({
    runtimeEnv: {
      NODE_ENV: "production",
      API_PORT: "4200",
      DATABASE_URL: "postgres://prod.example.com:5432/chronex",
      JWT_SECRET: "production-jwt-secret",
      ENCRYPTION_KEY_ID: "chronex-production-key"
    }
  });
  assert.equal(productionEnv.env.NODE_ENV, "production");
  assert.equal(productionEnv.env.API_PORT, 4200);
  assert.equal(productionEnv.healthEvent.source, "process-env");
});

test("web env remains separate from API-only secrets", () => {
  const webEnv = inspectWebEnv({
    runtimeEnv: {
      NODE_ENV: "production",
      PUBLIC_API_BASE_URL: "https://api.chronex.example",
      PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_public",
      DATABASE_URL: "postgres://should-not-be-exposed",
      JWT_SECRET: "should-not-be-exposed"
    }
  });

  assert.equal(webEnv.env.NODE_ENV, "production");
  assert.equal(webEnv.env.PUBLIC_API_BASE_URL, "https://api.chronex.example");
  assert.equal(webEnv.healthEvent.runtime, "web");
  assert.equal("DATABASE_URL" in webEnv.env, false);
  assert.equal("JWT_SECRET" in webEnv.env, false);
});
