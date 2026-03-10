import type {
  DraftSaveEvent,
  PublishEvent,
  PublishedArtifactRecord,
  StackDraft,
  StackVersionRecord
} from "./types.ts";

export class InMemoryStackStore {
  private readonly drafts = new Map<string, StackDraft>();
  private readonly saveEvents: DraftSaveEvent[] = [];
  private readonly publishedArtifacts = new Map<string, PublishedArtifactRecord[]>();
  private readonly versionRecords = new Map<string, StackVersionRecord[]>();
  private readonly publishEvents: PublishEvent[] = [];
  private readonly queuedTransientSaveFailures = new Map<string, number>();
  private readonly queuedArtifactPersistFailures = new Map<string, number>();
  private readonly queuedArtifactChecksumMismatches = new Map<string, number>();

  findDraftById(stackId: string): StackDraft | undefined {
    return this.drafts.get(stackId);
  }

  saveDraft(draft: StackDraft): void {
    this.drafts.set(draft.stackId, draft);
  }

  appendSaveEvent(event: DraftSaveEvent): void {
    this.saveEvents.push(event);
  }

  listSaveEvents(stackId?: string): DraftSaveEvent[] {
    if (!stackId) {
      return [...this.saveEvents];
    }

    return this.saveEvents.filter((event) => event.stackId === stackId);
  }

  savePublishedArtifact(record: PublishedArtifactRecord): void {
    const records = this.publishedArtifacts.get(record.stackId) ?? [];
    records.push(record);
    this.publishedArtifacts.set(record.stackId, records);
  }

  listPublishedArtifacts(stackId?: string): PublishedArtifactRecord[] {
    if (!stackId) {
      return [...this.publishedArtifacts.values()].flatMap((records) => [...records]);
    }

    return [...(this.publishedArtifacts.get(stackId) ?? [])];
  }

  findPublishedArtifactByRequestKey(
    stackId: string,
    requestKey: string
  ): PublishedArtifactRecord | undefined {
    return this.listPublishedArtifacts(stackId).find(
      (record) => record.requestKey === requestKey
    );
  }

  saveVersionRecord(record: StackVersionRecord): void {
    const records = this.versionRecords.get(record.stackId) ?? [];
    records.push(record);
    this.versionRecords.set(record.stackId, records);
  }

  listVersionRecords(stackId?: string): StackVersionRecord[] {
    if (!stackId) {
      return [...this.versionRecords.values()].flatMap((records) => [...records]);
    }

    return [...(this.versionRecords.get(stackId) ?? [])];
  }

  appendPublishEvent(event: PublishEvent): void {
    this.publishEvents.push(event);
  }

  listPublishEvents(stackId?: string): PublishEvent[] {
    if (!stackId) {
      return [...this.publishEvents];
    }

    return this.publishEvents.filter((event) => event.stackId === stackId);
  }

  queueTransientSaveFailure(stackId: string, count = 1): void {
    this.queuedTransientSaveFailures.set(
      stackId,
      (this.queuedTransientSaveFailures.get(stackId) ?? 0) + count
    );
  }

  consumeTransientSaveFailure(stackId: string): boolean {
    return consumeQueuedFailure(this.queuedTransientSaveFailures, stackId);
  }

  queueArtifactPersistFailure(stackId: string, count = 1): void {
    this.queuedArtifactPersistFailures.set(
      stackId,
      (this.queuedArtifactPersistFailures.get(stackId) ?? 0) + count
    );
  }

  consumeArtifactPersistFailure(stackId: string): boolean {
    return consumeQueuedFailure(this.queuedArtifactPersistFailures, stackId);
  }

  queueArtifactChecksumMismatch(stackId: string, count = 1): void {
    this.queuedArtifactChecksumMismatches.set(
      stackId,
      (this.queuedArtifactChecksumMismatches.get(stackId) ?? 0) + count
    );
  }

  consumeArtifactChecksumMismatch(stackId: string): boolean {
    return consumeQueuedFailure(this.queuedArtifactChecksumMismatches, stackId);
  }
}

function consumeQueuedFailure(queue: Map<string, number>, stackId: string): boolean {
  const queued = queue.get(stackId) ?? 0;
  if (queued <= 0) {
    return false;
  }

  if (queued === 1) {
    queue.delete(stackId);
    return true;
  }

  queue.set(stackId, queued - 1);
  return true;
}
