import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutosaveController, MemoryDraftAdapter, MemorySourceCorrectionAdapter, SourceCorrectionController } from "./autosave";

function paragraph(id: string, translation: string) {
  return { id, source: `原文 ${id}`, translation };
}

describe("AutosaveController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid edits into a single save after the delay", async () => {
    const adapter = new MemoryDraftAdapter("ws", "ch1");
    const controller = new AutosaveController({ adapter, workspaceId: "ws", chapterId: "ch1", delayMs: 600 });

    controller.markModified([paragraph("p0001", "甲")]);
    controller.markModified([paragraph("p0001", "甲乙")]);
    controller.markModified([paragraph("p0001", "甲乙丙")]);
    expect(adapter.saveCallCount).toBe(0);
    expect(controller.getState().phase).toBe("modified");

    await vi.advanceTimersByTimeAsync(599);
    expect(adapter.saveCallCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1); // debounce fires; save starts
    expect(adapter.saveCallCount).toBe(1);
    expect(controller.getState().phase).toBe("saving");
    await vi.advanceTimersByTimeAsync(1); // adapter latency settles
    expect(controller.getState().phase).toBe("saved");
    expect(controller.getState().baseRevision).toBe(1);
    expect(adapter.snapshot()).toEqual([paragraph("p0001", "甲乙丙")]);
  });

  it("keeps the draft dirty when the save fails and allows a retry", async () => {
    const adapter = new MemoryDraftAdapter("ws", "ch1");
    const controller = new AutosaveController({ adapter, workspaceId: "ws", chapterId: "ch1", delayMs: 600 });
    adapter.failNext = true;

    controller.markModified([paragraph("p0001", "甲")]);
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getState().phase).toBe("failed");
    expect(controller.getState().baseRevision).toBe(0);
    expect(adapter.getRevision()).toBe(0);

    const retry = controller.flush();
    await vi.advanceTimersByTimeAsync(1);
    await retry;
    expect(adapter.saveCallCount).toBe(2);
    expect(controller.getState().phase).toBe("saved");
    expect(adapter.snapshot()).toEqual([paragraph("p0001", "甲")]);
  });

  it("enters conflict state when the base revision is stale", async () => {
    const adapter = new MemoryDraftAdapter("ws", "ch1");
    const controller = new AutosaveController({ adapter, workspaceId: "ws", chapterId: "ch1", delayMs: 600 });
    adapter.conflictNext = true;

    controller.markModified([paragraph("p0001", "甲")]);
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getState().phase).toBe("conflict");
    expect(adapter.getRevision()).toBe(0);
  });

  it("saves immediately and checkpoints on saveNow without a double save", async () => {
    const adapter = new MemoryDraftAdapter("ws", "ch1");
    const controller = new AutosaveController({ adapter, workspaceId: "ws", chapterId: "ch1", delayMs: 600 });

    controller.markModified([paragraph("p0001", "甲")]);
    const saving = controller.saveNow(true);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    const state = await saving;
    expect(adapter.saveCallCount).toBe(1);
    expect(adapter.checkpointCallCount).toBe(1);
    expect(state.phase).toBe("saved");
    expect(state.baseRevision).toBe(1);
    expect(state.checkpointPath).toBe("state/checkpoints/ch1.json");

    await vi.advanceTimersByTimeAsync(700);
    expect(adapter.saveCallCount).toBe(1);
  });

  it("does not lose edits that arrive while a debounced save is in flight", async () => {
    const adapter = new MemoryDraftAdapter("ws", "ch1");
    const controller = new AutosaveController({ adapter, workspaceId: "ws", chapterId: "ch1", delayMs: 600 });

    controller.markModified([paragraph("p0001", "甲")]);
    await vi.advanceTimersByTimeAsync(600);
    controller.markModified([paragraph("p0001", "甲乙")]);
    expect(adapter.saveCallCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1); // first save completes; follow-up scheduled
    expect(controller.getState().phase).toBe("modified");
    expect(adapter.snapshot()).toEqual([paragraph("p0001", "甲")]);
    await vi.advanceTimersByTimeAsync(600); // follow-up debounce fires
    expect(adapter.saveCallCount).toBe(2);
    await vi.advanceTimersByTimeAsync(1); // follow-up save completes
    expect(adapter.snapshot()).toEqual([paragraph("p0001", "甲乙")]);
    expect(controller.getState().phase).toBe("saved");
  });

  it("drains edits that arrive during an explicit navigation flush", async () => {
    const adapter = new MemoryDraftAdapter("ws", "ch1");
    adapter.latencyMs = 10;
    const controller = new AutosaveController({ adapter, workspaceId: "ws", chapterId: "ch1", delayMs: 600 });

    controller.markModified([paragraph("p0001", "甲")]);
    const flushPromise = controller.flush();
    controller.markModified([paragraph("p0001", "甲乙")]);

    await vi.advanceTimersByTimeAsync(10);
    expect(adapter.saveCallCount).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    await flushPromise;

    expect(controller.getState().phase).toBe("saved");
    expect(adapter.snapshot()).toEqual([paragraph("p0001", "甲乙")]);
  });

  it("keeps same-named chapters isolated by immutable workspace sessions", async () => {
    const aAdapter = new MemoryDraftAdapter("A", "ch001");
    const bAdapter = new MemoryDraftAdapter("B", "ch001");
    const a = new AutosaveController({ adapter: aAdapter, workspaceId: "A", chapterId: "ch001" });
    const b = new AutosaveController({ adapter: bAdapter, workspaceId: "B", chapterId: "ch001" });

    a.markModified([paragraph("p0001", "A 的译文")]);
    b.markModified([paragraph("p0001", "B 的译文")]);
    const saves = Promise.all([a.flush(), b.flush()]);
    await vi.advanceTimersByTimeAsync(1);
    await saves;

    expect(aAdapter.snapshot()).toEqual([paragraph("p0001", "A 的译文")]);
    expect(bAdapter.snapshot()).toEqual([paragraph("p0001", "B 的译文")]);
  });

  it("reset clears pending draft and restores a fresh base revision", async () => {
    const adapter = new MemoryDraftAdapter("ws", "ch1");
    const controller = new AutosaveController({ adapter, workspaceId: "ws", chapterId: "ch1", delayMs: 600 });

    controller.markModified([paragraph("p0001", "甲")]);
    controller.reset(5);
    expect(controller.getState().phase).toBe("idle");
    expect(controller.getState().baseRevision).toBe(5);

    await vi.advanceTimersByTimeAsync(700);
    expect(adapter.saveCallCount).toBe(0);
  });
});

describe("SourceCorrectionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces source edits and keeps its own revision", async () => {
    const adapter = new MemorySourceCorrectionAdapter();
    const controller = new SourceCorrectionController({ adapter, workspaceId: "ws", chapterId: "ch1", delayMs: 600 });
    controller.markModified("修正后的原文");
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.saveCallCount).toBe(1);
    expect(adapter.source).toBe("修正后的原文");
    expect(controller.getState()).toMatchObject({ phase: "saved", baseRevision: 1 });
  });

  it("keeps source correction dirty after a failure and retries", async () => {
    const adapter = new MemorySourceCorrectionAdapter();
    const controller = new SourceCorrectionController({ adapter, workspaceId: "ws", chapterId: "ch1", delayMs: 600 });
    adapter.failNext = true;
    controller.markModified("失败后保留");
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getState().phase).toBe("failed");
    await controller.saveNow();
    expect(controller.getState().phase).toBe("saved");
    expect(adapter.source).toBe("失败后保留");
  });

  it("drains source edits that arrive during an explicit navigation flush", async () => {
    const adapter = new MemorySourceCorrectionAdapter();
    adapter.latencyMs = 10;
    const controller = new SourceCorrectionController({ adapter, workspaceId: "ws", chapterId: "ch1", delayMs: 600 });

    controller.markModified("第一版");
    const flush = controller.flush();
    controller.markModified("第二版");
    await vi.advanceTimersByTimeAsync(10);
    expect(adapter.saveCallCount).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    await flush;

    expect(adapter.source).toBe("第二版");
    expect(controller.getState()).toMatchObject({ phase: "saved", baseRevision: 2 });
  });

  it("reports a stale source revision as conflict", async () => {
    const adapter = new MemorySourceCorrectionAdapter();
    const controller = new SourceCorrectionController({ adapter, workspaceId: "ws", chapterId: "ch1", delayMs: 600 });
    adapter.conflictNext = true;
    controller.markModified("冲突原文");
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getState().phase).toBe("conflict");
  });
});
