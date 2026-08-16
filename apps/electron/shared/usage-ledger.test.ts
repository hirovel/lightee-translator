/**
 * EX-01 工作区用量账本。
 *
 * 两组断言各守一条线：
 *  - **账本存在且可归因**：逐调用一行、带阶段标签、重试次数可见（法证 C5 的直接补救）；
 *  - **红线**：prompt / 正文 / 密钥进不了账本文件。白名单是结构保证，这里给它一个证明。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIpcService, type EngineWiring } from "./ipc-service.js";
import { accumulate, summarizeUsage, usageLedgerPath, usageLine, usageScope, type UsageRecord } from "./usage-ledger.js";
import {
  importFile,
  promotePendingTerms,
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
  LlmRuntime,
} from "@lightee/engine";

/** 与 ipc-service.test.ts 同一套真实引擎接线：本票要测的是真实翻译链路上的记账 */
const engineWiring: EngineWiring = {
  importFile,
  previewImport: async () => ({ ext: "txt", chapters: [{ title: "第1章 测试", charCount: 12 }] }),
  promotePendingTerms,
  translateChapterToFile,
  runChapterPipeline,
  recoverChapterPromotion,
  recoverChapterPromotionInTransaction,
  reviewChapter,
  confirm: {
    loadSession: loadConfirmSession,
    saveSession: saveConfirmSession,
    verdict: confirmVerdict,
    finishSession: finishConfirmSession,
  },
  exportChapter,
  createLlm: () => {
    const runtime = LlmRuntime.create();
    return {
      complete: (model, messages, opts) => runtime.complete(model, messages as never, opts as never),
      listModels: () => runtime.listModels(),
    };
  },
};

const SENTINEL = "SENTINEL_PROMPT_LEAK_9f3a";

const SAMPLE_TXT = "第1章 测试\n\n这是第一段。\n\n这是第二段。\n\n第2章 继续\n\n第二段内容。\n";

const services: Array<ReturnType<typeof createIpcService>> = [];
const roots: string[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.markClosing();
    await service.flushPendingWrites().catch(() => undefined);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(command: string, payload: unknown) {
  return { version: 1, requestId: `${command}-usage-test`, command, payload };
}

async function workspaceWithChapter(llm: { complete: (model: string, messages: Array<{ role: string; content: string }>, opts?: unknown) => Promise<{ text: string }> }) {
  const service = createIpcService({ engine: engineWiring, llm: llm as never, terminologyWatcher: false });
  services.push(service);
  const root = await mkdtemp(join(tmpdir(), "lightee-usage-"));
  roots.push(root);
  const created = await service.invoke(envelope("workspace.create", { path: root, name: "Usage" }));
  if (!created.ok) throw new Error("workspace.create failed");
  const workspaceId = created.value.id as string;
  await service.invoke(envelope("import.text", { workspaceId, text: SAMPLE_TXT }));
  // 术语门禁：本票只关心记账，不关心确认流程（EX-07 会把这道门禁整个拆掉）
  await writeFile(
    join(root, "state", "terminology-status.json"),
    JSON.stringify({ status: "confirmed", cardCount: 0, pendingCount: 0, confirmedCount: 0, updatedAt: Date.now(), extractionId: "usage-test" }),
    "utf8",
  );
  return { service, root, workspaceId };
}

/** 译文必须回显原文的段落 id，否则章节管线的段落门禁会判失败（BQ-02） */
function xmlFrom(messages: Array<{ role: string; content: string }>, text: string): string {
  const user = messages.find((message) => message.role === "user")?.content ?? "";
  const ids = [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((match) => match[1]!);
  return ids.map((id) => `<paragraph id="${id}">${text}</paragraph>`).join("\n");
}

async function readLedger(root: string): Promise<UsageRecord[]> {
  const raw = await readFile(usageLedgerPath(root), "utf8");
  return raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as UsageRecord);
}

describe("EX-01 用量账本", () => {
  it("翻译一章后逐调用落盘，带阶段标签与章节单位", async () => {
    const { service, root, workspaceId } = await workspaceWithChapter({
      complete: async (_model, messages) => ({
        text: xmlFrom(messages, "这是翻译结果。"),
        usage: { input: 120, output: 45, cacheRead: 30, cacheWrite: 0 },
        ttftMs: 12,
        attempts: 1,
      } as never),
    });

    const translated = await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    expect(translated.ok).toBe(true);

    const rows = await readLedger(root);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.label.startsWith("translate:ch001") || row.label.startsWith("review:ch001") || row.label.startsWith("manager:ch001"))).toBe(true);
    const translateRow = rows.find((row) => row.label === "translate:ch001");
    expect(translateRow).toBeDefined();
    expect(translateRow).toMatchObject({ ok: true, input: 120, output: 45, cacheRead: 30, attempts: 1 });
    expect(typeof translateRow!.ts).toBe("number");
    expect(typeof translateRow!.ms).toBe("number");
  });

  it("重试在账本上可见：一次逻辑调用一行，attempts 记录真实网络次数", async () => {
    const { service, root, workspaceId } = await workspaceWithChapter({
      complete: async (_model, messages) => ({
        text: xmlFrom(messages, "这是翻译结果。"),
        usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 },
        attempts: 3,
      } as never),
    });

    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    const rows = await readLedger(root);
    const translateRow = rows.find((row) => row.label === "translate:ch001");
    expect(translateRow?.attempts).toBe(3);
  });

  it("红线：prompt 与正文进不了账本文件", async () => {
    const { service, root, workspaceId } = await workspaceWithChapter({
      complete: async (_model, messages) => ({
        // 模型响应里带哨兵（正文侧），并在结果对象上挂一个额外字段（白名单侧）
        text: xmlFrom(messages, `这是翻译结果。${SENTINEL}`),
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        prompt: `system ${SENTINEL}`,
        response: SENTINEL,
      } as never),
    });

    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    const raw = await readFile(usageLedgerPath(root), "utf8");
    expect(raw).not.toContain(SENTINEL);
  });
});

describe("EX-01 账本纯函数", () => {
  it("白名单丢弃未列出的字段", () => {
    const line = usageLine({
      ts: 1,
      label: "translate:ch001",
      model: "p/m",
      attempts: 1,
      ok: true,
      ms: 10,
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      prompt: SENTINEL,
      response: SENTINEL,
      apiKey: "sk-abcdefghijkl",
    } as UsageRecord & Record<string, unknown>);
    expect(line).not.toContain(SENTINEL);
    expect(line).not.toContain("sk-");
    expect(JSON.parse(line)).toEqual({ ts: 1, label: "translate:ch001", model: "p/m", attempts: 1, ok: true, ms: 10, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  });

  /**
   * TR-12：服务商上报的推理 token 数与原始停止状态进白名单。
   * 两个都是短数字/短枚举，不含任何正文——但少了它们，报告只能按字符估推理量、
   * 把所有 incomplete 当一种病。
   */
  it("白名单收 reasoning（上报推理 token 数）与 rawStopReason（原始停止状态）", () => {
    const line = usageLine({
      ts: 1, label: "translate:ch001", model: "p/m", attempts: 1, ok: true,
      ms: 10, input: 1, output: 9000, cacheRead: 0, cacheWrite: 0,
      reasoning: 8100, rawStopReason: "incomplete",
    });
    const parsed = JSON.parse(line);
    expect(parsed.reasoning).toBe(8100);
    expect(parsed.rawStopReason).toBe("incomplete");
  });

  it("标签里的换行不会撕裂 JSONL 行边界", () => {
    const line = usageLine({ ts: 1, label: "a\nb", model: "m", attempts: 1, ok: true, ms: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(line.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(line).label).toBe("a b");
  });

  it("摘要把命中缓存单列，并只在真的重试过时提重试", () => {
    const scope = usageScope("/tmp/x", "translate:ch001");
    accumulate(scope.totals, { ts: 1, label: "translate:ch001", model: "m", attempts: 2, ok: true, ms: 1200, input: 1500, output: 800, cacheRead: 2400, cacheWrite: 0 });
    const summary = summarizeUsage(scope.totals);
    expect(summary).toContain("1 次调用");
    expect(summary).toContain("输入 1.5k（命中缓存 2.4k）");
    expect(summary).toContain("输出 800");
    expect(summary).toContain("重试 1 次");

    const clean = usageScope("/tmp/x", "translate:ch002");
    accumulate(clean.totals, { ts: 1, label: "translate:ch002", model: "m", attempts: 1, ok: true, ms: 500, input: 10, output: 20, cacheRead: 0, cacheWrite: 0 });
    expect(summarizeUsage(clean.totals)).not.toContain("重试");
    expect(summarizeUsage(clean.totals)).not.toContain("命中缓存");
  });
});
