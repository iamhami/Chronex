import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { ConfigValidationError } from "./errors.ts";
import type {
  ConfigHealthEvent,
  EnvLoadOptions,
  NodeEnvironment,
  RuntimeName,
  ValidationIssue
} from "./types.ts";

const VALID_NODE_ENVS = new Set<NodeEnvironment>([
  "development",
  "staging",
  "production"
]);

const CONFIG_METRICS: ConfigHealthEvent["metrics"] = [
  "config_validation_failures_total",
  "service_startup_success_total"
];

type RawEnvResolution = {
  envFilePath: string;
  envFileUsed: boolean;
  nodeEnv?: NodeEnvironment;
  rawEnv: Record<string, string | undefined>;
  issues: ValidationIssue[];
};

export function resolveRawEnv(options: EnvLoadOptions = {}): RawEnvResolution {
  const cwd = options.cwd ?? process.cwd();
  const runtimeEnv = { ...(options.runtimeEnv ?? process.env) };
  const configuredEnvFile =
    options.envFilePath ?? runtimeEnv.CHRONEX_ENV_FILE ?? ".env.local";
  const envFilePath = path.resolve(cwd, configuredEnvFile);
  const localEnv = existsSync(envFilePath)
    ? parseEnvFile(readFileSync(envFilePath, "utf8"))
    : {};
  const nodeEnvCandidate = runtimeEnv.NODE_ENV ?? localEnv.NODE_ENV;
  const issues: ValidationIssue[] = [];

  if (!nodeEnvCandidate) {
    return {
      envFilePath,
      envFileUsed: false,
      rawEnv: runtimeEnv,
      issues
    };
  }

  const nodeEnv = parseNodeEnv(nodeEnvCandidate, issues);
  if (!nodeEnv) {
    return {
      envFilePath,
      envFileUsed: false,
      rawEnv: runtimeEnv,
      issues
    };
  }

  const envFileWasExplicitlyRequested = Boolean(
    options.envFilePath ?? runtimeEnv.CHRONEX_ENV_FILE
  );
  const nodeEnvWasSourcedFromFile =
    !runtimeEnv.NODE_ENV && Boolean(localEnv.NODE_ENV);

  if (nodeEnv !== "development" && envFileWasExplicitlyRequested) {
    issues.push({
      field: "CHRONEX_ENV_FILE",
      code: "forbidden",
      message:
        "Local environment files are forbidden when NODE_ENV is staging or production.",
      received: runtimeEnv.CHRONEX_ENV_FILE ?? options.envFilePath ?? envFilePath
    });
  }

  if (nodeEnv !== "development" && nodeEnvWasSourcedFromFile) {
    issues.push({
      field: "NODE_ENV",
      code: "forbidden",
      message:
        "NODE_ENV for staging or production must come from runtime injection, not .env.local.",
      received: localEnv.NODE_ENV
    });
  }

  const envFileUsed = nodeEnv === "development" && Object.keys(localEnv).length > 0;
  const rawEnv = envFileUsed ? { ...localEnv, ...runtimeEnv } : runtimeEnv;

  return {
    envFilePath,
    envFileUsed,
    nodeEnv,
    rawEnv,
    issues
  };
}

export function parseNodeEnv(
  value: string,
  issues: ValidationIssue[]
): NodeEnvironment | undefined {
  if (VALID_NODE_ENVS.has(value as NodeEnvironment)) {
    return value as NodeEnvironment;
  }

  issues.push({
    field: "NODE_ENV",
    code: "invalid",
    message: "NODE_ENV must be one of development, staging, or production.",
    received: value
  });

  return undefined;
}

export function readRequiredString(
  rawEnv: Record<string, string | undefined>,
  field: string,
  issues: ValidationIssue[]
): string | undefined {
  const value = rawEnv[field]?.trim();

  if (!value) {
    issues.push({
      field,
      code: "missing",
      message: `${field} is required.`
    });
    return undefined;
  }

  return value;
}

export function readOptionalString(
  rawEnv: Record<string, string | undefined>,
  field: string
): string | undefined {
  const value = rawEnv[field]?.trim();
  return value ? value : undefined;
}

export function readRequiredPort(
  rawEnv: Record<string, string | undefined>,
  field: string,
  issues: ValidationIssue[]
): number | undefined {
  const value = readRequiredString(rawEnv, field, issues);
  if (!value) {
    return undefined;
  }

  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    issues.push({
      field,
      code: "invalid",
      message: `${field} must be a positive integer.`,
      received: value
    });
    return undefined;
  }

  return parsedValue;
}

export function assertNoIssues(
  issues: ValidationIssue[]
): asserts issues is ValidationIssue[] {
  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
}

export function buildConfigHealthEvent(
  runtime: RuntimeName,
  nodeEnv: NodeEnvironment,
  envFileUsed: boolean,
  validatedKeys: string[]
): ConfigHealthEvent {
  return {
    eventName: "chronex.config.health",
    runtime,
    nodeEnv,
    envFileUsed,
    source: envFileUsed ? "env-file+process-env" : "process-env",
    validatedKeys,
    metrics: CONFIG_METRICS
  };
}

function parseEnvFile(source: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const line of source.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/gu, "");

    env[key] = value;
  }

  return env;
}
