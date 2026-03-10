import { randomUUID } from "node:crypto";

import { StackError } from "./errors.ts";
import { StackDraftService } from "./service.ts";
import type {
  EditorErrorState,
  EditorPhase,
  StackActor,
  StackDraft,
  StackEditorSnapshot
} from "./types.ts";

type StackEditorControllerOptions = {
  actor: StackActor;
  draft: StackDraft;
  service: StackDraftService;
  debounceMs?: number;
  retryBaseMs?: number;
  now?: () => number;
};

type CreateEditorOptions = Omit<StackEditorControllerOptions, "draft"> & {
  creatorId: string;
  templateId?: string;
};

type LoadEditorOptions = Omit<StackEditorControllerOptions, "draft"> & {
  stackId: string;
};

const DEFAULT_DEBOUNCE_MS = 1_500;
const DEFAULT_RETRY_BASE_MS = 1_000;

export class StackEditorController {
  private readonly actor: StackActor;
  private readonly service: StackDraftService;
  private readonly debounceMs: number;
  private readonly retryBaseMs: number;
  private readonly now: () => number;
  private draft: StackDraft;
  private phase: EditorPhase;
  private nextAutosaveAtMs?: number;
  private retryAtMs?: number;
  private retryAttempt = 0;
  private lastError?: EditorErrorState;

  private constructor(options: StackEditorControllerOptions) {
    this.actor = options.actor;
    this.service = options.service;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.now = options.now ?? Date.now;
    this.draft = cloneDraft(options.draft);
    this.phase = "draft";
  }

  static create(options: CreateEditorOptions): StackEditorController {
    const draft = options.service.createDraft(options.actor, {
      creatorId: options.creatorId,
      templateId: options.templateId
    });
    return new StackEditorController({
      ...options,
      draft
    });
  }

  static load(options: LoadEditorOptions): StackEditorController {
    const draft = options.service.getDraft(options.actor, {
      stackId: options.stackId
    });
    const controller = new StackEditorController({
      ...options,
      draft
    });
    controller.phase = "saved";
    return controller;
  }

  appendSection(type: string, content = ""): void {
    this.draft.sections.push({
      id: `sec_${randomUUID().replaceAll("-", "")}`,
      type: normalizeRequiredText("section.type", type),
      content,
      order: this.draft.sections.length
    });
    this.markDirty();
  }

  updateSection(sectionId: string, content: string): void {
    const section = this.draft.sections.find((item) => item.id === sectionId);
    if (!section) {
      throw new StackError(
        "STACK_VALIDATION_ERROR",
        "Cannot edit a section that does not exist.",
        404
      );
    }

    section.content = content;
    this.markDirty();
  }

  reorderSections(sectionIds: string[]): void {
    if (sectionIds.length !== this.draft.sections.length) {
      throw new StackError(
        "STACK_VALIDATION_ERROR",
        "Section reordering requires every existing section id.",
        422
      );
    }

    const sectionLookup = new Map(
      this.draft.sections.map((section) => [section.id, section])
    );
    const reordered = sectionIds.map((sectionId, index) => {
      const section = sectionLookup.get(sectionId);
      if (!section) {
        throw new StackError(
          "STACK_VALIDATION_ERROR",
          "Section reordering referenced an unknown section id.",
          422
        );
      }

      return {
        ...section,
        order: index
      };
    });

    this.draft.sections = reordered;
    this.markDirty();
  }

  tick(): StackEditorSnapshot {
    const nowMs = this.now();
    if (this.phase === "dirty" && this.nextAutosaveAtMs && nowMs >= this.nextAutosaveAtMs) {
      this.attemptAutosave();
    } else if (
      this.phase === "error"
      && this.retryAtMs
      && nowMs >= this.retryAtMs
      && this.lastError?.code === "DRAFT_SAVE_FAILED_TRANSIENT"
    ) {
      this.attemptAutosave();
    }

    return this.getSnapshot();
  }

  retryAutosaveNow(): StackEditorSnapshot {
    this.attemptAutosave();
    return this.getSnapshot();
  }

  recover(): StackEditorSnapshot {
    this.draft = this.service.recoverDraft(this.actor, {
      stackId: this.draft.stackId
    });
    this.phase = "saved";
    this.nextAutosaveAtMs = undefined;
    this.retryAtMs = undefined;
    this.retryAttempt = 0;
    this.lastError = undefined;
    return this.getSnapshot();
  }

  getSnapshot(): StackEditorSnapshot {
    return {
      phase: this.phase,
      draft: cloneDraft(this.draft),
      preview: this.service.renderPreview(this.draft),
      nextAutosaveAt: formatTimestamp(this.nextAutosaveAtMs),
      retryAt: formatTimestamp(this.retryAtMs),
      retryAttempt: this.retryAttempt,
      lastError: this.lastError ? { ...this.lastError } : undefined
    };
  }

  private markDirty(): void {
    this.phase = "dirty";
    this.nextAutosaveAtMs = this.now() + this.debounceMs;
    this.retryAtMs = undefined;
    this.retryAttempt = 0;
    this.lastError = undefined;
    this.draft.sections = this.draft.sections.map((section, index) => ({
      ...section,
      order: index
    }));
  }

  private attemptAutosave(): void {
    this.phase = "saving";
    try {
      this.draft = this.service.saveDraft(this.actor, {
        stackId: this.draft.stackId,
        expectedRevision: this.draft.revision,
        sections: this.draft.sections,
        source: "autosave",
        attempt: this.retryAttempt + 1
      });
      this.phase = "saved";
      this.nextAutosaveAtMs = undefined;
      this.retryAtMs = undefined;
      this.retryAttempt = 0;
      this.lastError = undefined;
    } catch (error) {
      if (!(error instanceof StackError)) {
        throw error;
      }

      this.phase = "error";
      this.nextAutosaveAtMs = undefined;
      this.retryAttempt += 1;
      if (error.code === "DRAFT_SAVE_FAILED_TRANSIENT") {
        this.retryAtMs =
          this.now() + this.retryBaseMs * 2 ** (this.retryAttempt - 1);
      } else {
        this.retryAtMs = undefined;
      }
      this.lastError = {
        code: error.code,
        message: error.message,
        recoverable: error.code !== "DRAFT_REVISION_CONFLICT"
      };
    }
  }
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

function cloneDraft(draft: StackDraft): StackDraft {
  return {
    ...draft,
    sections: draft.sections.map((section) => ({ ...section }))
  };
}

function formatTimestamp(value?: number): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}
