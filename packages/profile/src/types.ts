export type ProfileRequestMeta = {
  ipAddress: string;
  fingerprint: string;
};

export type ConsentStatus = "active" | "revoked";

export type SeverityBand = "low" | "medium" | "high";

export type ConsentRecord = {
  userId: string;
  policyVersion: string;
  acceptedAt: string;
  revokedAt?: string;
  status: ConsentStatus;
};

export type ConsentEventType = "accepted" | "revoked";

export type ConsentEventRecord = {
  id: string;
  userId: string;
  policyVersion: string;
  type: ConsentEventType;
  timestamp: string;
  fingerprint: string;
  ipAddress: string;
};

export type UserProfile = {
  userId: string;
  conditionPrimary: string;
  severityBand: SeverityBand;
  symptomTags: string[];
  lifestyleTags: string[];
};

export type StoredUserProfileRecord = {
  userId: string;
  keyId: string;
  consentPolicyVersion: string;
  conditionPrimaryCiphertext: string;
  severityBandCiphertext: string;
  symptomTagsCiphertext: string;
  lifestyleTagsCiphertext: string;
  updatedAt: string;
};

export type ProfileChangeLogRecord = {
  id: string;
  userId: string;
  consentPolicyVersion: string;
  keyId: string;
  changedAt: string;
  snapshot: StoredUserProfileRecord;
};

export type ProfileChangeLogEntry = {
  id: string;
  userId: string;
  consentPolicyVersion: string;
  keyId: string;
  changedAt: string;
  profile: UserProfile;
};

export type ProfileAuditEventType =
  | "consent_accepted"
  | "consent_revoked"
  | "profile_updated"
  | "profile_read"
  | "consent_enforcement_denied";

export type ProfileAuditEvent = {
  type: ProfileAuditEventType;
  userId: string;
  timestamp: string;
  fingerprint: string;
  ipAddress: string;
  outcome: "success" | "failure";
  reason?: string;
};

export type AcceptConsentRequest = {
  userId: string;
  policyVersion: string;
};

export type RevokeConsentRequest = {
  userId: string;
};

export type UpdateProfileRequest = {
  userId: string;
  conditionPrimary?: string;
  severityBand?: SeverityBand;
  symptomTags?: string[];
  lifestyleTags?: string[];
};

export type GetProfileRequest = {
  userId: string;
};

export type ProfileMetricName =
  | "consent_accept_total"
  | "consent_revoke_total"
  | "profile_update_success_total"
  | "consent_enforcement_denied_total";

export type ProfileMetricsSnapshot = Record<ProfileMetricName, number>;

export type ProfileErrorCode =
  | "CONSENT_REQUIRED"
  | "CONSENT_REVOKED"
  | "PROFILE_VALIDATION_ERROR";

export type SensitiveFieldCipher = {
  keyId: string;
  encrypt(value: string): string;
  decrypt(value: string): string;
};
