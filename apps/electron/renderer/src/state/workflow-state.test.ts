import { describe, expect, it } from "vitest";
import type { ChapterStateChangedPayload, ChapterWorkflowSnapshot } from "../../../shared/ipc-contract";
import { ChapterWorkflowStore, translationStatusFromChapterState } from "./workflow-state";

const snapshot: ChapterWorkflowSnapshot = {
  chapterId: "ch001",
  state: "translating",
  version: 0,
  reviseCount: 0,
  attempt: 1,
  retryCount: 0,
  lastError: null,
  lastReason: "translator started",
  lastActivityAt: "2026-07-31T00:00:00.000Z",
  userModified: false,
  recheckReason: null,
  runId: "run-1",
  transitionCount: 2,
  everApproved: false,
};

describe("ChapterWorkflowStore", () => {
  it("hydrates durable state and applies only matching typed events", () => {
    const store = new ChapterWorkflowStore("ws-1", "ch001");
    expect(store.hydrate(snapshot)).toMatchObject({ state: "translating", attempt: 1 });

    const event: ChapterStateChangedPayload = {
      workspaceId: "ws-1",
      chapterId: "ch001",
      from: "translating",
      to: "approved",
      reason: "clean review",
      runId: "run-1",
      state: { ...snapshot, state: "approved", version: 1, lastReason: "clean review", transitionCount: 3 },
    };
    expect(store.apply(event)).toMatchObject({ state: "approved", version: 1 });
    expect(store.apply({ ...event, from: "translating", to: "ready", state: { ...snapshot, state: "ready", transitionCount: 1 } })).toMatchObject({ state: "approved", version: 1 });
    expect(store.hydrate({ ...snapshot, state: "ready", transitionCount: 1 })).toMatchObject({ state: "approved", version: 1 });
    expect(translationStatusFromChapterState("reviewing")).toBe("needs-review");
    expect(translationStatusFromChapterState("stuck")).toBe("stuck");
    expect(translationStatusFromChapterState("approved")).toBe("approved");
  });

  it("rejects a state event for another workspace or chapter", () => {
    const store = new ChapterWorkflowStore("ws-1", "ch001");
    expect(() => store.apply({
      workspaceId: "ws-2",
      chapterId: "ch001",
      from: "ready",
      to: "translating",
      reason: "wrong target",
      runId: "run-2",
      state: snapshot,
    })).toThrow(/not ws-1\/ch001/);
  });
});
