import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TerminologyRepository,
  TerminologyRepositoryError,
  type TerminologyArchive,
  type TerminologyEntry,
} from "../src/terminology-repository.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lightee-terminology-repository-"));
  roots.push(root);
  return root;
}

function archiveEntry(archive: string, entry: TerminologyEntry) {
  return { archive, entry } as { archive: TerminologyArchive; entry: TerminologyEntry };
}

describe("TerminologyRepository", () => {
  it("migrates all legacy archives, preserves metadata, and repairs projections from the snapshot", async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, "terminology"), { recursive: true });
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "terminology", "names.json"), JSON.stringify([{ id: "name-1", ja: "アリス", zh: "爱丽丝", reading: "ありす" }]), "utf8");
    await writeFile(join(root, "terminology", "terms.json"), JSON.stringify([
      { ja: "缺失ID", zh: "缺失 ID", type: "term" },
      { id: "dup", ja: "重复一", zh: "重复一", type: "term" },
      { id: "dup", ja: "重复二", zh: "重复二", type: "term" },
    ]), "utf8");
    await writeFile(join(root, "terminology", "voice.json"), JSON.stringify([{ id: "voice-1", character: "ボブ", selfRefJa: "俺", selfRefZh: "我", zhStrategy: "偏口语" }]), "utf8");
    await writeFile(join(root, "terminology", "onomatopoeia.json"), JSON.stringify([{ id: "ono-1", ja: "ざあざあ", zh: "哗啦", strategy: "translate" }]), "utf8");
    await writeFile(join(root, "terminology", "puns.json"), JSON.stringify([{ ja: "桧山灯", zh: "小灯", note: "读音双关" }]), "utf8");

    const repository = new TerminologyRepository(root);
    const migrated = await repository.readSnapshot();
    expect(migrated.revision).toBe(0);
    expect(migrated.archives.names[0]).toMatchObject({ id: "name-1", reading: "ありす" });
    expect(migrated.archives.terms.map((entry) => entry.id)).toEqual(["terms:entry-1", "dup", "dup-2"]);
    expect(migrated.archives.voice[0]).toMatchObject({ character: "ボブ", selfRefJa: "俺" });
    expect(migrated.archives.puns[0]).toMatchObject({ id: "entry-1", note: "读音双关" });

    await rm(join(root, "terminology", "voice.json"));
    const repaired = await repository.readSnapshot();
    expect(JSON.parse(await readFile(join(root, "terminology", "voice.json"), "utf8"))).toEqual(repaired.archives.voice);
  });

  it("commits archive merges once and makes retries idempotent", async () => {
    const root = await makeWorkspace();
    const repository = new TerminologyRepository(root);
    const first = await repository.mergeEntries({
      operationId: "confirm-1",
      baseRevision: 0,
      action: "confirmed",
      entries: [
        archiveEntry("names", { id: "name-1", ja: "アリス", zh: "爱丽丝" }),
        archiveEntry("puns", { ja: "桧山灯", zh: "小灯", note: "读音双关" }),
      ],
    });
    expect(first.commit).toMatchObject({ revision: 1, operationId: "confirm-1", action: "confirmed", archives: ["names", "puns"] });

    const retry = await repository.mergeEntries({
      operationId: "confirm-1",
      baseRevision: 0,
      action: "confirmed",
      entries: [
        archiveEntry("names", { id: "name-1", ja: "アリス", zh: "爱丽丝" }),
        archiveEntry("puns", { ja: "桧山灯", zh: "小灯", note: "读音双关" }),
      ],
    });
    expect(retry.commit).toEqual(first.commit);
    const snapshot = await repository.readSnapshot();
    expect(snapshot.revision).toBe(1);
    expect(snapshot.archives.names).toHaveLength(1);
    expect(snapshot.archives.puns).toHaveLength(1);
    expect(await repository.readEvents()).toHaveLength(1);
  });

  it("promotes a pending legacy row when confirmation commits the matching entry", async () => {
    const root = await makeWorkspace();
    const repository = new TerminologyRepository(root);
    await repository.mergeEntries({
      operationId: "prepare-pending",
      baseRevision: 0,
      action: "prepared",
      entries: [archiveEntry("terms", { id: "pending-1", ja: "待确认", zh: "临时译名", type: "term", pending: true })],
    });
    const confirmed = await repository.mergeEntries({
      operationId: "confirm-pending",
      baseRevision: 1,
      action: "confirmed",
      entries: [archiveEntry("terms", { id: "pending-1", ja: "待确认", zh: "正式译名", type: "term" })],
    });
    expect(confirmed.snapshot.archives.terms[0]).toMatchObject({ id: "pending-1", zh: "正式译名", pending: false, status: "confirmed" });
    expect(confirmed.commit).toMatchObject({ revision: 2, archives: ["terms"] });
  });

  it("records same-revision status progress idempotently for external confirmation", async () => {
    const root = await makeWorkspace();
    const repository = new TerminologyRepository(root);
    const first = await repository.recordStatus("confirm-progress-1");
    const retry = await repository.recordStatus("confirm-progress-1");
    expect(first.commit).toMatchObject({ action: "status", revision: 0, archives: [] });
    expect(retry.commit).toEqual(first.commit);
    expect((await repository.readSnapshot()).revision).toBe(0);
    expect(await repository.readEvents()).toHaveLength(1);
  });

  it("uses the same terminology revision for terms update/delete/restore and rejects stale writers", async () => {
    const root = await makeWorkspace();
    const repository = new TerminologyRepository(root);
    await repository.mergeEntries({
      operationId: "seed-terms",
      baseRevision: 0,
      action: "prepared",
      entries: [archiveEntry("terms", { id: "t1", ja: "第一", zh: "第一", type: "term" })],
    });

    const updated = await repository.mutateTerms({ operationId: "update-1", action: "updated", termId: "t1", baseRevision: 1, patch: { ja: "第一", zh: "次要", type: "term" } });
    expect(updated.commit).toMatchObject({ revision: 2, action: "updated", archives: ["terms"] });
    const stale = repository.mutateTerms({ operationId: "stale", action: "deleted", termId: "t1", baseRevision: 1 });
    await expect(stale).rejects.toMatchObject({ code: "conflict" });

    const deleted = await repository.mutateTerms({ operationId: "delete-1", action: "deleted", termId: "t1", baseRevision: 2 });
    expect(deleted.commit).toMatchObject({ revision: 3, action: "deleted" });
    expect(deleted.snapshot.trash).toMatchObject([{ item: { id: "t1", zh: "次要" }, originalIndex: 0 }]);
    const restored = await repository.mutateTerms({ operationId: "restore-1", action: "restored", termId: "t1", baseRevision: 3 });
    expect(restored.commit).toMatchObject({ revision: 4, action: "restored" });
    expect(restored.snapshot.archives.terms).toMatchObject([{ id: "t1", zh: "次要" }]);

    await expect(repository.mutateTerms({ operationId: "missing", action: "deleted", termId: "missing", baseRevision: 4 })).rejects.toBeInstanceOf(TerminologyRepositoryError);
    expect((await repository.readSnapshot()).revision).toBe(4);
  });

  it("recovers projections, revision mirrors, and the event record after a partial boundary", async () => {
    const root = await makeWorkspace();
    const repository = new TerminologyRepository(root);
    const committed = await repository.mergeEntries({
      operationId: "recover-me",
      baseRevision: 0,
      action: "confirmed",
      entries: [archiveEntry("terms", { id: "recover-1", ja: "恢复术语", zh: "恢复译名", type: "term" })],
    });
    const secondCommit = await repository.mergeEntries({
      operationId: "recover-me-2",
      baseRevision: 1,
      action: "confirmed",
      entries: [archiveEntry("names", { id: "recover-name", ja: "恢复名称", zh: "恢复名称" })],
    });
    await writeFile(join(root, "terminology", "terms.json"), "[]", "utf8");
    await writeFile(join(root, "terminology", "names.json"), "{broken", "utf8");
    await writeFile(join(root, "state", "ipc-revisions.json"), JSON.stringify({ terms: 0, terminology: 0 }), "utf8");
    await rm(join(root, "state", "terminology-events.jsonl"), { force: true });
    const recovered = await repository.readSnapshot();
    expect(recovered.revision).toBe(2);
    expect(JSON.parse(await readFile(join(root, "terminology", "terms.json"), "utf8"))).toEqual(recovered.archives.terms);
    expect(JSON.parse(await readFile(join(root, "terminology", "names.json"), "utf8"))).toEqual(recovered.archives.names);
    expect(JSON.parse(await readFile(join(root, "state", "ipc-revisions.json"), "utf8"))).toMatchObject({ terms: 2, terminology: 2 });
    expect(await repository.readEvents()).toEqual([committed.commit, secondCommit.commit]);
  });

  it("keeps operation idempotency after the bounded snapshot history rolls over", async () => {
    const root = await makeWorkspace();
    const repository = new TerminologyRepository(root);
    const first = await repository.mergeEntries({ operationId: "long-lived-1", baseRevision: 0, action: "confirmed", entries: [archiveEntry("puns", { id: "p-1", ja: "梗1", zh: "梗1" })] });
    for (let index = 2; index <= 101; index += 1) {
      await repository.mergeEntries({ operationId: `long-lived-${index}`, baseRevision: index - 1, action: "confirmed", entries: [archiveEntry("puns", { id: `p-${index}`, ja: `梗${index}`, zh: `梗${index}` })] });
    }
    const replay = await repository.mergeEntries({ operationId: "long-lived-1", baseRevision: 0, action: "confirmed", entries: [archiveEntry("puns", { id: "p-1", ja: "梗1", zh: "梗1" })] });
    expect(replay.commit).toEqual(first.commit);
    expect(replay.snapshot.revision).toBe(101);
    expect(replay.snapshot.archives.puns).toHaveLength(101);
    // 102 次串行提交，每次都要抢锁、写快照、修 8 个投影文件、追加事件——本地 SSD 约 1.7s，
    // GitHub 的 windows runner 上超过默认的 5s 就红。这条测的是历史滚出去之后幂等还成立，
    // 不是它跑得多快；用默认超时等于让磁盘速度决定门禁颜色。
  }, 60_000);

  it("serializes two repository instances with a single workspace revision", async () => {
    const root = await makeWorkspace();
    const first = new TerminologyRepository(root);
    const second = new TerminologyRepository(root);
    const results = await Promise.allSettled([
      first.mergeEntries({ operationId: "writer-a", baseRevision: 0, action: "confirmed", entries: [archiveEntry("terms", { id: "a", ja: "甲", zh: "甲" })] }),
      second.mergeEntries({ operationId: "writer-b", baseRevision: 0, action: "confirmed", entries: [archiveEntry("terms", { id: "b", ja: "乙", zh: "乙" })] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await first.readSnapshot()).revision).toBe(1);
  });
});

describe("R1 字典档案", () => {
  it("三类字典档案参与迁移、投影与提交，naturalKey 按各自身份去重", async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, "terminology"), { recursive: true });
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "terminology", "pre-dict.json"), JSON.stringify([{ find: "―", replace: "——" }]), "utf8");
    await writeFile(join(root, "terminology", "post-dict.json"), JSON.stringify([{ find: "的的", replace: "的" }]), "utf8");
    await writeFile(join(root, "terminology", "no-translate.json"), JSON.stringify([{ ja: "Wi-Fi" }]), "utf8");

    const repository = new TerminologyRepository(root);
    const migrated = await repository.readSnapshot();
    expect(migrated.archives.preDict[0]).toMatchObject({ find: "―", replace: "——" });
    expect(migrated.archives.postDict[0]).toMatchObject({ find: "的的" });
    expect(migrated.archives.noTranslate[0]).toMatchObject({ ja: "Wi-Fi" });

    // 身份只看 find：同一 find 换个 replace 不产生第二条规则（两条会依次执行，等于埋雷）
    const first = await repository.mergeEntries({
      operationId: "dict-1",
      baseRevision: 0,
      action: "created",
      entries: [archiveEntry("postDict", { find: "的的", replace: "的地" })],
    });
    expect(first.snapshot.archives.postDict).toHaveLength(1);

    // 改替换文本走 mutateTerms 的 patch 通道（与术语编辑同一条路径）
    const patched = await repository.mutateTerms({
      operationId: "dict-1-edit",
      action: "updated",
      archive: "postDict",
      termId: String(first.snapshot.archives.postDict[0]!.id),
      baseRevision: first.snapshot.revision,
      patch: { replace: "的地" },
    });
    expect(patched.snapshot.archives.postDict[0]).toMatchObject({ find: "的的", replace: "的地" });

    const second = await repository.mergeEntries({
      operationId: "dict-2",
      baseRevision: patched.snapshot.revision,
      action: "created",
      entries: [archiveEntry("noTranslate", { ja: "Bluetooth" })],
    });
    expect(second.snapshot.archives.noTranslate.map((entry) => entry.ja)).toEqual(["Wi-Fi", "Bluetooth"]);
    expect(second.commit?.archives).toEqual(["noTranslate"]);

    // 投影文件与快照一致（旧读者仍按文件读）
    expect(JSON.parse(await readFile(join(root, "terminology", "no-translate.json"), "utf8"))).toEqual(second.snapshot.archives.noTranslate);
  });
});
