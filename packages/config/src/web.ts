import {
  assertNoIssues,
  buildConfigHealthEvent,
  parseNodeEnv,
  readOptionalString,
  readRequiredString,
  resolveRawEnv
} from "./shared.ts";
import type { ConfigHealthEvent, EnvLoadOptions, WebEnv } from "./types.ts";

export type LoadedWebEnv = {
  env: WebEnv;
  healthEvent: ConfigHealthEvent;
};

export function inspectWebEnv(options: EnvLoadOptions = {}): LoadedWebEnv {
  const resolution = resolveRawEnv(options);
  const issues = [...resolution.issues];
  const nodeEnv = resolution.nodeEnv
    ?? parseNodeEnv(resolution.rawEnv.NODE_ENV ?? "", issues);
  const publicApiBaseUrl = readRequiredString(
    resolution.rawEnv,
    "PUBLIC_API_BASE_URL",
    issues
  );
  const publicStripePublishableKey = readOptionalString(
    resolution.rawEnv,
    "PUBLIC_STRIPE_PUBLISHABLE_KEY"
  );

  assertNoIssues(issues);

  const env: WebEnv = {
    NODE_ENV: nodeEnv as WebEnv["NODE_ENV"],
    PUBLIC_API_BASE_URL: publicApiBaseUrl as string
  };

  if (publicStripePublishableKey) {
    env.PUBLIC_STRIPE_PUBLISHABLE_KEY = publicStripePublishableKey;
  }

  return {
    env,
    healthEvent: buildConfigHealthEvent(
      "web",
      env.NODE_ENV,
      resolution.envFileUsed,
      [
        "NODE_ENV",
        "PUBLIC_API_BASE_URL",
        "PUBLIC_STRIPE_PUBLISHABLE_KEY"
      ]
    )
  };
}

export function loadWebEnv(options: EnvLoadOptions = {}): WebEnv {
  return inspectWebEnv(options).env;
}
