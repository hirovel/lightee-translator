/**
 * 追溯改名接线（EX-06）—— 作者在术语面板改译法，已翻章节要跟着改。
 *
 * 这里测的是**接线**而不是窄门判据（判据在 engine/test/rename-repair.test.ts）：
 * `terms.update` 是否真的触发扫描、结果是否如实回报给界面、失败位置是否进得了复查队列。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIpcService, type EngineWiring } from "./ipc-service.js";
import {
  importFile,
  translateChapterToFile,
  runChapterPipeline,
  recoverChapterPromotion,
  recoverChapterPromotionInTransaction,
  reviewChapter,
  exportChapter,
  writeChapterParagraphs,
  type ChapterParagraph,
} from "@lightee/engine";
import type { RenameReviewResult, TermMutationResult } from "./ipc-contract.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(command: string, payload: unknown) {
  return { version: 1, requestId: `${command}-rename`, command, payload };
}

const wiring: EngineWiring = {
  importFile,
  translateChapterToFile,
  runChapterPipeline,
  recoverChapterPromotion,
  recoverChapterPromotionInTransaction,
  reviewChapter,
  exportChapter,
  runBookReview: async () => ({ runId: "run-1", report: { reportId: "b1", summary: { high: 0, medium: 0, low: 0 }, issues: [], scope: [] }, reportPath: "reviews/book/run-1/report.json" }),
  createLlm: () => ({ complete: async () => ({ text: "" }), listModels: () => [] }),
};

const para = (id: string, translation: string, extra: Partial<ChapterParagraph> = {}): ChapterParagraph => ({
  id, type: "body", source: "原文", translation, ...extra,
});

async function seed(paragraphs: ChapterParagraph[], terms: Array<Record<string, unknown>>) {
  const service = createIpcService({ engine: wiring });
  const root = await mkdtemp(join(tmpdir(), "lightee-rename-ipc-"));
  roots.push(root);
  const created = await service.invoke(envelope("workspace.create", { path: root, name: "追溯改名" }));
  if (!created.ok) throw new Error("workspace.create failed");
  const workspaceId = (created.value as { id: string }).id;
  const txt = join(root, "book.txt");
  await writeFile(txt, "第1章 初始\n\nテスト本文。\n", "utf8");
  const imported = await service.invoke(envelope("import.run", { workspaceId, sourcePath: txt }));
  if (!imported.ok) throw new Error("import.run failed");
  await mkdir(join(root, "terminology"), { recursive: true });
  await writeFile(join(root, "terminology", "terms.json"), JSON.stringify(terms), "utf8");
  await writeChapterParagraphs({ root }, "ch001", paragraphs, { staging: false });
  return { service, root, workspaceId };
}

async function revisionOf(service: ReturnType<typeof createIpcService>, workspaceId: string): Promise<number> {
  const queried = await service.invoke(envelope("terms.query", { workspaceId }));
  if (!queried.ok) throw new Error("terms.query failed");
  return (queried.value as { revision: number }).revision;
}

describe("terms.update 触发追溯改名（EX-06）", () => {
  it("改译法 → 已翻正文跟着改，结果如实回报给界面", async () => {
    const { service, root, workspaceId } = await seed(
      [para("p0001", "雏菜笑了。"), para("p0002", "他没有回头。")],
      [{ id: "t1", ja: "ヒナギク", zh: "雏菜" }],
    );
    const baseRevision = await revisionOf(service, workspaceId);

    const updated = await service.invoke(envelope("terms.update", {
      workspaceId, termId: "t1", archive: "terms", ja: "ヒナギク", zh: "雏", baseRevision,
    }));

    expect(updated.ok).toBe(true);
    const repair = (updated.ok ? updated.value as TermMutationResult : undefined)?.renameRepair;
    expect(repair).toMatchObject({ oldZh: "雏菜", newZh: "雏", replaced: 1, chapters: 1, queued: 0 });

    const md = await readFile(join(root, "translations", "ch001_zh.md"), "utf8");
    expect(md).toContain("雏笑了。");
    expect(md).not.toContain("雏菜");
  });

  it("窄门外的位置进复查队列，rename.review 读得到，rename.resolve 能销账", async () => {
    const { service, workspaceId } = await seed(
      [para("p0001", "雏菜笑了。", { translatedBy: "human" })],
      [{ id: "t1", ja: "ヒナギク", zh: "雏菜" }],
    );
    const baseRevision = await revisionOf(service, workspaceId);

    const updated = await service.invoke(envelope("terms.update", {
      workspaceId, termId: "t1", archive: "terms", ja: "ヒナギク", zh: "雏", baseRevision,
    }));
    expect(updated.ok).toBe(true);
    expect((updated.ok ? updated.value as TermMutationResult : undefined)?.renameRepair)
      .toMatchObject({ replaced: 0, queued: 1 });

    const listed = await service.invoke(envelope("rename.review", { workspaceId }));
    expect(listed.ok).toBe(true);
    const queue = listed.ok ? listed.value as RenameReviewResult : undefined;
    expect(queue?.pending).toBe(1);
    expect(queue?.entries[0]).toMatchObject({ chapterId: "ch001", paragraphId: "p0001", reason: "human_edited" });

    const resolved = await service.invoke(envelope("rename.resolve", { workspaceId, entryId: queue!.entries[0]!.id }));
    expect(resolved.ok && (resolved.value as { resolved: boolean }).resolved).toBe(true);

    const after = await service.invoke(envelope("rename.review", { workspaceId }));
    expect(after.ok && (after.value as RenameReviewResult).pending).toBe(0);
  });

  it("只改 ja / 改非术语档案 → 不触发扫描（renameRepair 缺席）", async () => {
    const { service, workspaceId } = await seed(
      [para("p0001", "雏菜笑了。")],
      [{ id: "t1", ja: "ヒナギク", zh: "雏菜" }],
    );
    const baseRevision = await revisionOf(service, workspaceId);

    const updated = await service.invoke(envelope("terms.update", {
      workspaceId, termId: "t1", archive: "terms", ja: "ヒナギク改", zh: "雏菜", baseRevision,
    }));

    expect(updated.ok).toBe(true);
    expect((updated.ok ? updated.value as TermMutationResult : undefined)?.renameRepair).toBeUndefined();
  });

  it("改名同时更新编辑器底稿——否则打开章节看到旧译名，一保存就把改名冲掉", async () => {
    const { service, root, workspaceId } = await seed(
      [para("p0001", "雏菜笑了。")],
      [{ id: "t1", ja: "ヒナギク", zh: "雏菜" }],
    );
    await mkdir(join(root, "state", "drafts"), { recursive: true });
    await writeFile(join(root, "state", "drafts", "ch001.json"), JSON.stringify({
      revision: 1, savedAt: Date.now(), paragraphs: [{ id: "p0001", source: "原文", translation: "雏菜笑了。" }],
    }), "utf8");
    const baseRevision = await revisionOf(service, workspaceId);

    await service.invoke(envelope("terms.update", {
      workspaceId, termId: "t1", archive: "terms", ja: "ヒナギク", zh: "雏", baseRevision,
    }));

    const draft = JSON.parse(await readFile(join(root, "state", "drafts", "ch001.json"), "utf8")) as { paragraphs: Array<{ translation: string }> };
    expect(draft.paragraphs[0]?.translation).toBe("雏笑了。");
  });
});
