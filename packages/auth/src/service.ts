import type {
  AccessTokenPayload,
  AuthAuditEvent,
  AuthContext,
  AuthResponse,
  AuthSessionRecord,
  AuthUserRecord,
  LoginRequest,
  LogoutRequest,
  Permission,
  RefreshRequest,
  RefreshTokenPayload,
  RegisterRequest,
  RegisterableRole,
  RequestMeta,
  Role
} from "./types.ts";
import { AuthError } from "./errors.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { InMemoryAuthStore } from "./store.ts";
import {
  createOpaqueId,
  hashToken,
  signToken,
  verifyAccessToken,
  verifyRefreshToken
} from "./tokens.ts";

type AuthServiceOptions = {
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  jwtSecret: string;
  lockoutDurationMs?: number;
  lockoutThreshold?: number;
  now?: () => number;
  rateLimitMaxAttempts?: number;
  rateLimitWindowMs?: number;
  store?: InMemoryAuthStore;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const DEFAULT_ACCESS_TTL_SECONDS = 900;
const DEFAULT_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const DEFAULT_LOCKOUT_THRESHOLD = 3;
const DEFAULT_RATE_LIMIT_MAX_ATTEMPTS = 5;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

export const rolePermissions: Record<Role, Permission[]> = {
  Member: ["profile:read:self", "profile:write:self"],
  Creator: [
    "profile:read:self",
    "profile:write:self",
    "creator:stack:draft:self",
    "creator:stack:publish"
  ],
  Moderator: ["profile:read:any"],
  Admin: ["profile:read:any", "creator:stack:draft:any", "admin:roles:write"]
};

export class AuthService {
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;
  private readonly jwtSecret: string;
  private readonly lockoutDurationMs: number;
  private readonly lockoutThreshold: number;
  private readonly now: () => number;
  private readonly rateLimitMaxAttempts: number;
  private readonly rateLimitWindowMs: number;
  private readonly rateLimits = new Map<string, RateLimitBucket>();
  readonly store: InMemoryAuthStore;

  constructor(options: AuthServiceOptions) {
    this.accessTokenTtlSeconds =
      options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS;
    this.refreshTokenTtlSeconds =
      options.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS;
    this.jwtSecret = options.jwtSecret;
    this.lockoutDurationMs =
      options.lockoutDurationMs ?? DEFAULT_LOCKOUT_DURATION_MS;
    this.lockoutThreshold =
      options.lockoutThreshold ?? DEFAULT_LOCKOUT_THRESHOLD;
    this.now = options.now ?? Date.now;
    this.rateLimitMaxAttempts =
      options.rateLimitMaxAttempts ?? DEFAULT_RATE_LIMIT_MAX_ATTEMPTS;
    this.rateLimitWindowMs =
      options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    this.store = options.store ?? new InMemoryAuthStore();
  }

  register(request: RegisterRequest, meta: RequestMeta): AuthResponse {
    this.guardRateLimit(request.email, meta);

    const email = normalizeEmail(request.email);
    const existingUser = this.store.findUserByEmail(email);
    if (existingUser) {
      throw this.fail("EMAIL_ALREADY_EXISTS", 409, "Email already exists.", {
        email,
        ...meta
      });
    }

    const timestamp = this.now();
    const user: AuthUserRecord = {
      id: createOpaqueId("usr"),
      email,
      passwordHash: hashPassword(request.password),
      role: request.role,
      failedLoginCount: 0,
      createdAt: timestamp
    };
    this.store.saveUser(user);

    const { session, response } = this.createSession(user, meta, 0, timestamp);

    this.store.appendEvent({
      type: "register_success",
      email,
      userId: user.id,
      sessionId: session.id,
      role: user.role,
      fingerprint: meta.fingerprint,
      ipAddress: meta.ipAddress,
      timestamp,
      outcome: "success"
    });

    return response;
  }

  login(request: LoginRequest, meta: RequestMeta): AuthResponse {
    this.guardRateLimit(request.email, meta);

    const email = normalizeEmail(request.email);
    const user = this.store.findUserByEmail(email);
    const timestamp = this.now();

    if (!user) {
      throw this.fail("INVALID_CREDENTIALS", 401, "Invalid credentials.", {
        email,
        ...meta
      });
    }

    if (user.lockedUntil && user.lockedUntil > timestamp) {
      throw this.fail("ACCOUNT_LOCKED", 423, "Account locked.", {
        email,
        userId: user.id,
        role: user.role,
        ...meta
      });
    }

    if (!verifyPassword(request.password, user.passwordHash)) {
      user.failedLoginCount += 1;

      if (user.failedLoginCount >= this.lockoutThreshold) {
        user.lockedUntil = timestamp + this.lockoutDurationMs;
        this.store.saveUser(user);
        this.store.appendEvent({
          type: "account_locked",
          email,
          userId: user.id,
          role: user.role,
          fingerprint: meta.fingerprint,
          ipAddress: meta.ipAddress,
          timestamp,
          outcome: "failure",
          reason: "lockout_threshold_reached"
        });

        throw new AuthError("ACCOUNT_LOCKED", "Account locked.", 423);
      }

      this.store.saveUser(user);
      throw this.fail("INVALID_CREDENTIALS", 401, "Invalid credentials.", {
        email,
        userId: user.id,
        role: user.role,
        ...meta
      });
    }

    user.failedLoginCount = 0;
    user.lockedUntil = undefined;
    this.store.saveUser(user);

    const { session, response } = this.createSession(user, meta, 0, timestamp);

    this.store.appendEvent({
      type: "login_success",
      email,
      userId: user.id,
      sessionId: session.id,
      role: user.role,
      fingerprint: meta.fingerprint,
      ipAddress: meta.ipAddress,
      timestamp,
      outcome: "success"
    });

    return response;
  }

  logout(request: LogoutRequest): { ok: true } {
    const timestamp = this.now();

    try {
      const payload = verifyRefreshToken(
        request.refreshToken,
        this.jwtSecret,
        timestamp
      );
      const session = this.store.findSessionById(payload.sessionId);

      if (session && !session.revokedAt) {
        session.revokedAt = timestamp;
        this.store.saveSession(session);
        this.store.appendEvent({
          type: "logout",
          userId: session.userId,
          sessionId: session.id,
          fingerprint: request.fingerprint,
          ipAddress: request.ipAddress,
          timestamp,
          outcome: "success"
        });
      }
    } catch {
      return { ok: true };
    }

    return { ok: true };
  }

  refresh(request: RefreshRequest): AuthResponse {
    this.guardRateLimit("refresh", request);

    const timestamp = this.now();
    let payload: RefreshTokenPayload;

    try {
      payload = verifyRefreshToken(request.refreshToken, this.jwtSecret, timestamp);
    } catch {
      throw this.fail("INVALID_CREDENTIALS", 401, "Invalid credentials.", request);
    }

    const session = this.store.findSessionById(payload.sessionId);
    const user = session ? this.store.findUserById(session.userId) : undefined;

    if (
      !session
      || !user
      || session.revokedAt
      || session.refreshExpiresAt <= timestamp
      || session.refreshVersion !== payload.version
      || session.refreshTokenHash !== hashToken(request.refreshToken)
    ) {
      throw this.fail("INVALID_CREDENTIALS", 401, "Invalid credentials.", {
        email: user?.email,
        userId: user?.id,
        role: user?.role,
        ...request
      });
    }

    // Rotate the refresh chain on every successful refresh so older tokens
    // cannot be replayed after a later refresh succeeds.
    session.refreshVersion += 1;
    session.refreshExpiresAt =
      timestamp + this.refreshTokenTtlSeconds * 1000;
    session.refreshTokenHash = hashToken(
      signToken(
        {
          type: "refresh",
          userId: user.id,
          sessionId: session.id,
          version: session.refreshVersion,
          iat: timestamp,
          exp: session.refreshExpiresAt
        },
        this.jwtSecret
      )
    );

    const response = this.buildAuthResponse(user, session, timestamp);
    session.refreshTokenHash = hashToken(response.refreshToken);
    this.store.saveSession(session);

    this.store.appendEvent({
      type: "refresh_success",
      email: user.email,
      userId: user.id,
      sessionId: session.id,
      role: user.role,
      fingerprint: request.fingerprint,
      ipAddress: request.ipAddress,
      timestamp,
      outcome: "success"
    });

    return response;
  }

  authenticateAccessToken(token: string): AuthContext {
    const payload = verifyAccessToken(token, this.jwtSecret, this.now());
    return {
      userId: payload.userId,
      role: payload.role,
      sessionId: payload.sessionId,
      permissions: payload.permissions
    };
  }

  listAuditEvents(): AuthAuditEvent[] {
    return this.store.listEvents();
  }

  private buildAuthResponse(
    user: AuthUserRecord,
    session: AuthSessionRecord,
    timestamp = this.now()
  ): AuthResponse {
    const permissions = resolvePermissions(user.role);
    const accessPayload: AccessTokenPayload = {
      type: "access",
      userId: user.id,
      role: user.role,
      sessionId: session.id,
      permissions,
      iat: timestamp,
      exp: timestamp + this.accessTokenTtlSeconds * 1000
    };
    const refreshPayload: RefreshTokenPayload = {
      type: "refresh",
      userId: user.id,
      sessionId: session.id,
      version: session.refreshVersion,
      iat: timestamp,
      exp: session.refreshExpiresAt
    };

    return {
      userId: user.id,
      role: user.role,
      accessToken: signToken(accessPayload, this.jwtSecret),
      refreshToken: signToken(refreshPayload, this.jwtSecret),
      permissions,
      sessionId: session.id,
      expiresInSeconds: this.accessTokenTtlSeconds,
      refreshExpiresInSeconds: this.refreshTokenTtlSeconds
    };
  }

  private createSession(
    user: AuthUserRecord,
    meta: RequestMeta,
    version: number,
    timestamp: number
  ): { session: AuthSessionRecord; response: AuthResponse } {
    const session: AuthSessionRecord = {
      id: createOpaqueId("sess"),
      userId: user.id,
      refreshTokenHash: "",
      refreshVersion: version,
      refreshExpiresAt: timestamp + this.refreshTokenTtlSeconds * 1000,
      fingerprint: meta.fingerprint,
      ipAddress: meta.ipAddress,
      createdAt: timestamp
    };

    const response = this.buildAuthResponse(user, session, timestamp);
    session.refreshTokenHash = hashToken(response.refreshToken);
    this.store.saveSession(session);
    return { session, response };
  }

  private guardRateLimit(emailOrAction: string, meta: RequestMeta): void {
    const timestamp = this.now();
    for (const key of [
      `ip:${meta.ipAddress}`,
      `email:${normalizeEmail(emailOrAction)}`
    ]) {
      const bucket = this.rateLimits.get(key);
      if (!bucket || bucket.resetAt <= timestamp) {
        this.rateLimits.set(key, {
          count: 1,
          resetAt: timestamp + this.rateLimitWindowMs
        });
        continue;
      }

      if (bucket.count >= this.rateLimitMaxAttempts) {
        this.store.appendEvent({
          type: "rate_limited",
          fingerprint: meta.fingerprint,
          ipAddress: meta.ipAddress,
          timestamp,
          outcome: "failure",
          reason: key
        });
        throw new AuthError("RATE_LIMITED", "Rate limited.", 429);
      }

      bucket.count += 1;
      this.rateLimits.set(key, bucket);
    }
  }

  private fail(
    code: "EMAIL_ALREADY_EXISTS" | "INVALID_CREDENTIALS" | "ACCOUNT_LOCKED",
    status: number,
    message: string,
    event: {
      email?: string;
      userId?: string;
      role?: Role;
    } & RequestMeta
  ): AuthError {
    this.store.appendEvent({
      type: code === "EMAIL_ALREADY_EXISTS" ? "register_failure" : "login_failure",
      email: event.email,
      userId: event.userId,
      role: event.role,
      fingerprint: event.fingerprint,
      ipAddress: event.ipAddress,
      timestamp: this.now(),
      outcome: "failure",
      reason: code
    });

    return new AuthError(code, message, status);
  }
}

export function resolvePermissions(role: Role): Permission[] {
  return [...rolePermissions[role]];
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
