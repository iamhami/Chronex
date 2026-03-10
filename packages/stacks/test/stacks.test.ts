import assert from "node:assert/strict";
import test from "node:test";

import { resolvePermissions } from "../../auth/src/index.ts";
import {
  StackDraftService,
  StackEditorController,
  StackError
} from "../src/index.ts";

function createService() {
  let now = Date.parse("2026-03-10T12:00:00.000Z");

  return {
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
    service: new StackDraftService({
      now: () => now
    })
  };
}

function buildActor(
  userId: string,
  role: "Creator" | "Admin" | "Member" = "Creator"
) {
  return {
    userId,
    role,
    sessionId: `sess_${userId}`,
    permissions: resolvePermissions(role)
  };
}

function createPricingMetadata(overrides: Partial<{
  amountCents: number;
  currency: string;
  internalSku: string;
}> = {}) {
  return {
    amountCents: overrides.amountCents ?? 9900,
    currency: overrides.currency ?? "usd",
    internalSku: overrides.internalSku ?? "STACK-001"
  };
}

function createPublishableDraft(harness: ReturnType<typeof createService>) {
  const actor = buildActor("usr_creator");
  const created = harness.service.createDraft(actor, {
    creatorId: actor.userId,
    templateId: "creator-standard"
  });

  const updated = harness.service.saveDraft(actor, {
    stackId: created.stackId,
    expectedRevision: created.revision,
    source: "manual",
    sections: created.sections.map((section) => ({
      ...section,
      content: ({
        summary: "Creator summary with creator@example.com and +1 (555) 111-2222.",
        problem: "Users struggle to assemble the right workflow quickly.",
        solution: "Chronex packages the solution as a reusable operating stack.",
        proof: "Used successfully across 32 internal launches.",
        offer: "Annual access includes templates, training, and support."
      })[section.type] ?? section.content
    }))
  });

  return {
    actor,
    draft: updated
  };
}

test("draft creation falls back to a blank scaffold when a template is missing", () => {
  const { service } = createService();
  const actor = buildActor("usr_creator");

  const draft = service.createDraft(actor, {
    creatorId: actor.userId,
    templateId: "missing-template"
  });

  assert.equal(draft.templateId, "blank");
  assert.equal(draft.sections.length, 1);
  assert.equal(draft.sections[0]?.type, "summary");
});

test("draft creation uses the standard creator template by default", () => {
  const { service } = createService();
  const actor = buildActor("usr_creator");

  const draft = service.createDraft(actor, {
    creatorId: actor.userId
  });

  assert.equal(draft.templateId, "creator-standard");
  assert.deepEqual(
    draft.sections.map((section) => section.type),
    ["summary", "problem", "solution", "proof", "offer"]
  );
});

test("autosave persists edits after debounce and exposes preview content", () => {
  const harness = createService();
  const actor = buildActor("usr_creator");
  const controller = StackEditorController.create({
    actor,
    creatorId: actor.userId,
    templateId: "creator-standard",
    service: harness.service,
    now: harness.now,
    debounceMs: 2_000
  });

  const initial = controller.getSnapshot();
  controller.updateSection(initial.draft.sections[0]!.id, "A clearer creator hook");

  let snapshot = controller.tick();
  assert.equal(snapshot.phase, "dirty");
  assert.equal(snapshot.draft.revision, 1);

  harness.advance(2_000);
  snapshot = controller.tick();

  assert.equal(snapshot.phase, "saved");
  assert.equal(snapshot.draft.revision, 2);
  assert.match(snapshot.preview.rendered, /A clearer creator hook/);
  assert.deepEqual(harness.service.getMetrics(), {
    draft_autosave_success_total: 1,
    draft_autosave_failure_total: 0,
    draft_conflict_total: 0,
    draft_recovery_success_total: 0
  });
});

test("section reorder and edits remain stable after refresh", () => {
  const harness = createService();
  const actor = buildActor("usr_creator");
  const controller = StackEditorController.create({
    actor,
    creatorId: actor.userId,
    templateId: "creator-standard",
    service: harness.service,
    now: harness.now,
    debounceMs: 1_000
  });

  const initialOrder = controller.getSnapshot().draft.sections.map((section) => section.id);
  controller.updateSection(initialOrder[1]!, "Pain point details");
  controller.reorderSections([
    initialOrder[2]!,
    initialOrder[0]!,
    initialOrder[1]!,
    initialOrder[3]!,
    initialOrder[4]!
  ]);
  harness.advance(1_000);
  const saved = controller.tick();

  const reloaded = StackEditorController.load({
    actor,
    stackId: saved.draft.stackId,
    service: harness.service,
    now: harness.now
  }).getSnapshot();

  assert.deepEqual(
    reloaded.draft.sections.map((section) => section.type),
    ["solution", "summary", "problem", "proof", "offer"]
  );
  assert.equal(reloaded.draft.sections[2]?.content, "Pain point details");
});

test("revision conflicts surface an error state and increment conflict metrics", () => {
  const harness = createService();
  const actor = buildActor("usr_creator");
  const first = StackEditorController.create({
    actor,
    creatorId: actor.userId,
    templateId: "creator-standard",
    service: harness.service,
    now: harness.now,
    debounceMs: 500
  });
  const stackId = first.getSnapshot().draft.stackId;
  const second = StackEditorController.load({
    actor,
    stackId,
    service: harness.service,
    now: harness.now,
    debounceMs: 500
  });

  first.updateSection(first.getSnapshot().draft.sections[0]!.id, "First editor");
  harness.advance(500);
  first.tick();

  second.updateSection(second.getSnapshot().draft.sections[0]!.id, "Second editor");
  harness.advance(500);
  const conflicting = second.tick();

  assert.equal(conflicting.phase, "error");
  assert.equal(conflicting.lastError?.code, "DRAFT_REVISION_CONFLICT");
  assert.deepEqual(harness.service.getMetrics(), {
    draft_autosave_success_total: 1,
    draft_autosave_failure_total: 0,
    draft_conflict_total: 1,
    draft_recovery_success_total: 0
  });
});

test("transient autosave failures retry with backoff and recovery reloads latest draft", () => {
  const harness = createService();
  const actor = buildActor("usr_creator");
  const controller = StackEditorController.create({
    actor,
    creatorId: actor.userId,
    templateId: "creator-standard",
    service: harness.service,
    now: harness.now,
    debounceMs: 1_000,
    retryBaseMs: 500
  });

  const draftId = controller.getSnapshot().draft.stackId;
  controller.updateSection(controller.getSnapshot().draft.sections[0]!.id, "Recovered content");
  harness.service.store.queueTransientSaveFailure(draftId);

  harness.advance(1_000);
  let snapshot = controller.tick();
  assert.equal(snapshot.phase, "error");
  assert.equal(snapshot.lastError?.code, "DRAFT_SAVE_FAILED_TRANSIENT");

  harness.advance(500);
  snapshot = controller.tick();
  assert.equal(snapshot.phase, "saved");
  assert.equal(snapshot.draft.revision, 2);

  controller.updateSection(snapshot.draft.sections[0]!.id, "Unsaved local change");
  harness.service.store.queueTransientSaveFailure(draftId);
  harness.advance(1_000);
  snapshot = controller.tick();
  assert.equal(snapshot.phase, "error");

  const recovered = controller.recover();
  assert.equal(recovered.phase, "saved");
  assert.equal(recovered.draft.sections[0]?.content, "Recovered content");
  assert.deepEqual(harness.service.getMetrics(), {
    draft_autosave_success_total: 1,
    draft_autosave_failure_total: 2,
    draft_conflict_total: 0,
    draft_recovery_success_total: 1
  });
});

test("draft access is restricted to the creator owner or an admin override", () => {
  const { service } = createService();
  const creator = buildActor("usr_creator");
  const member = buildActor("usr_member", "Member");
  const admin = buildActor("usr_admin", "Admin");

  const draft = service.createDraft(creator, {
    creatorId: creator.userId,
    templateId: "creator-standard"
  });

  assert.throws(
    () =>
      service.getDraft(member, {
        stackId: draft.stackId
      }),
    (error) =>
      error instanceof StackError
      && error.code === "STACK_ACCESS_DENIED"
      && error.status === 403
  );

  const adminDraft = service.getDraft(admin, {
    stackId: draft.stackId
  });
  assert.equal(adminDraft.stackId, draft.stackId);
});

test("publish validation rejects incomplete drafts with actionable errors", () => {
  const harness = createService();
  const actor = buildActor("usr_creator");
  const draft = harness.service.createDraft(actor, {
    creatorId: actor.userId,
    templateId: "blank"
  });

  assert.throws(
    () =>
      harness.service.publishDraft(actor, {
        stackId: draft.stackId,
        requestKey: "publish-blank-1",
        pricingMetadata: createPricingMetadata()
      }),
    (error) =>
      error instanceof StackError
      && error.code === "PUBLISH_VALIDATION_FAILED"
      && error.status === 422
  );

  assert.deepEqual(harness.service.getPublishMetrics(), {
    publish_attempt_total: 1,
    publish_success_total: 0,
    publish_validation_failure_total: 1,
    redaction_failure_total: 0
  });
  assert.equal(harness.service.listPublishedArtifacts(draft.stackId).length, 0);
});

test("publish redacts identifiers deterministically and versions artifacts immutably", () => {
  const harness = createService();
  const { actor, draft } = createPublishableDraft(harness);

  const firstPublish = harness.service.publishDraft(actor, {
    stackId: draft.stackId,
    requestKey: "publish-v1",
    pricingMetadata: createPricingMetadata()
  });

  const firstArtifactRecord = harness.service.listPublishedArtifactRecords(draft.stackId)[0];
  assert.ok(firstArtifactRecord);
  assert.equal(firstPublish.artifact.version, 1);
  assert.match(firstArtifactRecord.redactedPayload, /\[REDACTED\]/);
  assert.ok(!firstArtifactRecord.redactedPayload.includes("creator@example.com"));
  assert.ok(!firstArtifactRecord.redactedPayload.includes("111-2222"));

  const revisedDraft = harness.service.saveDraft(actor, {
    stackId: draft.stackId,
    expectedRevision: draft.revision,
    source: "manual",
    sections: draft.sections.map((section) =>
      section.type === "offer"
        ? {
            ...section,
            content: "Updated annual access includes templates, training, support, and onboarding."
          }
        : section
    )
  });

  const secondPublish = harness.service.publishDraft(actor, {
    stackId: revisedDraft.stackId,
    requestKey: "publish-v2",
    pricingMetadata: createPricingMetadata({
      internalSku: "STACK-002"
    })
  });

  const artifactRecords = harness.service.listPublishedArtifactRecords(draft.stackId);
  assert.equal(secondPublish.artifact.version, 2);
  assert.equal(artifactRecords.length, 2);
  assert.equal(artifactRecords[0]?.version, 1);
  assert.equal(artifactRecords[1]?.version, 2);
  assert.ok(
    artifactRecords[0]?.redactedPayload.includes(
      "Annual access includes templates, training, and support."
    )
  );
  assert.ok(
    artifactRecords[1]?.redactedPayload.includes(
      "Updated annual access includes templates, training, support, and onboarding."
    )
  );
});

test("checksum mismatches fail the publish without leaving partial version state", () => {
  const harness = createService();
  const { actor, draft } = createPublishableDraft(harness);
  harness.service.store.queueArtifactChecksumMismatch(draft.stackId);

  assert.throws(
    () =>
      harness.service.publishDraft(actor, {
        stackId: draft.stackId,
        requestKey: "publish-checksum-failure",
        pricingMetadata: createPricingMetadata()
      }),
    (error) =>
      error instanceof StackError
      && error.code === "ARTIFACT_PERSIST_FAILED"
      && error.status === 503
  );

  assert.equal(harness.service.listPublishedArtifacts(draft.stackId).length, 0);
  assert.equal(harness.service.listVersionRecords(draft.stackId).length, 0);
});

test("publish retries are idempotent by request key", () => {
  const harness = createService();
  const { actor, draft } = createPublishableDraft(harness);

  const firstResult = harness.service.publishDraft(actor, {
    stackId: draft.stackId,
    requestKey: "publish-idempotent-1",
    pricingMetadata: createPricingMetadata()
  });
  const replayedResult = harness.service.publishDraft(actor, {
    stackId: draft.stackId,
    requestKey: "publish-idempotent-1",
    pricingMetadata: createPricingMetadata()
  });

  assert.equal(firstResult.artifact.version, 1);
  assert.equal(replayedResult.artifact.version, 1);
  assert.equal(replayedResult.replayed, true);
  assert.equal(harness.service.listPublishedArtifacts(draft.stackId).length, 1);
  assert.equal(harness.service.listVersionRecords(draft.stackId).length, 1);
  assert.deepEqual(harness.service.getPublishMetrics(), {
    publish_attempt_total: 2,
    publish_success_total: 1,
    publish_validation_failure_total: 0,
    redaction_failure_total: 0
  });
});
