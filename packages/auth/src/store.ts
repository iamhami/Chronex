import type {
  AuthAuditEvent,
  AuthSessionRecord,
  AuthUserRecord
} from "./types.ts";

export class InMemoryAuthStore {
  private readonly users = new Map<string, AuthUserRecord>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly sessions = new Map<string, AuthSessionRecord>();
  private readonly events: AuthAuditEvent[] = [];

  findUserByEmail(email: string): AuthUserRecord | undefined {
    const userId = this.usersByEmail.get(email);
    return userId ? this.users.get(userId) : undefined;
  }

  findUserById(userId: string): AuthUserRecord | undefined {
    return this.users.get(userId);
  }

  saveUser(user: AuthUserRecord): void {
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email, user.id);
  }

  findSessionById(sessionId: string): AuthSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  saveSession(session: AuthSessionRecord): void {
    this.sessions.set(session.id, session);
  }

  appendEvent(event: AuthAuditEvent): void {
    this.events.push(event);
  }

  listEvents(): AuthAuditEvent[] {
    return [...this.events];
  }
}
