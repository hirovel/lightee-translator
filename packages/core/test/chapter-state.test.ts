import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChapterStateStore, ChapterStateStoreError } from "../src/chapter-state.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ChapterStateStore", () => {
  it("creates a missing snapshot and records ordered legal transitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-chapter-state-"));
    roots.push(root);
    const store = new ChapterStateStore(root);

    expect((await store.readSnapshot()).chapters).toEqual({});
    expect(await store.ensureChapter("ch001")).toMatchObject({ chapterId: "ch001", state: "imported" });
    await store.transition("ch001", "ready", { runId: "run-1", reason: "source imported" });
    await store.transition("ch001", "translating", { runId: "run-1", reason: "translator started" });
    await store.transition("ch001", "translated", { runId: "run-1", reason: "translation staged" });
    await store.transition("ch001", "reviewing", { runId: "run-1", reason: "review started" });
    const approved = await store.transition("ch001", "approved", { runId: "run-1", reason: "no high issues" });

    expect(approved).toMatchObject({
      chapterId: "ch001",
      state: "approved",
      version: 1,
      attempt: 1,
      retryCount: 0,
      reviseCount: 0,
      runId: "run-1",
      lastReason: "no high issues",
    });
    const snapshot = await store.readSnapshot();
    expect(snapshot.chapters.ch001).toMatchObject({ state: "approved", version: 1 });
    const events = await store.readEvents();
    expect(events.map((event) => `${event.from}->${event.to}`)).toEqual([
      "imported->ready",
      "ready->translating",
      "translating->translated",
      "translated->reviewing",
      "reviewing->approved",
    ]);
    expect(events.every((event) => event.runId === "run-1" && event.status.chapterId === "ch001")).toBe(true);
    expect((await store.readSnapshot()).lastEvent?.eventId).toBe(events.at(-1)?.eventId);
    expect(await readFile(join(root, "state", "chapter_state.json"), "utf8")).toContain('"formatVersion": 1');
  });

  it("repairs an event missing after a snapshot write on the next transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-chapter-state-"));
    roots.push(root);
    const store = new ChapterStateStore(root);
    await store.transition("ch001", "ready", { runId: "repair", reason: "first transition" });
    await rm(join(root, "state", "events.jsonl"), { force: true });
    await store.ensureChapter("ch001");
    expect(await store.readEvents()).toHaveLength(1);
    expect((await store.readEvents())[0]?.to).toBe("ready");
  });

  it("persists translator attempts separately from review revisions and retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-chapter-state-"));
    roots.push(root);
    const store = new ChapterStateStore(root);
    await store.transition("ch001", "ready", { runId: "run-1" });
    await store.transition("ch001", "translating", { runId: "run-1" });
    const failed = await store.transition("ch001", "ready", { runId: "run-1", reason: "LLM unavailable", lastError: "timeout" });
    expect(failed).toMatchObject({ state: "ready", attempt: 1, retryCount: 1, reviseCount: 0, lastError: "timeout" });
    const resumed = await store.transition("ch001", "translating", { runId: "run-2", reason: "retry" });
    expect(resumed).toMatchObject({ state: "translating", attempt: 2, retryCount: 1, lastError: null, runId: "run-2" });
  });

  it("rejects malformed snapshots instead of silently losing workflow state", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-chapter-state-"));
    roots.push(root);
    const store = new ChapterStateStore(root);
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "state", "chapter_state.json"), JSON.stringify({ formatVersion: 99, chapters: {} }), "utf8");
    await expect(store.readSnapshot()).rejects.toBeInstanceOf(ChapterStateStoreError);
    await expect(store.readSnapshot()).rejects.toMatchObject({ code: "invalid_snapshot" });
    await writeFile(join(root, "state", "chapter_state.json"), "{", "utf8");
    await expect(store.readSnapshot()).rejects.toMatchObject({ code: "invalid_snapshot" });
  });

  it("rejects illegal transitions without appending an event", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-chapter-state-"));
    roots.push(root);
    const store = new ChapterStateStore(root);
    await expect(store.transition("ch001", "approved")).rejects.toThrow(/非法状态转移/);
    expect(await store.readEvents()).toEqual([]);
    expect((await store.readSnapshot()).chapters).toEqual({});
  });

  it("removeChapter drops the workflow record; restoreChapter puts it back", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-chapter-state-"));
    roots.push(root);
    const store = new ChapterStateStore(root);
    const status = await store.ensureChapter("ch001");
    await store.transition("ch001", "ready", { runId: "run-1", reason: "source imported" });
    await store.transition("ch001", "translating", { runId: "run-1", reason: "translator started" });
    const beforeRemove = await store.readChapter("ch001");
    expect(beforeRemove.state).toBe("translating");

    // 删除：记录消失，但事件日志保留（append-only 审计）
    expect(await store.removeChapter("ch001")).toBe(true);
    expect((await store.readSnapshot()).chapters["ch001"]).toBeUndefined();
    expect((await store.readChapter("ch001")).state).toBe("imported"); // 未找到→初始态
    expect(await store.removeChapter("ch001")).toBe(false); // 幂等：再删返回 false
    const events = await store.readEvents();
    expect(events.length).toBeGreaterThan(0);

    // 恢复：原状态放回（含版本/attempt/runId）
    expect(await store.restoreChapter("ch001", beforeRemove)).toBe(true);
    const restored = await store.readChapter("ch001");
    expect(restored.state).toBe("translating");
    expect(restored.attempt).toBe(beforeRemove.attempt);
    expect(restored.runId).toBe(beforeRemove.runId);
    // 恢复不追加事件（审计链干净）
    expect((await store.readEvents()).length).toBe(events.length);
  });
});
