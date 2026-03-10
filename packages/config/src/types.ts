export type NodeEnvironment = "development" | "staging" | "production";

export type RuntimeName = "api" | "web";

export type FieldErrorCode = "missing" | "invalid" | "forbidden";

export type ValidationIssue = {
  field: string;
  code: FieldErrorCode;
  message: string;
  received?: string;
};

export type ApiEnv = {
  NODE_ENV: NodeEnvironment;
  API_PORT: number;
  DATABASE_URL: string;
  JWT_SECRET: string;
  ENCRYPTION_KEY_ID: string;
  STRIPE_SECRET_KEY?: string;
};

export type WebEnv = {
  NODE_ENV: NodeEnvironment;
  PUBLIC_API_BASE_URL: string;
  PUBLIC_STRIPE_PUBLISHABLE_KEY?: string;
};

export type EnvLoadOptions = {
  cwd?: string;
  runtimeEnv?: Record<string, string | undefined>;
  envFilePath?: string;
};

export type ConfigHealthEvent = {
  eventName: "chronex.config.health";
  runtime: RuntimeName;
  nodeEnv: NodeEnvironment;
  envFileUsed: boolean;
  source: "process-env" | "env-file+process-env";
  validatedKeys: string[];
  metrics: readonly [
    "config_validation_failures_total",
    "service_startup_success_total"
  ];
};
