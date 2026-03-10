# Stack Builder Flows

`S-005` defines the shared stack draft and editor control logic for creator
authoring. The transport layer and framework UI are still deferred, so the
package focuses on draft persistence, optimistic concurrency, autosave control,
template-backed scaffolding, and preview rendering.

## Endpoints

- `POST /api/v1/stacks`
- `PATCH /api/v1/stacks/:id/draft`
- `GET /api/v1/stacks/:id/draft`

## Editor States

- `draft`
- `dirty`
- `saving`
- `saved`
- `error`

`StackEditorController` drives these states without assuming a specific UI
framework. It keeps local section edits, schedules autosave after a debounce
window, retries transient failures with exponential backoff, and exposes the
current preview.

## Draft Contract

```typescript
type StackDraft = {
  stackId: string;
  creatorId: string;
  revision: number;
  status: "draft";
  sections: Array<{ id: string; type: string; content: string; order: number }>;
  updatedAt: string;
};
```

## Templates and Recovery

- Known templates scaffold ordered section blocks for creator drafts.
- Missing template ids fall back to a blank but valid scaffold.
- `recoverDraft` reloads the latest persisted snapshot after interrupted saves.

## RBAC and Conflicts

- Creator owners need `creator:stack:draft:self`.
- Admin overrides use `creator:stack:draft:any`.
- Conflicting revision saves fail with `DRAFT_REVISION_CONFLICT`.

## Observability

- `draft_autosave_success_total`
- `draft_autosave_failure_total`
- `draft_conflict_total`
- `draft_recovery_success_total`

Save diagnostics are captured as draft save events with source, revision,
attempt, latency, and outcome.
