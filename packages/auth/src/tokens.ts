import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { AccessTokenPayload, RefreshTokenPayload } from "./types.ts";

type SignedTokenPayload = AccessTokenPayload | RefreshTokenPayload;

export class TokenValidationError extends Error {
  constructor() {
    super("Invalid token.");
    this.name = "TokenValidationError";
  }
}

export function createOpaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function signToken(
  payload: SignedTokenPayload,
  secret: string
): string {
  const header = encodeSegment({ alg: "HS256", typ: "CHRONEX" });
  const body = encodeSegment(payload);
  const signature = signSegments(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

export function verifyAccessToken(
  token: string,
  secret: string,
  nowMs: number
): AccessTokenPayload {
  const payload = verifyToken(token, secret, nowMs);
  if (payload.type !== "access") {
    throw new TokenValidationError();
  }

  return payload;
}

export function verifyRefreshToken(
  token: string,
  secret: string,
  nowMs: number
): RefreshTokenPayload {
  const payload = verifyToken(token, secret, nowMs);
  if (payload.type !== "refresh") {
    throw new TokenValidationError();
  }

  return payload;
}

export function hashToken(token: string): string {
  return createHmac("sha256", "chronex-refresh-hash").update(token).digest("hex");
}

function verifyToken(
  token: string,
  secret: string,
  nowMs: number
): SignedTokenPayload {
  const [header, body, signature] = token.split(".");
  if (!header || !body || !signature) {
    throw new TokenValidationError();
  }

  const expectedSignature = signSegments(`${header}.${body}`, secret);
  const actualSignature = Buffer.from(signature, "base64url");
  const expectedSignatureBuffer = Buffer.from(expectedSignature, "base64url");

  if (
    actualSignature.length !== expectedSignatureBuffer.length
    || !timingSafeEqual(actualSignature, expectedSignatureBuffer)
  ) {
    throw new TokenValidationError();
  }

  const payload = JSON.parse(
    Buffer.from(body, "base64url").toString("utf8")
  ) as SignedTokenPayload;

  if (!payload.exp || nowMs >= payload.exp) {
    throw new TokenValidationError();
  }

  return payload;
}

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signSegments(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}
