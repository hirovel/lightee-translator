import type { ChapterStateChangedPayload, ChapterWorkflowSnapshot, ChapterWorkflowState, TranslationWorkflowStatus } from "../../../shared/ipc-contract";

export function translationStatusFromChapterState(state: ChapterWorkflowState): TranslationWorkflowStatus {
  return state === "approved" ? "approved" : state === "stuck" ? "stuck" : "needs-review";
}

export class ChapterWorkflowStore {
  private snapshot: ChapterWorkflowSnapshot | null = null;

  constructor(private readonly workspaceId: string, private readonly chapterId: string) {}

  hydrate(snapshot: ChapterWorkflowSnapshot): ChapterWorkflowSnapshot {
    if (snapshot.chapterId !== this.chapterId) {
      throw new Error(`Workflow snapshot belongs to ${snapshot.chapterId}, not ${this.chapterId}`);
    }
    if (this.snapshot && snapshot.transitionCount < this.snapshot.transitionCount) return this.get()!;
    this.snapshot = { ...snapshot };
    return this.get()!;
  }

  apply(event: ChapterStateChangedPayload): ChapterWorkflowSnapshot | null {
    this.assertIdentity(event.workspaceId, event.chapterId);
    if (event.state.chapterId !== this.chapterId) throw new Error(`Workflow event state belongs to ${event.state.chapterId}`);
    if (this.snapshot) {
      // Renderer events are notifications, not an authority to rewind a newer
      // hydrated state or to apply a duplicate/out-of-order transition.
      if (this.snapshot.state !== event.from) return this.get();
      if (event.state.transitionCount < this.snapshot.transitionCount || event.state.version < this.snapshot.version || event.state.reviseCount < this.snapshot.reviseCount || event.state.attempt < this.snapshot.attempt || event.state.retryCount < this.snapshot.retryCount) return this.get();
    }
    this.snapshot = { ...event.state };
    return this.get();
  }

  get(): ChapterWorkflowSnapshot | null {
    return this.snapshot ? { ...this.snapshot } : null;
  }

  private assertIdentity(workspaceId: string, chapterId: string): void {
    if (workspaceId !== this.workspaceId || chapterId !== this.chapterId) {
      throw new Error(`Workflow event belongs to ${workspaceId}/${chapterId}, not ${this.workspaceId}/${this.chapterId}`);
    }
  }
}
