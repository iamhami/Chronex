import type { AuthContext, Role } from "../../auth/src/types.ts";

export type StackActor = AuthContext;

export type StackSection = {
  id: string;
  type: string;
  content: string;
  order: number;
};

export type StackDraft = {
  stackId: string;
  creatorId: string;
  revision: number;
  status: "draft";
  sections: StackSection[];
  updatedAt: string;
  templateId?: string;
};

export type StackTemplateSection = {
  type: string;
  label: string;
  content: string;
};

export type StackTemplate = {
  id: string;
  name: string;
  description: string;
  sections: StackTemplateSection[];
};

export type DraftSaveSource = "autosave" | "manual";

export type DraftSaveOutcome = "success" | "failure" | "conflict";

export type DraftSaveEvent = {
  id: string;
  stackId: string;
  source: DraftSaveSource;
  attempt: number;
  revision: number;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  outcome: DraftSaveOutcome;
  errorCode?: StackErrorCode;
};

export type DraftMetricsSnapshot = {
  draft_autosave_success_total: number;
  draft_autosave_failure_total: number;
  draft_conflict_total: number;
  draft_recovery_success_total: number;
};

export type PricingMetadata = {
  amountCents: number;
  currency: string;
  internalSku: string;
};

export type RedactionRuleSet = {
  removeFields: string[];
  maskPatterns: string[];
  requiredOutputFields: string[];
};

export type RedactedSection = {
  type: string;
  content: string;
  order: number;
};

export type PublishedArtifact = {
  stackId: string;
  version: number;
  checksum: string;
  hashAlgo: "sha256";
  redactedPayloadRef: string;
  publishedAt: string;
  pricingMetadata: PricingMetadata;
};

export type PublishedArtifactRecord = PublishedArtifact & {
  requestKey: string;
  draftRevision: number;
  redactedPayload: string;
  redactedSections: RedactedSection[];
};

export type StackVersionRecord = {
  stackId: string;
  version: number;
  checksum: string;
  hashAlgo: "sha256";
  draftRevision: number;
  requestKey: string;
  createdAt: string;
};

export type PublishStage = "draft" | "validating" | "publishing" | "published";

export type PublishStageDurationsMs = {
  validating: number;
  publishing: number;
  total: number;
};

export type PublishEvent = {
  id: string;
  stackId: string;
  actorUserId: string;
  actorRole: Role;
  requestKey: string;
  outcome: "success" | "failure" | "idempotent_replay";
  validationErrors: string[];
  stateTransitions: PublishStage[];
  stageDurationsMs: PublishStageDurationsMs;
  startedAt: string;
  completedAt: string;
  version?: number;
  errorCode?: StackErrorCode;
};

export type PublishMetricsSnapshot = {
  publish_attempt_total: number;
  publish_success_total: number;
  publish_validation_failure_total: number;
  redaction_failure_total: number;
};

export type StackPreview = {
  stackId: string;
  sectionCount: number;
  rendered: string;
};

export type CreateStackDraftRequest = {
  creatorId: string;
  templateId?: string;
};

export type GetStackDraftRequest = {
  stackId: string;
};

export type SaveStackDraftRequest = {
  stackId: string;
  expectedRevision: number;
  sections: StackSection[];
  source: DraftSaveSource;
  attempt?: number;
};

export type RecoverStackDraftRequest = {
  stackId: string;
};

export type PublishDraftRequest = {
  stackId: string;
  requestKey: string;
  pricingMetadata: PricingMetadata;
  redactionRuleSet?: RedactionRuleSet;
};

export type PublishDraftResult = {
  artifact: PublishedArtifact;
  publishEvent: PublishEvent;
  replayed: boolean;
};

export type StackErrorCode =
  | "STACK_ACCESS_DENIED"
  | "STACK_NOT_FOUND"
  | "STACK_VALIDATION_ERROR"
  | "DRAFT_REVISION_CONFLICT"
  | "DRAFT_SAVE_FAILED_TRANSIENT"
  | "PUBLISH_VALIDATION_FAILED"
  | "REDACTION_FAILED"
  | "ARTIFACT_PERSIST_FAILED";

export type EditorPhase = "draft" | "dirty" | "saving" | "saved" | "error";

export type EditorErrorState = {
  code: StackErrorCode;
  message: string;
  recoverable: boolean;
};

export type StackEditorSnapshot = {
  phase: EditorPhase;
  draft: StackDraft;
  preview: StackPreview;
  nextAutosaveAt?: string;
  retryAt?: string;
  retryAttempt: number;
  lastError?: EditorErrorState;
};
