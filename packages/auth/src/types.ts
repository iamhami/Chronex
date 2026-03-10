export type Role = "Member" | "Creator" | "Moderator" | "Admin";

export type RegisterableRole = Extract<Role, "Member" | "Creator">;

export type Permission =
  | "profile:read:self"
  | "profile:write:self"
  | "creator:stack:publish"
  | "profile:read:any"
  | "admin:roles:write";

export type RegisterRequest = {
  email: string;
  password: string;
  role: RegisterableRole;
};

export type LoginRequest = {
  email: string;
  password: string;
};

export type RequestMeta = {
  ipAddress: string;
  fingerprint: string;
};

export type AuthResponse = {
  userId: string;
  role: Role;
  accessToken: string;
  refreshToken: string;
  permissions: Permission[];
  sessionId: string;
  expiresInSeconds: number;
  refreshExpiresInSeconds: number;
};

export type LogoutRequest = {
  refreshToken: string;
} & RequestMeta;

export type RefreshRequest = {
  refreshToken: string;
} & RequestMeta;

export type AuthContext = {
  userId: string;
  role: Role;
  sessionId: string;
  permissions: Permission[];
};

export type AuthUserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  failedLoginCount: number;
  lockedUntil?: number;
  createdAt: number;
};

export type AuthSessionRecord = {
  id: string;
  userId: string;
  refreshTokenHash: string;
  refreshVersion: number;
  refreshExpiresAt: number;
  fingerprint: string;
  ipAddress: string;
  revokedAt?: number;
  createdAt: number;
};

export type AuthEventType =
  | "register_success"
  | "register_failure"
  | "login_success"
  | "login_failure"
  | "account_locked"
  | "logout"
  | "refresh_success"
  | "rate_limited";

export type AuthAuditEvent = {
  type: AuthEventType;
  email?: string;
  userId?: string;
  sessionId?: string;
  role?: Role;
  fingerprint: string;
  ipAddress: string;
  timestamp: number;
  outcome: "success" | "failure";
  reason?: string;
};

export type AuthErrorCode =
  | "EMAIL_ALREADY_EXISTS"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_LOCKED"
  | "RATE_LIMITED";

export type AccessTokenPayload = {
  type: "access";
  userId: string;
  role: Role;
  sessionId: string;
  permissions: Permission[];
  iat: number;
  exp: number;
};

export type RefreshTokenPayload = {
  type: "refresh";
  userId: string;
  sessionId: string;
  version: number;
  iat: number;
  exp: number;
};
