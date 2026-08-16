/**
 * RH-15 锁粒度收缩验收（design/lock-granularity.md §5）。
 *
 * 单独成文件而不是塞进 ipc-service.test.ts：这两条判据都要在「一次翻译正在跑」
 * 的窗口期内并发发起其他命令，与该文件里其余顺序化用例的节奏不同。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

const SAMPLE_TXT = "第1章 锁粒度\n\nテスト本文を確認する。\n\n処理が完了した。\n\n第2章 另一章\n\n二番目の章の本文。\n\n確認は完了した。\n";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(command: string, payload: unknown) {
  return { version: 1, requestId: `${command}-rh15`, command, payload };
}

function xmlFrom(messages: Array<{ role: string; content: string }>, text: string): string {
  const user = messages.find((message) => message.role === "user")?.content ?? "";
  const ids = [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((match) => match[1]!);
  return ids.map((id) => `<paragraph id="${id}">${text}</paragraph>`).join("\n");
}

const wiring: EngineWiring = {
  importFile,
  previewImport: async () => ({ ext: "txt", chapters: [{ title: "第1章 锁粒度", charCount: 12 }] }),
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

/** 人为延迟的 fake LLM：模拟真实模型的分钟级调用（这里压到 2s） */
function slowLlm(delayMs: number, onCall?: () => void) {
  return {
    complete: async (_model: string, messages: Array<{ role: string; content: string }>) => {
      onCall?.();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { text: xmlFrom(messages, "这是稳定的中文译文。") };
    },
  };
}

async function seedWorkspace(service: ReturnType<typeof createIpcService>) {
  const root = await mkdtemp(join(tmpdir(), "lightee-rh15-"));
  roots.push(root);
  const created = await service.invoke(envelope("workspace.create", { path: root, name: "锁粒度" }));
  if (!created.ok) throw new Error("workspace.create failed");
  const workspaceId = (created.value as { id: string }).id;
  const sourceTxt = join(root, "input.txt");
  await writeFile(sourceTxt, SAMPLE_TXT, "utf8");
  const imported = await service.invoke(envelope("import.run", { workspaceId, sourcePath: sourceTxt }));
  if (!imported.ok) throw new Error("import.run failed");
  await writeFile(join(root, "state", "terminology-status.json"), JSON.stringify({
    status: "confirmed", cardCount: 0, pendingCount: 0, confirmedCount: 0, updatedAt: Date.now(), extractionId: "rh15",
  }), "utf8");
  return { root, workspaceId };
}

describe("RH-15 锁粒度", () => {
  it("翻译 ch001 期间，其他章节的 chapter.load / saveDraft 不被阻塞", async () => {
    let firstCallSeen: (() => void) | null = null;
    const firstCall = new Promise<void>((resolve) => { firstCallSeen = resolve; });
    const service = createIpcService({ engine: wiring, llm: slowLlm(2_000, () => firstCallSeen?.()) as never });
    const { workspaceId } = await seedWorkspace(service);

    const running = service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    // 等到 LLM 真的开始跑，确保测量点落在「无锁窗口期」内而不是发起前
    await firstCall;

    const started = Date.now();
    const loaded = await service.invoke(envelope("chapter.load", { workspaceId, chapterId: "ch002" }));
    const loadMs = Date.now() - started;
    expect(loaded).toMatchObject({ ok: true });
    if (!loaded.ok) return;
    expect(loadMs).toBeLessThan(500);

    const draftStarted = Date.now();
    const drafted = await service.invoke(envelope("chapter.saveDraft", {
      workspaceId,
      chapterId: "ch002",
      baseRevision: (loaded.value as { revision: number }).revision,
      paragraphs: (loaded.value as { paragraphs: Array<{ translation: string }> }).paragraphs.map((paragraph) => ({ ...paragraph, translation: "翻译期间的草稿" })),
    }));
    expect(drafted).toMatchObject({ ok: true });
    expect(Date.now() - draftStarted).toBeLessThan(500);

    // ch001 本身照常跑完
    expect(await running).toMatchObject({ ok: true, value: { workflowStatus: "approved" } });
  }, 60_000);

  it("LLM 窗口期内源文修正被改动 → 本次翻译显式中止、状态回 ready、无半成品 promote", async () => {
    let firstCallSeen: (() => void) | null = null;
    const firstCall = new Promise<void>((resolve) => { firstCallSeen = resolve; });
    const service = createIpcService({ engine: wiring, llm: slowLlm(1_500, () => firstCallSeen?.()) as never });
    const { root, workspaceId } = await seedWorkspace(service);

    const running = service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    await firstCall;
    // 直接改源文修正文件：模拟作者在无锁窗口期编辑原文
    await writeFile(join(root, "state", "source-corrections", "ch001.json"), JSON.stringify({
      chapterId: "ch001", revision: 1, updatedAt: Date.now(), paragraphs: [{ id: "p001", source: "改过的原文" }],
    }), "utf8").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(root, "state", "source-corrections"), { recursive: true });
      await writeFile(join(root, "state", "source-corrections", "ch001.json"), JSON.stringify({ chapterId: "ch001", revision: 1 }), "utf8");
    });

    const result = await running;
    expect(result.ok).toBe(false);

    const loaded = await service.invoke(envelope("chapter.load", { workspaceId, chapterId: "ch001" }));
    expect(loaded).toMatchObject({ ok: true });
    if (!loaded.ok) return;
    expect((loaded.value as { workflow: { state: string } }).workflow.state).toBe("ready");
    // 没有任何半成品被 promote 成正式译文
    expect(existsSync(join(root, "translations", "ch001_zh.md"))).toBe(false);
    // 也没留下未收尾的 promotion marker
    const markerDir = join(root, "state", "promotions");
    if (existsSync(markerDir)) {
      const { readdir } = await import("node:fs/promises");
      expect((await readdir(markerDir)).filter((name) => name.includes("ch001"))).toEqual([]);
    }
    void readFile;
  }, 60_000);
});
