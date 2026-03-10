import { createHash, randomUUID } from "node:crypto";

import { StackError } from "./errors.ts";
import { InMemoryStackStore } from "./store.ts";
import {
  defaultStackTemplates,
  instantiateTemplateSections
} from "./templates.ts";
import type {
  CreateStackDraftRequest,
  DraftMetricsSnapshot,
  DraftSaveEvent,
  GetStackDraftRequest,
  PricingMetadata,
  PublishDraftRequest,
  PublishDraftResult,
  PublishEvent,
  PublishMetricsSnapshot,
  PublishStage,
  PublishStageDurationsMs,
  PublishedArtifact,
  PublishedArtifactRecord,
  RecoverStackDraftRequest,
  RedactedSection,
  RedactionRuleSet,
  SaveStackDraftRequest,
  StackActor,
  StackDraft,
  StackPreview,
  StackSection,
  StackTemplate,
  StackVersionRecord
} from "./types.ts";

type StackDraftServiceOptions = {
  now?: () => number;
  store?: InMemoryStackStore;
  templates?: StackTemplate[];
};

const EMPTY_DRAFT_METRICS: DraftMetricsSnapshot = {
  draft_autosave_success_total: 0,
  draft_autosave_failure_total: 0,
  draft_conflict_total: 0,
  draft_recovery_success_total: 0
};

const EMPTY_PUBLISH_METRICS: PublishMetricsSnapshot = {
  publish_attempt_total: 0,
  publish_success_total: 0,
  publish_validation_failure_total: 0,
  redaction_failure_total: 0
};

const DEFAULT_REDACTION_RULE_SET: RedactionRuleSet = {
  removeFields: ["internal-note", "direct-contact", "creator-email", "creator-phone"],
  maskPatterns: [
    "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}",
    "\\+?\\d[\\d\\s().-]{7,}\\d"
  ],
  requiredOutputFields: ["summary", "problem", "solution", "offer"]
};

export class StackDraftService {
  private readonly now: () => number;
  readonly store: InMemoryStackStore;
  private readonly draftMetrics = new Map<keyof DraftMetricsSnapshot, number>();
  private readonly publishMetrics = new Map<keyof PublishMetricsSnapshot, number>();
  private readonly templates = new Map<string, StackTemplate>();

  constructor(options: StackDraftServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.store = options.store ?? new InMemoryStackStore();

    for (const metricName of Object.keys(EMPTY_DRAFT_METRICS) as Array<
      keyof DraftMetricsSnapshot
    >) {
      this.draftMetrics.set(metricName, 0);
    }

    for (const metricName of Object.keys(EMPTY_PUBLISH_METRICS) as Array<
      keyof PublishMetricsSnapshot
    >) {
      this.publishMetrics.set(metricName, 0);
    }

    for (const template of options.templates ?? defaultStackTemplates) {
      this.templates.set(template.id, {
        ...template,
        sections: template.sections.map((section) => ({ ...section }))
      });
    }
  }

  createDraft(actor: StackActor, request: CreateStackDraftRequest): StackDraft {
    const creatorId = normalizeRequiredText("creatorId", request.creatorId);
    assertCanCreateDraft(actor, creatorId);
    const template = this.resolveTemplate(request.templateId);
    const now = this.timestamp();

    const draft: StackDraft = {
      stackId: createId("stack"),
      creatorId,
      revision: 1,
      status: "draft",
      sections: instantiateTemplateSections(template),
      updatedAt: now,
      templateId: template.id
    };

    this.store.saveDraft(cloneDraft(draft));
    return cloneDraft(draft);
  }

  getDraft(actor: StackActor, request: GetStackDraftRequest): StackDraft {
    const draft = this.requireDraft(request.stackId);
    assertCanAccessDraft(actor, draft);
    return cloneDraft(draft);
  }

  saveDraft(actor: StackActor, request: SaveStackDraftRequest): StackDraft {
    const existing = this.requireDraft(request.stackId);
    assertCanAccessDraft(actor, existing);

    const startedAtMs = this.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const attempt = request.attempt ?? 1;

    if (this.store.consumeTransientSaveFailure(existing.stackId)) {
      const completedAtMs = this.now();
      this.appendSaveEvent({
        stackId: existing.stackId,
        source: request.source,
        attempt,
        revision: existing.revision,
        startedAt,
        completedAt: new Date(completedAtMs).toISOString(),
        latencyMs: Math.max(0, completedAtMs - startedAtMs),
        outcome: "failure",
        errorCode: "DRAFT_SAVE_FAILED_TRANSIENT"
      });
      if (request.source === "autosave") {
        this.incrementDraftMetric("draft_autosave_failure_total");
      }
      throw new StackError(
        "DRAFT_SAVE_FAILED_TRANSIENT",
        "Draft save failed because the autosave transport was interrupted.",
        503
      );
    }

    if (request.expectedRevision !== existing.revision) {
      const completedAtMs = this.now();
      this.appendSaveEvent({
        stackId: existing.stackId,
        source: request.source,
        attempt,
        revision: existing.revision,
        startedAt,
        completedAt: new Date(completedAtMs).toISOString(),
        latencyMs: Math.max(0, completedAtMs - startedAtMs),
        outcome: "conflict",
        errorCode: "DRAFT_REVISION_CONFLICT"
      });
      this.incrementDraftMetric("draft_conflict_total");
      throw new StackError(
        "DRAFT_REVISION_CONFLICT",
        "Draft revision conflict detected.",
        409
      );
    }

    const normalizedSections = normalizeSections(request.sections);
    const updatedDraft: StackDraft = {
      ...existing,
      sections: normalizedSections,
      revision: existing.revision + 1,
      updatedAt: this.timestamp()
    };
    this.store.saveDraft(cloneDraft(updatedDraft));

    const completedAtMs = this.now();
    this.appendSaveEvent({
      stackId: updatedDraft.stackId,
      source: request.source,
      attempt,
      revision: updatedDraft.revision,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      latencyMs: Math.max(0, completedAtMs - startedAtMs),
      outcome: "success"
    });
    if (request.source === "autosave") {
      this.incrementDraftMetric("draft_autosave_success_total");
    }

    return cloneDraft(updatedDraft);
  }

  recoverDraft(
    actor: StackActor,
    request: RecoverStackDraftRequest
  ): StackDraft {
    const draft = this.requireDraft(request.stackId);
    assertCanAccessDraft(actor, draft);
    this.incrementDraftMetric("draft_recovery_success_total");
    return cloneDraft(draft);
  }

  publishDraft(
    actor: StackActor,
    request: PublishDraftRequest
  ): PublishDraftResult {
    const draft = this.requireDraft(request.stackId);
    assertCanPublishDraft(actor, draft);

    const requestKey = normalizeRequiredText("requestKey", request.requestKey);
    const pricingMetadata = normalizePricingMetadata(request.pricingMetadata);
    const redactionRuleSet = normalizeRedactionRuleSet(
      request.redactionRuleSet ?? DEFAULT_REDACTION_RULE_SET
    );

    this.incrementPublishMetric("publish_attempt_total");

    const replayedArtifact = this.store.findPublishedArtifactByRequestKey(
      draft.stackId,
      requestKey
    );
    if (replayedArtifact) {
      const publishEvent = this.buildPublishEvent({
        actor,
        draft,
        requestKey,
        outcome: "idempotent_replay",
        validationErrors: [],
        stateTransitions: ["published"],
        stageDurationsMs: {
          validating: 0,
          publishing: 0,
          total: 0
        },
        version: replayedArtifact.version
      });
      this.store.appendPublishEvent(publishEvent);
      return {
        artifact: toPublishedArtifact(replayedArtifact),
        publishEvent,
        replayed: true
      };
    }

    const startedAtMs = this.now();
    const validationStartMs = startedAtMs;
    const validationErrors = validateDraftForPublish(
      draft,
      pricingMetadata,
      redactionRuleSet
    );
    const validationDurationMs = Math.max(0, this.now() - validationStartMs);

    if (validationErrors.length > 0) {
      this.incrementPublishMetric("publish_validation_failure_total");
      const publishEvent = this.buildPublishEvent({
        actor,
        draft,
        requestKey,
        outcome: "failure",
        validationErrors,
        stateTransitions: ["draft", "validating"],
        stageDurationsMs: {
          validating: validationDurationMs,
          publishing: 0,
          total: validationDurationMs
        },
        errorCode: "PUBLISH_VALIDATION_FAILED"
      });
      this.store.appendPublishEvent(publishEvent);
      throw new StackError(
        "PUBLISH_VALIDATION_FAILED",
        validationErrors.join(" "),
        422
      );
    }

    const publishingStartMs = this.now();
    let redactedSections: RedactedSection[];
    let redactedPayload: string;
    let checksum: string;

    try {
      redactedSections = redactSections(draft.sections, redactionRuleSet);
      redactedPayload = JSON.stringify({
        stackId: draft.stackId,
        draftRevision: draft.revision,
        pricingMetadata,
        sections: redactedSections
      });
      checksum = sha256(redactedPayload);
    } catch (error) {
      this.incrementPublishMetric("redaction_failure_total");
      const publishingDurationMs = Math.max(0, this.now() - publishingStartMs);
      const publishEvent = this.buildPublishEvent({
        actor,
        draft,
        requestKey,
        outcome: "failure",
        validationErrors: [],
        stateTransitions: ["draft", "validating", "publishing"],
        stageDurationsMs: {
          validating: validationDurationMs,
          publishing: publishingDurationMs,
          total: validationDurationMs + publishingDurationMs
        },
        errorCode: "REDACTION_FAILED"
      });
      this.store.appendPublishEvent(publishEvent);
      throw toStackError(error, "REDACTION_FAILED", "Redaction pipeline failed.", 422);
    }

    const version = (this.store.listVersionRecords(draft.stackId).at(-1)?.version ?? 0) + 1;
    const publishedAt = this.timestamp();
    const redactedPayloadRef = `artifact://${draft.stackId}/v${version}/${checksum}`;

    if (this.store.consumeArtifactPersistFailure(draft.stackId)) {
      const publishingDurationMs = Math.max(0, this.now() - publishingStartMs);
      const publishEvent = this.buildPublishEvent({
        actor,
        draft,
        requestKey,
        outcome: "failure",
        validationErrors: [],
        stateTransitions: ["draft", "validating", "publishing"],
        stageDurationsMs: {
          validating: validationDurationMs,
          publishing: publishingDurationMs,
          total: validationDurationMs + publishingDurationMs
        },
        errorCode: "ARTIFACT_PERSIST_FAILED"
      });
      this.store.appendPublishEvent(publishEvent);
      throw new StackError(
        "ARTIFACT_PERSIST_FAILED",
        "Artifact persistence failed before the publish completed.",
        503
      );
    }

    const persistedPayload = this.store.consumeArtifactChecksumMismatch(draft.stackId)
      ? `${redactedPayload}\nchecksum-mismatch`
      : redactedPayload;
    if (sha256(persistedPayload) !== checksum) {
      const publishingDurationMs = Math.max(0, this.now() - publishingStartMs);
      const publishEvent = this.buildPublishEvent({
        actor,
        draft,
        requestKey,
        outcome: "failure",
        validationErrors: [],
        stateTransitions: ["draft", "validating", "publishing"],
        stageDurationsMs: {
          validating: validationDurationMs,
          publishing: publishingDurationMs,
          total: validationDurationMs + publishingDurationMs
        },
        errorCode: "ARTIFACT_PERSIST_FAILED"
      });
      this.store.appendPublishEvent(publishEvent);
      throw new StackError(
        "ARTIFACT_PERSIST_FAILED",
        "Artifact checksum verification failed after persistence.",
        503
      );
    }

    const artifactRecord: PublishedArtifactRecord = {
      stackId: draft.stackId,
      version,
      checksum,
      hashAlgo: "sha256",
      redactedPayloadRef,
      publishedAt,
      pricingMetadata,
      requestKey,
      draftRevision: draft.revision,
      redactedPayload: persistedPayload,
      redactedSections
    };
    const versionRecord: StackVersionRecord = {
      stackId: draft.stackId,
      version,
      checksum,
      hashAlgo: "sha256",
      draftRevision: draft.revision,
      requestKey,
      createdAt: publishedAt
    };
    this.store.saveVersionRecord(versionRecord);
    this.store.savePublishedArtifact(artifactRecord);
    this.incrementPublishMetric("publish_success_total");

    const publishingDurationMs = Math.max(0, this.now() - publishingStartMs);
    const publishEvent = this.buildPublishEvent({
      actor,
      draft,
      requestKey,
      outcome: "success",
      validationErrors: [],
      stateTransitions: ["draft", "validating", "publishing", "published"],
      stageDurationsMs: {
        validating: validationDurationMs,
        publishing: publishingDurationMs,
        total: validationDurationMs + publishingDurationMs
      },
      version
    });
    this.store.appendPublishEvent(publishEvent);

    return {
      artifact: toPublishedArtifact(artifactRecord),
      publishEvent,
      replayed: false
    };
  }

  renderPreview(draft: StackDraft): StackPreview {
    return {
      stackId: draft.stackId,
      sectionCount: draft.sections.length,
      rendered: draft.sections
        .slice()
        .sort((left, right) => left.order - right.order)
        .map(
          (section) =>
            `## ${section.type}\n${section.content.trim() || "_No content yet_"}`
        )
        .join("\n\n")
    };
  }

  listTemplates(): StackTemplate[] {
    return [...this.templates.values()].map((template) => ({
      ...template,
      sections: template.sections.map((section) => ({ ...section }))
    }));
  }

  listSaveEvents(stackId?: string): DraftSaveEvent[] {
    return this.store.listSaveEvents(stackId).map((event) => ({ ...event }));
  }

  listPublishedArtifacts(stackId?: string): PublishedArtifact[] {
    return this.store
      .listPublishedArtifacts(stackId)
      .map((artifact) => toPublishedArtifact(artifact));
  }

  listPublishedArtifactRecords(stackId?: string): PublishedArtifactRecord[] {
    return this.store.listPublishedArtifacts(stackId).map((record) => ({
      ...record,
      pricingMetadata: { ...record.pricingMetadata },
      redactedSections: record.redactedSections.map((section) => ({ ...section }))
    }));
  }

  listVersionRecords(stackId?: string): StackVersionRecord[] {
    return this.store.listVersionRecords(stackId).map((record) => ({
      ...record
    }));
  }

  listPublishEvents(stackId?: string): PublishEvent[] {
    return this.store.listPublishEvents(stackId).map((event) => ({
      ...event,
      validationErrors: [...event.validationErrors],
      stateTransitions: [...event.stateTransitions],
      stageDurationsMs: { ...event.stageDurationsMs }
    }));
  }

  getMetrics(): DraftMetricsSnapshot {
    return {
      draft_autosave_success_total: this.draftMetricValue(
        "draft_autosave_success_total"
      ),
      draft_autosave_failure_total: this.draftMetricValue(
        "draft_autosave_failure_total"
      ),
      draft_conflict_total: this.draftMetricValue("draft_conflict_total"),
      draft_recovery_success_total: this.draftMetricValue(
        "draft_recovery_success_total"
      )
    };
  }

  getPublishMetrics(): PublishMetricsSnapshot {
    return {
      publish_attempt_total: this.publishMetricValue("publish_attempt_total"),
      publish_success_total: this.publishMetricValue("publish_success_total"),
      publish_validation_failure_total: this.publishMetricValue(
        "publish_validation_failure_total"
      ),
      redaction_failure_total: this.publishMetricValue("redaction_failure_total")
    };
  }

  private requireDraft(stackId: string): StackDraft {
    const normalizedStackId = normalizeRequiredText("stackId", stackId);
    const draft = this.store.findDraftById(normalizedStackId);
    if (!draft) {
      throw new StackError("STACK_NOT_FOUND", "Stack draft was not found.", 404);
    }

    return draft;
  }

  private resolveTemplate(templateId?: string): StackTemplate {
    if (templateId) {
      const resolved = this.templates.get(templateId);
      if (resolved) {
        return resolved;
      }

      const fallback = this.templates.get("blank");
      if (!fallback) {
        throw new StackError(
          "STACK_VALIDATION_ERROR",
          "Blank draft template is required.",
          500
        );
      }

      return fallback;
    }

    const defaultTemplate = this.templates.get("creator-standard");
    if (defaultTemplate) {
      return defaultTemplate;
    }

    const fallback = this.templates.get("blank");
    if (!fallback) {
      throw new StackError(
        "STACK_VALIDATION_ERROR",
        "Blank draft template is required.",
        500
      );
    }

    return fallback;
  }

  private buildPublishEvent(input: {
    actor: StackActor;
    draft: StackDraft;
    requestKey: string;
    outcome: PublishEvent["outcome"];
    validationErrors: string[];
    stateTransitions: PublishStage[];
    stageDurationsMs: PublishStageDurationsMs;
    version?: number;
    errorCode?: PublishEvent["errorCode"];
  }): PublishEvent {
    const completedAt = this.timestamp();
    const startedAt = new Date(
      Date.parse(completedAt) - input.stageDurationsMs.total
    ).toISOString();

    return {
      id: createId("publish"),
      stackId: input.draft.stackId,
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      requestKey: input.requestKey,
      outcome: input.outcome,
      validationErrors: [...input.validationErrors],
      stateTransitions: [...input.stateTransitions],
      stageDurationsMs: { ...input.stageDurationsMs },
      startedAt,
      completedAt,
      version: input.version,
      errorCode: input.errorCode
    };
  }

  private incrementDraftMetric(metricName: keyof DraftMetricsSnapshot): void {
    this.draftMetrics.set(metricName, this.draftMetricValue(metricName) + 1);
  }

  private draftMetricValue(metricName: keyof DraftMetricsSnapshot): number {
    return this.draftMetrics.get(metricName) ?? 0;
  }

  private incrementPublishMetric(metricName: keyof PublishMetricsSnapshot): void {
    this.publishMetrics.set(metricName, this.publishMetricValue(metricName) + 1);
  }

  private publishMetricValue(metricName: keyof PublishMetricsSnapshot): number {
    return this.publishMetrics.get(metricName) ?? 0;
  }

  private appendSaveEvent(event: Omit<DraftSaveEvent, "id">): void {
    this.store.appendSaveEvent({
      ...event,
      id: createId("save")
    });
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function assertCanCreateDraft(actor: StackActor, creatorId: string): void {
  if (actor.permissions.includes("creator:stack:draft:any")) {
    return;
  }

  if (
    actor.permissions.includes("creator:stack:draft:self")
    && actor.userId === creatorId
  ) {
    return;
  }

  throw new StackError(
    "STACK_ACCESS_DENIED",
    "Actor is not allowed to create drafts for the requested creator.",
    403
  );
}

function assertCanAccessDraft(actor: StackActor, draft: StackDraft): void {
  if (actor.permissions.includes("creator:stack:draft:any")) {
    return;
  }

  if (
    actor.permissions.includes("creator:stack:draft:self")
    && actor.userId === draft.creatorId
  ) {
    return;
  }

  throw new StackError(
    "STACK_ACCESS_DENIED",
    "Actor is not allowed to access this draft.",
    403
  );
}

function assertCanPublishDraft(actor: StackActor, draft: StackDraft): void {
  if (
    actor.permissions.includes("creator:stack:publish")
    && actor.userId === draft.creatorId
  ) {
    return;
  }

  throw new StackError(
    "STACK_ACCESS_DENIED",
    "Only the creator owner can publish this draft.",
    403
  );
}

function normalizeSections(sections: StackSection[]): StackSection[] {
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new StackError(
      "STACK_VALIDATION_ERROR",
      "Draft sections must contain at least one section.",
      422
    );
  }

  const seenIds = new Set<string>();
  return sections.map((section, index) => {
    const id = normalizeRequiredText("section.id", section.id);
    if (seenIds.has(id)) {
      throw new StackError(
        "STACK_VALIDATION_ERROR",
        "Draft sections cannot contain duplicate ids.",
        422
      );
    }
    seenIds.add(id);

    return {
      id,
      type: normalizeRequiredText("section.type", section.type),
      content: typeof section.content === "string" ? section.content : "",
      order: index
    };
  });
}

function normalizePricingMetadata(pricingMetadata: PricingMetadata): PricingMetadata {
  if (!Number.isInteger(pricingMetadata.amountCents) || pricingMetadata.amountCents <= 0) {
    throw new StackError(
      "PUBLISH_VALIDATION_FAILED",
      "Pricing amount must be a positive integer number of cents.",
      422
    );
  }

  const currency = normalizeRequiredText("pricingMetadata.currency", pricingMetadata.currency)
    .toUpperCase();
  if (currency.length !== 3) {
    throw new StackError(
      "PUBLISH_VALIDATION_FAILED",
      "Pricing currency must be a 3-letter ISO code.",
      422
    );
  }

  return {
    amountCents: pricingMetadata.amountCents,
    currency,
    internalSku: normalizeRequiredText(
      "pricingMetadata.internalSku",
      pricingMetadata.internalSku
    )
  };
}

function normalizeRedactionRuleSet(ruleSet: RedactionRuleSet): RedactionRuleSet {
  return {
    removeFields: ruleSet.removeFields.map((field) =>
      normalizeRequiredText("redactionRuleSet.removeFields", field).toLowerCase()
    ),
    maskPatterns: ruleSet.maskPatterns.map((pattern) =>
      normalizeRequiredText("redactionRuleSet.maskPatterns", pattern)
    ),
    requiredOutputFields: ruleSet.requiredOutputFields.map((field) =>
      normalizeRequiredText("redactionRuleSet.requiredOutputFields", field).toLowerCase()
    )
  };
}

function validateDraftForPublish(
  draft: StackDraft,
  pricingMetadata: PricingMetadata,
  redactionRuleSet: RedactionRuleSet
): string[] {
  const errors: string[] = [];
  const availableSections = new Map(
    draft.sections.map((section) => [section.type.toLowerCase(), section])
  );

  for (const requiredField of redactionRuleSet.requiredOutputFields) {
    const section = availableSections.get(requiredField);
    if (!section || !section.content.trim()) {
      errors.push(`Required section "${requiredField}" must be present with content.`);
    }
  }

  for (const section of draft.sections) {
    const loweredContent = section.content.toLowerCase();
    for (const removedField of redactionRuleSet.removeFields) {
      if (loweredContent.includes(`${removedField}:`)) {
        errors.push(
          `Draft section "${section.type}" contains prohibited field "${removedField}".`
        );
      }
    }
  }

  if (!Number.isInteger(pricingMetadata.amountCents) || pricingMetadata.amountCents <= 0) {
    errors.push("Pricing metadata must contain a positive amount.");
  }

  if (!pricingMetadata.internalSku.trim()) {
    errors.push("Pricing metadata must contain an internal SKU.");
  }

  return errors;
}

function redactSections(
  sections: StackSection[],
  redactionRuleSet: RedactionRuleSet
): RedactedSection[] {
  return sections
    .filter(
      (section) =>
        !redactionRuleSet.removeFields.includes(section.type.toLowerCase())
    )
    .map((section) => ({
      type: section.type,
      order: section.order,
      content: redactContent(section.content, redactionRuleSet)
    }));
}

function redactContent(content: string, redactionRuleSet: RedactionRuleSet): string {
  let redacted = content;

  for (const removedField of redactionRuleSet.removeFields) {
    const fieldPattern = new RegExp(`^\\s*${escapeRegExp(removedField)}\\s*:.*$`, "gim");
    redacted = redacted.replace(fieldPattern, "");
  }

  for (const pattern of redactionRuleSet.maskPatterns) {
    let compiled: RegExp;
    try {
      compiled = new RegExp(pattern, "gi");
    } catch (error) {
      throw toStackError(
        error,
        "REDACTION_FAILED",
        `Invalid redaction pattern "${pattern}".`,
        422
      );
    }
    redacted = redacted.replace(compiled, "[REDACTED]");
  }

  const normalized = redacted
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.trim() || (index > 0 && lines[index - 1]?.trim()))
    .join("\n")
    .trim();

  if (!normalized) {
    throw new StackError(
      "REDACTION_FAILED",
      "Redaction removed all publishable content from a section.",
      422
    );
  }

  return normalized;
}

function toPublishedArtifact(record: PublishedArtifactRecord): PublishedArtifact {
  return {
    stackId: record.stackId,
    version: record.version,
    checksum: record.checksum,
    hashAlgo: record.hashAlgo,
    redactedPayloadRef: record.redactedPayloadRef,
    publishedAt: record.publishedAt,
    pricingMetadata: { ...record.pricingMetadata }
  };
}

function cloneDraft(draft: StackDraft): StackDraft {
  return {
    ...draft,
    sections: draft.sections.map((section) => ({ ...section }))
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRequiredText(field: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new StackError(
      "STACK_VALIDATION_ERROR",
      `${field} is required.`,
      422
    );
  }

  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toStackError(
  error: unknown,
  code: StackError["code"],
  message: string,
  status: number
): StackError {
  if (error instanceof StackError) {
    return error;
  }

  return new StackError(code, message, status);
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
