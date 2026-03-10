import type {
  ConsentEventRecord,
  ProfileAuditEvent,
  ProfileChangeLogRecord,
  StoredUserProfileRecord
} from "./types.ts";

export class InMemoryProfileStore {
  private readonly consentEvents: ConsentEventRecord[] = [];
  private readonly profiles = new Map<string, StoredUserProfileRecord>();
  private readonly changeLog: ProfileChangeLogRecord[] = [];
  private readonly auditEvents: ProfileAuditEvent[] = [];

  appendConsentEvent(event: ConsentEventRecord): void {
    this.consentEvents.push(event);
  }

  listConsentEvents(userId?: string): ConsentEventRecord[] {
    if (!userId) {
      return [...this.consentEvents];
    }

    return this.consentEvents.filter((event) => event.userId === userId);
  }

  findProfileByUserId(userId: string): StoredUserProfileRecord | undefined {
    return this.profiles.get(userId);
  }

  saveProfile(profile: StoredUserProfileRecord): void {
    this.profiles.set(profile.userId, profile);
  }

  appendChangeLog(entry: ProfileChangeLogRecord): void {
    this.changeLog.push(entry);
  }

  listChangeLog(userId?: string): ProfileChangeLogRecord[] {
    if (!userId) {
      return [...this.changeLog];
    }

    return this.changeLog.filter((entry) => entry.userId === userId);
  }

  appendAuditEvent(event: ProfileAuditEvent): void {
    this.auditEvents.push(event);
  }

  listAuditEvents(): ProfileAuditEvent[] {
    return [...this.auditEvents];
  }
}
