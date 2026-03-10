import type { Permission, Role } from "../../auth/src/types.ts";

export type SecurityMetricName =
  | "rbac_allowed_requests_total"
  | "rbac_denied_requests_total"
  | "sensitive_decrypt_failures_total";

export type SecurityMetricsSnapshot = Record<SecurityMetricName, number>;

export type SecurityAuditEventType =
  | "rbac_allowed"
  | "rbac_denied"
  | "sensitive_decrypt_failure";

export type SecurityAuditEvent = {
  type: SecurityAuditEventType;
  timestamp: string;
  outcome: "success" | "failure";
  actorUserId?: string;
  role?: Role;
  action?: Permission | "authenticate";
  resource?: string;
  requestId?: string;
  ipAddress?: string;
  keyId?: string;
  reason?: string;
};

export type AuthorizationDecisionInput = {
  actorUserId?: string;
  role?: Role;
  action: Permission | "authenticate";
  resource: string;
  requestId: string;
  ipAddress: string;
  outcome: "success" | "failure";
  reason?: string;
  timestamp?: string;
};

export type SensitiveDecryptFailureInput = {
  actorUserId?: string;
  role?: Role;
  resource?: string;
  requestId?: string;
  ipAddress?: string;
  keyId?: string;
  reason: string;
  timestamp?: string;
};

export type KeyManagementService = {
  getKeyMaterial(keyId: string): Buffer;
};

export type SensitiveFieldCipher = {
  keyId: string;
  encrypt(value: string): string;
  decrypt(value: string): string;
};
