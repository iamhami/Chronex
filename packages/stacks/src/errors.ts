import type { StackErrorCode } from "./types.ts";

export class StackError extends Error {
  readonly code: StackErrorCode;
  readonly status: number;

  constructor(code: StackErrorCode, message: string, status: number) {
    super(message);
    this.name = "StackError";
    this.code = code;
    this.status = status;
  }
}
