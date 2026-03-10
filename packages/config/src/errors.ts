import type { ValidationIssue } from "./types.ts";

export class ConfigValidationError extends Error {
  readonly code = "CONFIG_VALIDATION_ERROR";
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super("Environment validation failed");
    this.name = "ConfigValidationError";
    this.issues = issues;
  }

  toJSON() {
    return {
      code: this.code,
      issues: this.issues
    };
  }
}
