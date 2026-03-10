export type Role = "Member" | "Creator" | "Moderator" | "Admin";

export type Permission =
  | "profile:read:self"
  | "profile:write:self"
  | "profile:read:any"
  | "creator:stack:publish"
  | "admin:roles:write";

export type ProtectedRoute = {
  action: string;
  method: "GET" | "PATCH" | "POST";
  permission: Permission;
  resource: string;
  route: string;
};

export type AuthContext = {
  userId: string;
  role: Role;
  sessionId: string;
  permissions: Permission[];
};

export type TokenClaims = {
  userId: string;
  sessionId: string;
  role?: Role;
};

export type IdentityRecord = {
  userId: string;
  role?: Role;
  permissions?: Permission[];
};

export type AuthorizationRequest = {
  requestId: string;
  route: string;
  action: string;
  resource: string;
  token?: TokenClaims | null;
  lookupIdentity: (userId: string) => IdentityRecord | null;
  auditLogger?: AuditLogger;
};

export type AuthorizationContext = {
  auth: AuthContext;
  permission: Permission;
  requestId: string;
  route: string;
  action: string;
  resource: string;
};

export type AuthorizationDecision = {
  allowed: boolean;
  reason:
    | "allowed"
    | "missing_token"
    | "missing_identity"
    | "missing_role"
    | "missing_permission";
};

export type AuditEntry = {
  actor: string;
  action: string;
  resource: string;
  requestId: string;
  permission: Permission;
  outcome: "allowed" | "denied";
  timestamp: string;
  role?: Role;
};

export type AuditLogger = {
  record(entry: AuditEntry): void;
};

export type KeyResolver = {
  resolveKey(keyId: string): Uint8Array;
};

export type SensitiveProfileInput = {
  condition?: string;
  lifestyle?: string;
  bio?: string;
};

export type EncryptedSensitiveField = {
  keyId: string;
  ciphertext: string;
};

export type EncryptedProfileRecord = {
  bio?: string;
  condition?: EncryptedSensitiveField;
  lifestyle?: EncryptedSensitiveField;
};
