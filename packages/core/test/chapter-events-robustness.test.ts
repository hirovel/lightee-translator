import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChapterStateStore, CHAPTER_EVENTS_COMPACT_THRESHOLD } from "../src/chapter-state.js";

/**
 * RH-14（架构评估 A-2 / B-6）：事件日志是审计轨迹，不是运行时判定依据。
 * 追加写非原子 → 一次断电就能留下半行；旧实现任一行不合法即 throw，
 * 结果是整个工作区的 chapter.load 全部失败。
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspaceWithApprovedChapter() {
  const root = await mkdtemp(join(tmpdir(), "lightee-events-"));
  roots.push(root);
  const store = new ChapterStateStore(root);
  await store.ensureChapter("ch001");
  await store.transition("ch001", "ready");
  await store.transition("ch001", "translating");
  await store.transition("ch001", "translated");
  await store.transition("ch001", "reviewing");
  await store.transition("ch001", "approved");
  return { root, store, eventsPath: join(root, "state", "events.jsonl") };
}

describe("事件日志损坏恢复", () => {
  it("末尾半行（断电截断）→ 保留有效前缀、坏尾截掉、另存 .recovered-*", async () => {
    const { root, store, eventsPath } = await workspaceWithApprovedChapter();
    const before = await store.readEvents();
    await appendFile(eventsPath, '{"formatVersion":1,"eventId":"half', "utf8");

    const after = await store.readEvents();
    expect(after.map((event) => event.eventId)).toEqual(before.map((event) => event.eventId));

    const rewritten = await readFile(eventsPath, "utf8");
    expect(rewritten).not.toContain("half");
    expect(rewritten.trim().split("\n")).toHaveLength(before.length);

    const backups = (await readdir(join(root, "state"))).filter((name) => name.includes(".recovered-"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(root, "state", backups[0]!), "utf8")).toContain("half");

    // 状态读取不受影响
    expect(await store.readChapter("ch001")).toMatchObject({ state: "approved", everApproved: true });
  });

  it("中段损坏 → 整个文件隔离为 .corrupt-*，日志重建，状态仍以快照为准", async () => {
    const { root, store, eventsPath } = await workspaceWithApprovedChapter();
    const lines = (await readFile(eventsPath, "utf8")).trim().split("\n");
    expect(lines.length).toBeGreaterThan(2);
    lines[1] = "{ 这不是 JSON";
    await writeFile(eventsPath, lines.join("\n") + "\n", "utf8");

    expect(await store.readEvents()).toEqual([]);
    const quarantined = (await readdir(join(root, "state"))).filter((name) => name.includes(".corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(eventsPath, "utf8")).toBe("");
    expect(await store.readChapter("ch001")).toMatchObject({ state: "approved", everApproved: true });
  });

  it("损坏后事务仍可继续推进状态（不再抛 invalid_events）", async () => {
    const { store, eventsPath } = await workspaceWithApprovedChapter();
    await appendFile(eventsPath, "not json at all\n", "utf8");
    const next = await store.transition("ch001", "translating", { reason: "author edit" });
    expect(next).toMatchObject({ state: "translating", everApproved: true });
  });
});

describe("everApproved", () => {
  it("进入 approved 后置位，且离开 approved 也不回退", async () => {
    const { root, store } = await workspaceWithApprovedChapter();
    expect(await store.readChapter("ch001")).toMatchObject({ everApproved: true });
    await store.transition("ch001", "translating", { reason: "author edit" });
    expect(await new ChapterStateStore(root).readChapter("ch001")).toMatchObject({ state: "translating", everApproved: true });
  });

  it("旧格式快照（无该字段）经一次事务从事件日志迁移并回写", async () => {
    const { root, store } = await workspaceWithApprovedChapter();
    await store.transition("ch001", "translating", { reason: "author edit" });

    // 模拟旧数据：删掉全部 everApproved 字段
    const statePath = join(root, "state", "chapter_state.json");
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    for (const status of Object.values(raw.chapters as Record<string, Record<string, unknown>>)) delete status.everApproved;
    delete (raw.lastEvent as { status?: Record<string, unknown> } | null)?.status?.everApproved;
    await writeFile(statePath, JSON.stringify(raw, null, 2) + "\n", "utf8");

    const migrated = new ChapterStateStore(root);
    await migrated.withTransaction(async () => undefined);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    expect(persisted.chapters.ch001.everApproved).toBe(true);
  });

  it("从未 approved 的旧章节迁移后为 false", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-events-"));
    roots.push(root);
    const store = new ChapterStateStore(root);
    await store.ensureChapter("ch001");
    await store.transition("ch001", "ready");

    const statePath = join(root, "state", "chapter_state.json");
    const raw = JSON.parse(await readFile(statePath, "utf8"));
    for (const status of Object.values(raw.chapters as Record<string, Record<string, unknown>>)) delete status.everApproved;
    await writeFile(statePath, JSON.stringify(raw, null, 2) + "\n", "utf8");

    await new ChapterStateStore(root).withTransaction(async () => undefined);
    expect(JSON.parse(await readFile(statePath, "utf8")).chapters.ch001.everApproved).toBe(false);
  });
});

describe("事件日志压缩", () => {
  it("超过阈值时归档旧事件，保留 approved 轨迹，快照不变", async () => {
    const { root, store, eventsPath } = await workspaceWithApprovedChapter();
    const snapshotBefore = await store.readSnapshot();
    const real = (await readFile(eventsPath, "utf8")).trim().split("\n");
    const approvedLine = real.find((line) => JSON.parse(line).to === "approved")!;
    // 用真实事件行灌满日志（复制 ready 转移行并换 eventId），触发压缩
    const template = JSON.parse(real.find((line) => JSON.parse(line).to === "ready")!);
    const filler: string[] = [];
    for (let index = 0; index < CHAPTER_EVENTS_COMPACT_THRESHOLD + 10; index++) {
      filler.push(JSON.stringify({ ...template, eventId: `filler-${index}` }));
    }
    await writeFile(eventsPath, [...filler, approvedLine].join("\n") + "\n", "utf8");

    await store.withTransaction(async () => undefined);

    const kept = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(kept.length).toBeLessThan(CHAPTER_EVENTS_COMPACT_THRESHOLD);
    expect(kept.some((event) => event.to === "approved")).toBe(true);
    const archives = (await readdir(join(root, "state"))).filter((name) => name.startsWith("events.archive-"));
    expect(archives).toHaveLength(1);

    const snapshotAfter = await store.readSnapshot();
    expect(snapshotAfter.chapters).toEqual(snapshotBefore.chapters);
  });
});
