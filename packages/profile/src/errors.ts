import type { ProfileErrorCode } from "./types.ts";

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  readonly status: number;

  constructor(
    code: ProfileErrorCode,
    message: string,
    status: number,
    cause?: unknown
  ) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    this.status = status;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}
