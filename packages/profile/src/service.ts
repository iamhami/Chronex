import { randomUUID } from "node:crypto";

import { ProfileError } from "./errors.ts";
import { InMemoryProfileStore } from "./store.ts";
import type {
  AcceptConsentRequest,
  ConsentEventRecord,
  ConsentRecord,
  GetProfileRequest,
  ProfileAuditEvent,
  ProfileMetricName,
  ProfileMetricsSnapshot,
  ProfileRequestMeta,
  SensitiveFieldCipher,
  SeverityBand,
  StoredUserProfileRecord,
  UpdateProfileRequest,
  UserProfile,
  RevokeConsentRequest,
  ProfileChangeLogEntry
} from "./types.ts";

type ProfileServiceOptions = {
  activePolicyVersion: string;
  cipher: SensitiveFieldCipher;
  now?: () => number;
  store?: InMemoryProfileStore;
};

const EMPTY_METRICS: ProfileMetricsSnapshot = {
  consent_accept_total: 0,
  consent_revoke_total: 0,
  profile_update_success_total: 0,
  consent_enforcement_denied_total: 0
};

const VALID_SEVERITY_BANDS = new Set<SeverityBand>(["low", "medium", "high"]);

export class ProfileService {
  private readonly activePolicyVersion: string;
  private readonly cipher: SensitiveFieldCipher;
  private readonly now: () => number;
  private readonly metrics = new Map<ProfileMetricName, number>();
  readonly store: InMemoryProfileStore;

  constructor(options: ProfileServiceOptions) {
    this.activePolicyVersion = normalizeRequiredText(
      "activePolicyVersion",
      options.activePolicyVersion
    );
    this.cipher = options.cipher;
    this.now = options.now ?? Date.now;
    this.store = options.store ?? new InMemoryProfileStore();

    for (const metricName of Object.keys(EMPTY_METRICS) as ProfileMetricName[]) {
      this.metrics.set(metricName, 0);
    }
  }

  acceptConsent(
    request: AcceptConsentRequest,
    meta: ProfileRequestMeta
  ): ConsentRecord {
    const userId = normalizeRequiredText("userId", request.userId);
    const policyVersion = normalizeRequiredText(
      "policyVersion",
      request.policyVersion
    );

    if (policyVersion !== this.activePolicyVersion) {
      throw new ProfileError(
        "PROFILE_VALIDATION_ERROR",
        "Consent policy version mismatch.",
        409
      );
    }

    const current = this.getConsentRecord(userId);
    if (
      current
      && current.status === "active"
      && current.policyVersion === policyVersion
    ) {
      return current;
    }

    const event: ConsentEventRecord = {
      id: createRecordId("consent"),
      userId,
      policyVersion,
      type: "accepted",
      timestamp: this.buildTimestamp(),
      fingerprint: meta.fingerprint,
      ipAddress: meta.ipAddress
    };
    this.store.appendConsentEvent(event);
    this.incrementMetric("consent_accept_total");
    this.appendAuditEvent({
      type: "consent_accepted",
      userId,
      timestamp: event.timestamp,
      fingerprint: meta.fingerprint,
      ipAddress: meta.ipAddress,
      outcome: "success"
    });

    return this.getConsentRecordOrThrow(userId);
  }

  revokeConsent(
    request: RevokeConsentRequest,
    meta: ProfileRequestMeta
  ): ConsentRecord {
    const userId = normalizeRequiredText("userId", request.userId);
    const current = this.getConsentRecord(userId);

    if (!current) {
      throw new ProfileError(
        "CONSENT_REQUIRED",
        "Active consent is required before revocation.",
        403
      );
    }

    if (current.status === "revoked") {
      return current;
    }

    const event: ConsentEventRecord = {
      id: createRecordId("consent"),
      userId,
      policyVersion: current.policyVersion,
      type: "revoked",
      timestamp: this.buildTimestamp(),
      fingerprint: meta.fingerprint,
      ipAddress: meta.ipAddress
    };
    this.store.appendConsentEvent(event);
    this.incrementMetric("consent_revoke_total");
    this.appendAuditEvent({
      type: "consent_revoked",
      userId,
      timestamp: event.timestamp,
      fingerprint: meta.fingerprint,
      ipAddress: meta.ipAddress,
      outcome: "success"
    });

    return this.getConsentRecordOrThrow(userId);
  }

  updateProfile(
    request: UpdateProfileRequest,
    meta: ProfileRequestMeta
  ): UserProfile {
    const userId = normalizeRequiredText("userId", request.userId);
    const consent = this.requireActiveConsent(userId, meta, "profile_update");
    const current = this.store.findProfileByUserId(userId);
    const existing = current ? this.decryptProfile(current) : undefined;
    const merged = buildMergedProfile(userId, existing, request);
    validateProfile(merged);

    const timestamp = this.buildTimestamp();
    const stored: StoredUserProfileRecord = {
      userId,
      keyId: this.cipher.keyId,
      consentPolicyVersion: consent.policyVersion,
      conditionPrimaryCiphertext: this.cipher.encrypt(merged.conditionPrimary),
      severityBandCiphertext: this.cipher.encrypt(merged.severityBand),
      symptomTagsCiphertext: this.cipher.encrypt(JSON.stringify(merged.symptomTags)),
      lifestyleTagsCiphertext: this.cipher.encrypt(
        JSON.stringify(merged.lifestyleTags)
      ),
      updatedAt: timestamp
    };

    this.store.saveProfile(stored);
    this.store.appendChangeLog({
      id: createRecordId("profile-change"),
      userId,
      consentPolicyVersion: consent.policyVersion,
      keyId: stored.keyId,
      changedAt: timestamp,
      snapshot: stored
    });
    this.incrementMetric("profile_update_success_total");
    this.appendAuditEvent({
      type: "profile_updated",
      userId,
      timestamp,
      fingerprint: meta.fingerprint,
      ipAddress: meta.ipAddress,
      outcome: "success"
    });

    return this.decryptProfile(stored);
  }

  getProfile(
    request: GetProfileRequest,
    meta: ProfileRequestMeta
  ): UserProfile {
    const userId = normalizeRequiredText("userId", request.userId);
    this.requireActiveConsent(userId, meta, "profile_read");
    const stored = this.store.findProfileByUserId(userId);

    if (!stored) {
      throw new ProfileError(
        "PROFILE_VALIDATION_ERROR",
        "Profile does not exist for the requested user.",
        404
      );
    }

    const timestamp = this.buildTimestamp();
    this.appendAuditEvent({
      type: "profile_read",
      userId,
      timestamp,
      fingerprint: meta.fingerprint,
      ipAddress: meta.ipAddress,
      outcome: "success"
    });
    return this.decryptProfile(stored);
  }

  getConsentRecord(userId: string): ConsentRecord | undefined {
    const normalizedUserId = normalizeRequiredText("userId", userId);
    let current: ConsentRecord | undefined;

    for (const event of this.store.listConsentEvents(normalizedUserId)) {
      if (event.type === "accepted") {
        current = {
          userId: normalizedUserId,
          policyVersion: event.policyVersion,
          acceptedAt: event.timestamp,
          status: "active"
        };
        continue;
      }

      if (current && current.status === "active") {
        current = {
          ...current,
          status: "revoked",
          revokedAt: event.timestamp
        };
      }
    }

    return current;
  }

  listConsentEvents(userId: string): ConsentEventRecord[] {
    return this.store.listConsentEvents(userId);
  }

  listChangeLog(userId: string): ProfileChangeLogEntry[] {
    return this.store.listChangeLog(userId).map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      consentPolicyVersion: entry.consentPolicyVersion,
      keyId: entry.keyId,
      changedAt: entry.changedAt,
      profile: this.decryptProfile(entry.snapshot)
    }));
  }

  listAuditEvents(): ProfileAuditEvent[] {
    return this.store.listAuditEvents();
  }

  getMetrics(): ProfileMetricsSnapshot {
    return {
      consent_accept_total: this.metricValue("consent_accept_total"),
      consent_revoke_total: this.metricValue("consent_revoke_total"),
      profile_update_success_total: this.metricValue(
        "profile_update_success_total"
      ),
      consent_enforcement_denied_total: this.metricValue(
        "consent_enforcement_denied_total"
      )
    };
  }

  private getConsentRecordOrThrow(userId: string): ConsentRecord {
    const consent = this.getConsentRecord(userId);
    if (!consent) {
      throw new ProfileError(
        "CONSENT_REQUIRED",
        "Consent record does not exist.",
        404
      );
    }

    return consent;
  }

  private requireActiveConsent(
    userId: string,
    meta: ProfileRequestMeta,
    reason: string
  ): ConsentRecord {
    const consent = this.getConsentRecord(userId);
    if (!consent) {
      this.recordConsentDenial(
        userId,
        meta,
        "CONSENT_REQUIRED",
        "Active consent is required before using profile endpoints.",
        reason
      );
    }

    if (consent.status === "revoked") {
      this.recordConsentDenial(
        userId,
        meta,
        "CONSENT_REVOKED",
        "Consent has been revoked for this user.",
        reason
      );
    }

    return consent;
  }

  private recordConsentDenial(
    userId: string,
    meta: ProfileRequestMeta,
    code: "CONSENT_REQUIRED" | "CONSENT_REVOKED",
    message: string,
    reason: string
  ): never {
    const timestamp = this.buildTimestamp();
    this.incrementMetric("consent_enforcement_denied_total");
    this.appendAuditEvent({
      type: "consent_enforcement_denied",
      userId,
      timestamp,
      fingerprint: meta.fingerprint,
      ipAddress: meta.ipAddress,
      outcome: "failure",
      reason
    });
    throw new ProfileError(code, message, 403);
  }

  private decryptProfile(stored: StoredUserProfileRecord): UserProfile {
    return {
      userId: stored.userId,
      conditionPrimary: this.safeDecrypt(stored.conditionPrimaryCiphertext),
      severityBand: parseSeverityBand(
        this.safeDecrypt(stored.severityBandCiphertext)
      ),
      symptomTags: parseTagList(this.safeDecrypt(stored.symptomTagsCiphertext)),
      lifestyleTags: parseTagList(this.safeDecrypt(stored.lifestyleTagsCiphertext))
    };
  }

  private incrementMetric(metricName: ProfileMetricName): void {
    this.metrics.set(metricName, this.metricValue(metricName) + 1);
  }

  private metricValue(metricName: ProfileMetricName): number {
    return this.metrics.get(metricName) ?? 0;
  }

  private appendAuditEvent(event: ProfileAuditEvent): void {
    this.store.appendAuditEvent(event);
  }

  private buildTimestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private safeDecrypt(ciphertext: string): string {
    try {
      return this.cipher.decrypt(ciphertext);
    } catch (error) {
      throw new ProfileError(
        "PROFILE_VALIDATION_ERROR",
        "Sensitive profile data could not be decrypted.",
        500,
        error
      );
    }
  }
}

function buildMergedProfile(
  userId: string,
  existing: UserProfile | undefined,
  request: UpdateProfileRequest
): UserProfile {
  return {
    userId,
    conditionPrimary: request.conditionPrimary ?? existing?.conditionPrimary ?? "",
    severityBand: request.severityBand ?? existing?.severityBand ?? ("" as SeverityBand),
    symptomTags: request.symptomTags ?? existing?.symptomTags ?? [],
    lifestyleTags: request.lifestyleTags ?? existing?.lifestyleTags ?? []
  };
}

function validateProfile(profile: UserProfile): void {
  normalizeRequiredText("conditionPrimary", profile.conditionPrimary);
  if (!VALID_SEVERITY_BANDS.has(profile.severityBand)) {
    throw new ProfileError(
      "PROFILE_VALIDATION_ERROR",
      "Severity band must be one of low, medium, or high.",
      422
    );
  }

  assertValidTagList("symptomTags", profile.symptomTags);
  assertValidTagList("lifestyleTags", profile.lifestyleTags);
}

function assertValidTagList(field: string, tags: unknown): void {
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    throw new ProfileError(
      "PROFILE_VALIDATION_ERROR",
      `${field} must be an array of strings.`,
      422
    );
  }

  const normalizedTags = tags.map((tag) => normalizeRequiredText(field, tag));
  if (new Set(normalizedTags).size !== normalizedTags.length) {
    throw new ProfileError(
      "PROFILE_VALIDATION_ERROR",
      `${field} cannot contain duplicate values.`,
      422
    );
  }
}

function parseTagList(serialized: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new ProfileError(
      "PROFILE_VALIDATION_ERROR",
      "Stored profile tags are invalid.",
      500
    );
  }

  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new ProfileError(
      "PROFILE_VALIDATION_ERROR",
      "Stored profile tags are invalid.",
      500
    );
  }

  return parsed;
}

function parseSeverityBand(value: string): SeverityBand {
  if (!VALID_SEVERITY_BANDS.has(value as SeverityBand)) {
    throw new ProfileError(
      "PROFILE_VALIDATION_ERROR",
      "Stored severity band is invalid.",
      500
    );
  }

  return value as SeverityBand;
}

function normalizeRequiredText(field: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ProfileError(
      "PROFILE_VALIDATION_ERROR",
      `${field} is required.`,
      422
    );
  }

  return normalized;
}

function createRecordId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
