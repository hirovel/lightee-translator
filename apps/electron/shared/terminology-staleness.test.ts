/**
 * 导入新原文后术语状态必须失效（2026-08-10 用户实测报告）。
 *
 * 症状：导入新章节后，术语状态仍显示「已完成扫描」。
 *
 * 但这不只是显示问题——`terminology-status.json` 是**工作区级**的单一标志，而
 * `translateRun` 的前置门禁正是 `status !== "confirmed"` 就拒绝。于是扫描确认过一次之后，
 * 之后导入的任何章节都能绕过术语门禁直接翻译，而它们的候选术语从未被抽取过。
 * 术语门禁存在的全部意义就是「本章候选术语必须先确认」，这条路径把它整个跳过了。
 *
 * 重扫的代价很低：`prepareTerminology` 会跳过 `terminology/*.json` 里已确认的词，
 * 只把新章节里的新词拿出来问。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  loadSession as loadConfirmSession,
  saveSession as saveConfirmSession,
  verdict as confirmVerdict,
  finishSession as finishConfirmSession,
  exportChapter,
} from "@lightee/engine";

const FIRST_TXT = "第1章 初始\n\nテスト本文を確認する。\n";
const SECOND_TXT = "第2章 新增\n\n新しい章の本文である。\n";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(command: string, payload: unknown) {
  return { version: 1, requestId: `${command}-term-stale`, command, payload };
}

const wiring: EngineWiring = {
  importFile,
  previewImport: async () => ({ ext: "txt", chapters: [{ title: "第2章 新增", charCount: 12 }] }),
  translateChapterToFile,
  runChapterPipeline,
  recoverChapterPromotion,
  recoverChapterPromotionInTransaction,
  reviewChapter,
  confirm: { loadSession: loadConfirmSession, saveSession: saveConfirmSession, verdict: confirmVerdict, finishSession: finishConfirmSession },
  exportChapter,
  runBookReview: async () => ({ runId: "run-1", report: { reportId: "b1", summary: { high: 0, medium: 0, low: 0 }, issues: [], scope: [] }, reportPath: "reviews/book/run-1/report.json" }),
  createLlm: () => ({ complete: async () => ({ text: "" }), listModels: () => [] }),
};

async function seedConfirmedWorkspace() {
  const service = createIpcService({ engine: wiring });
  const root = await mkdtemp(join(tmpdir(), "lightee-term-stale-"));
  roots.push(root);
  const created = await service.invoke(envelope("workspace.create", { path: root, name: "术语失效" }));
  if (!created.ok) throw new Error("workspace.create failed");
  const workspaceId = (created.value as { id: string }).id;
  const first = join(root, "first.txt");
  await writeFile(first, FIRST_TXT, "utf8");
  const imported = await service.invoke(envelope("import.run", { workspaceId, sourcePath: first }));
  if (!imported.ok) throw new Error("import.run failed");
  // 模拟「已扫描并全部确认」的既有工作区
  await writeFile(join(root, "state", "terminology-status.json"), JSON.stringify({
    status: "confirmed", cardCount: 3, pendingCount: 0, confirmedCount: 3, updatedAt: Date.now(), extractionId: "seed",
  }), "utf8");
  return { service, root, workspaceId };
}

async function statusOf(root: string): Promise<string> {
  const raw = await readFile(join(root, "state", "terminology-status.json"), "utf8").catch(() => "{}");
  return (JSON.parse(raw) as { status?: string }).status ?? "not-extracted";
}

describe("导入新原文 → 术语状态失效", () => {
  it("import.run 之后不再是 confirmed（新章节的术语从未被抽取过）", async () => {
    const { service, root, workspaceId } = await seedConfirmedWorkspace();
    expect(await statusOf(root)).toBe("confirmed");

    const second = join(root, "second.txt");
    await writeFile(second, SECOND_TXT, "utf8");
    const imported = await service.invoke(envelope("import.run", { workspaceId, sourcePath: second }));
    expect(imported.ok).toBe(true);

    expect(await statusOf(root)).not.toBe("confirmed");
  });

  it("import.text（粘贴导入）同样使术语状态失效", async () => {
    const { service, root, workspaceId } = await seedConfirmedWorkspace();
    const imported = await service.invoke(envelope("import.text", { workspaceId, text: SECOND_TXT }));
    expect(imported.ok).toBe(true);
    expect(await statusOf(root)).not.toBe("confirmed");
  });

  /**
   * EX-07 / ADR-0007：原断言是「失效后翻译门禁真的拦得住」。
   *
   * 那道门禁本身已经退役——它要求「先跑完译前提取、逐项确认，才准翻译」，而译前提取
   * 阶段不复存在（术语随翻译逐章长出来）。状态失效仍然有意义（术语面板不该谎称
   * 「已完成扫描」），但它**不再否决翻译**：让一个展示状态挡住核心能力，正是这一整批
   * 要根除的失效模式。改为正向断言。
   */
  it("状态非 confirmed 也不再挡翻译（EX-07：导入即可翻）", async () => {
    const { service, root, workspaceId } = await seedConfirmedWorkspace();
    const second = join(root, "second.txt");
    await writeFile(second, SECOND_TXT, "utf8");
    await service.invoke(envelope("import.run", { workspaceId, sourcePath: second }));
    expect(await statusOf(root)).not.toBe("confirmed");

    const translated = await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch002" }));
    // 不是 conflict：真实 LLM 不可用时会以别的理由失败，但绝不能是「请先运行术语提取」
    expect(translated.ok === false && translated.error.code).not.toBe("conflict");
  });

  it("不动已确认的术语档案——失效的是「是否扫描过」，不是用户确认的成果", async () => {
    const { service, root, workspaceId } = await seedConfirmedWorkspace();
    const termsPath = join(root, "terminology", "terms.json");
    await writeFile(termsPath, JSON.stringify([{ id: "terms:keep", ja: "確認", zh: "确认" }]), "utf8");
    const second = join(root, "second.txt");
    await writeFile(second, SECOND_TXT, "utf8");
    await service.invoke(envelope("import.run", { workspaceId, sourcePath: second }));
    expect(JSON.parse(await readFile(termsPath, "utf8"))).toEqual([{ id: "terms:keep", ja: "確認", zh: "确认" }]);
  });
});
