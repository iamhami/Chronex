import type {
  AuthorizationDecisionInput,
  SecurityAuditEvent,
  SecurityMetricName,
  SecurityMetricsSnapshot,
  SensitiveDecryptFailureInput
} from "./types.ts";

const EMPTY_METRICS: SecurityMetricsSnapshot = {
  rbac_allowed_requests_total: 0,
  rbac_denied_requests_total: 0,
  sensitive_decrypt_failures_total: 0
};

export class SecurityTelemetry {
  private readonly metrics = new Map<SecurityMetricName, number>();
  private readonly auditEvents: SecurityAuditEvent[] = [];

  constructor() {
    for (const metricName of Object.keys(EMPTY_METRICS) as SecurityMetricName[]) {
      this.metrics.set(metricName, 0);
    }
  }

  recordAuthorizationDecision(input: AuthorizationDecisionInput): void {
    this.incrementMetric(
      input.outcome === "success"
        ? "rbac_allowed_requests_total"
        : "rbac_denied_requests_total"
    );
    this.auditEvents.push({
      type: input.outcome === "success" ? "rbac_allowed" : "rbac_denied",
      actorUserId: input.actorUserId,
      role: input.role,
      action: input.action,
      resource: input.resource,
      requestId: input.requestId,
      ipAddress: input.ipAddress,
      timestamp: input.timestamp ?? new Date().toISOString(),
      outcome: input.outcome,
      reason: input.reason
    });
  }

  incrementSensitiveDecryptFailure(): void {
    this.incrementMetric("sensitive_decrypt_failures_total");
  }

  recordSensitiveDecryptFailure(input: SensitiveDecryptFailureInput): void {
    this.auditEvents.push({
      type: "sensitive_decrypt_failure",
      actorUserId: input.actorUserId,
      role: input.role,
      resource: input.resource,
      requestId: input.requestId,
      ipAddress: input.ipAddress,
      keyId: input.keyId,
      timestamp: input.timestamp ?? new Date().toISOString(),
      outcome: "failure",
      reason: input.reason
    });
  }

  getMetrics(): SecurityMetricsSnapshot {
    return {
      rbac_allowed_requests_total: this.metricValue(
        "rbac_allowed_requests_total"
      ),
      rbac_denied_requests_total: this.metricValue(
        "rbac_denied_requests_total"
      ),
      sensitive_decrypt_failures_total: this.metricValue(
        "sensitive_decrypt_failures_total"
      )
    };
  }

  listAuditEvents(): SecurityAuditEvent[] {
    return this.auditEvents.map((event) => ({ ...event }));
  }

  private incrementMetric(metricName: SecurityMetricName): void {
    this.metrics.set(metricName, this.metricValue(metricName) + 1);
  }

  private metricValue(metricName: SecurityMetricName): number {
    return this.metrics.get(metricName) ?? 0;
  }
}
