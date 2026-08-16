import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIpcService, type EngineWiring } from "./ipc-service.js";
import type { TermRecord } from "./ipc-contract.js";
import { SEEDED_POST_DICT_RULES } from "@lightee/engine";
import { pendingFileMutationQueues, withFileMutationQueue } from "./atomic-file.js";
import { AUTH_SEALED_TAG, migrateLighteeAuthEncryption, setSecretCodec, type SecretCodec } from "./lightee-config.js";
import {
  createSession,
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
  ChapterStateStore,
  LlmRuntime,
  TerminologyRepository,
} from "@lightee/engine";

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
  runBookReview: async () => ({
    runId: "run-1",
    report: { reportId: "bookrev_1", summary: { high: 0, medium: 0, low: 0 }, issues: [], scope: [] },
    reportPath: "reviews/book/run-1/report.json",
  }),
  createLlm: () => {
    const runtime = LlmRuntime.create();
    return {
      complete: (model, messages, opts) => runtime.complete(model, messages as never, opts as never),
      listModels: () => runtime.listModels(),
    };
  },
};

/**
 * 每个测试建的 service 都登记下来，afterEach 先排空再删目录。
 * 术语 watcher 的轮询会写 terminology-status.json：只 clearInterval 不等在飞的那一次，
 * 删目录就会被重建出的文件顶回来（ENOTEMPTY）——这不是测试洁癖，是关窗排空本身的要求。
 */
const services: Array<ReturnType<typeof createIpcService>> = [];

function serviceWith(options: { engine?: EngineWiring; llm?: { complete: (model: string, messages: Array<{ role: string; content: string }>, opts?: { thinking?: string; signal?: AbortSignal }) => Promise<{ text: string }> }; terminologyWatcher?: boolean } = {}) {
  const service = createIpcService({ engine: options.engine ?? engineWiring, llm: options.llm ?? null, terminologyWatcher: options.terminologyWatcher });
  services.push(service);
  return service;
}

const roots: string[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.markClosing();
    await service.flushPendingWrites().catch(() => undefined);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(command: string, payload: unknown) {
  return { version: 1, requestId: `${command}-test`, command, payload };
}

describe("IpcService", () => {
  it("does not overwrite a newer chapter revision with a stale draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-"));
    roots.push(root);
    await writeFile(join(root, "source.md"), "source", "utf8");
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "Test" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const workspaceId = created.value.id;
    const chapter = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "First" }));
    expect(chapter).toMatchObject({ ok: true, value: { chapterId: "ch001" } });
    if (!chapter.ok) return;
    const first = await service.invoke(envelope("chapter.saveDraft", {
      workspaceId,
      chapterId: chapter.value.chapterId,
      baseRevision: 0,
      paragraphs: [{ id: "p0001", source: "source", translation: "first" }],
    }));
    expect(first).toMatchObject({ ok: true, value: { revision: 1 } });

    const stale = await service.invoke(envelope("chapter.saveDraft", {
      workspaceId,
      chapterId: chapter.value.chapterId,
      baseRevision: 0,
      paragraphs: [{ id: "p0001", source: "source", translation: "stale" }],
    }));
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });

    const loaded = await service.invoke(envelope("chapter.load", { workspaceId, chapterId: chapter.value.chapterId }));
    expect(loaded).toMatchObject({ ok: true, value: { revision: 1, hasApprovedTranslation: false, paragraphs: [{ translation: "first" }] } });
    expect(await readFile(join(root, "translations", "ch001_zh.md"), "utf8")).toContain("first");

    const orphan = await service.invoke(envelope("chapter.saveDraft", {
      workspaceId,
      chapterId: "ch999",
      baseRevision: 0,
      paragraphs: [{ id: "p0001", source: "source", translation: "orphan" }],
    }));
    expect(orphan.ok).toBe(false);
    await expect(readFile(join(root, "state", "drafts", "ch999.json"), "utf8")).rejects.toThrow();
  });

  it("drains tracked writes and exposes a deterministic result", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-"));
    roots.push(root);
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "Test" }));
    expect(created.ok).toBe(true);
    const flushed = await service.flushPendingWrites();
    expect(flushed).toMatchObject({ ok: true, value: { status: "already-drained", pendingAtStart: 0 } });
  });

  it("reports the effective default model when a workspace has no explicit ai.model", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-"));
    roots.push(root);
    // 必须隔离配置目录：`ai.providers.list` 会走 ensureLighteeModels，那一步在
    // models.json 不存在时**会把预置写下去**。不隔离的话，跑一次单元测试就在开发者的
    // 真实配置目录里凭空造出一份 models.json（此前正是如此，只是没人看见）。
    const configDir = await mkdtemp(join(tmpdir(), "lightee-config-"));
    roots.push(configDir);
    const previous = process.env.LIGHTEE_CONFIG_DIR;
    process.env.LIGHTEE_CONFIG_DIR = configDir;
    try {
      const service = createIpcService();
      const created = await service.invoke(envelope("workspace.create", { path: root, name: "Default model" }));
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const providers = await service.invoke(envelope("ai.providers.list", { workspaceId: created.value.id }));
      expect(providers).toMatchObject({
        ok: true,
        value: {
          current: "deepseek/deepseek-v4-pro",
          currentProvider: "deepseek",
          // 缺省档位从 max 降到 high（作者裁定：DS-pro 的 high 足以翻译）。
          // 此前 deepseek 单独走 max，其余走 high——那条分支已随之取消。
          currentThinking: "high",
          // 缺省 high（作者裁定 2026-08-13）：默认面向质量；「低思考防 JSON 漂移」无实测依据。
          // 只剩两档：术语档随 ADR-0007 的融合式提取一起取消（登记并进翻译请求，没有独立调用
          // 可以设不同档位），审校档的消费者只有全书审校，界面入口当前是关的。
          reviewThinking: "high",
        },
      });
    } finally {
      if (previous === undefined) delete process.env.LIGHTEE_CONFIG_DIR;
      else process.env.LIGHTEE_CONFIG_DIR = previous;
    }
  });

  it("delegates directory picking to the injected picker", async () => {
    const service = createIpcService({ pickDirectory: async () => "C:/books/picked" });
    const picked = await service.invoke(envelope("dialog.pickDirectory", { title: "选择" }));
    expect(picked).toEqual({ ok: true, value: { path: "C:/books/picked" } });
  });

  it("delegates file picking to the injected picker", async () => {
    const service = createIpcService({ pickFile: async () => "C:/books/source.txt" });
    const picked = await service.invoke(envelope("dialog.pickFile", { title: "选择小说" }));
    expect(picked).toEqual({ ok: true, value: { path: "C:/books/source.txt" } });
  });

  it("uses the engine preview pipeline without writing an import", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-preview-"));
    roots.push(root);
    const sourcePath = join(root, "input.txt");
    await writeFile(sourcePath, "第1章 测试\n\n正文", "utf8");
    const service = serviceWith();
    const preview = await service.invoke(envelope("import.preview", { sourcePath }));
    expect(preview).toEqual({
      ok: true,
      value: {
        sourcePath,
        format: "txt",
        chapters: [{ title: "第1章 测试", charCount: 12 }],
      },
    });
    expect(await readFile(sourcePath, "utf8")).toContain("正文");
  });

  it("EV-01：EPUB 分卷预览的卷摘要与每章卷标原样透传给渲染层", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-preview-vol-"));
    roots.push(root);
    const sourcePath = join(root, "omnibus.epub");
    await writeFile(sourcePath, "stub", "utf8");
    const service = serviceWith({
      engine: {
        ...engineWiring,
        previewImport: async () => ({
          ext: "epub",
          chapters: [
            { title: "第1話", charCount: 100, volume: "第一巻 出会いの章" },
            { title: "第2話", charCount: 120, volume: "第二巻 約束の章" },
          ],
          volumes: [
            { title: "第一巻 出会いの章", chapters: 1 },
            { title: "第二巻 約束の章", chapters: 1 },
          ],
        }),
      },
    });
    const preview = await service.invoke(envelope("import.preview", { sourcePath }));
    expect(preview).toEqual({
      ok: true,
      value: {
        sourcePath,
        format: "epub",
        chapters: [
          { title: "第1話", charCount: 100, volume: "第一巻 出会いの章" },
          { title: "第2話", charCount: 120, volume: "第二巻 約束の章" },
        ],
        volumes: [
          { title: "第一巻 出会いの章", chapters: 1 },
          { title: "第二巻 約束の章", chapters: 1 },
        ],
      },
    });
  });

  it("returns null when the picker is canceled or absent", async () => {
    const canceled = createIpcService({ pickDirectory: async () => null, pickFile: async () => null });
    expect(await canceled.invoke(envelope("dialog.pickDirectory", {}))).toEqual({ ok: true, value: { path: null } });
    expect(await canceled.invoke(envelope("dialog.pickFile", {}))).toEqual({ ok: true, value: { path: null } });
    const absent = createIpcService();
    expect(await absent.invoke(envelope("dialog.pickDirectory", {}))).toEqual({ ok: true, value: { path: null } });
    expect(await absent.invoke(envelope("dialog.pickFile", {}))).toEqual({ ok: true, value: { path: null } });
  });

  // ===== 真实 engine 接线（import / translate / review / confirm / export）=====

  async function createImportedWorkspace(service: ReturnType<typeof createIpcService>, text: string) {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-"));
    roots.push(root);
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "测试书" }));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("workspace.create failed");
    const workspaceId = created.value.id;
    const sourceTxt = join(root, "input.txt");
    await writeFile(sourceTxt, text, "utf8");
    const imported = await service.invoke(envelope("import.run", { workspaceId, sourcePath: sourceTxt }));
    expect(imported).toMatchObject({ ok: true, value: { status: "queued", chapters: 2 } });
    if (!imported.ok) throw new Error("import.run failed");
    const manifest = JSON.parse(await readFile(join(root, "source", "manifest.json"), "utf8"));
    expect(manifest.chapters).toHaveLength(2);
    return { root, workspaceId };
  }

  async function markTerminologyConfirmed(root: string, cardCount = 0) {
    await writeFile(join(root, "state", "terminology-status.json"), JSON.stringify({
      status: "confirmed",
      cardCount,
      pendingCount: 0,
      confirmedCount: cardCount,
      updatedAt: Date.now(),
      extractionId: "test-confirmed",
    }), "utf8");
  }

  const SAMPLE_TXT = "第1章 测试\n\n这是第一段。\n\n这是第二段。\n\n第2章 继续\n\n第二段内容。\n";

  /** BQ-02 门禁：把纯文本译文按 user 中源段落 id 包装为 XML */
  function xmlFrom(messages: Array<{ role: string; content: string }>, text: string): string {
    const user = messages.find((message) => message.role === "user")?.content ?? "";
    const ids = [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((match) => match[1]!);
    return ids.map((id) => `<paragraph id="${id}">${text}</paragraph>`).join("\n");
  }

  const TERMINOLOGY_LLM = {
    complete: async (_model: string, messages: Array<{ role: string; content: string }>) => {
      const system = messages.find((message) => message.role === "system")?.content ?? "";
      const user = messages.find((message) => message.role === "user")?.content ?? "";
      if (system.includes("阅读轮")) return { text: JSON.stringify({ overview: "测试书籍", chapterDigests: {} }) };
      if (system.includes("术语复核官")) {
        const start = user.indexOf("[");
        const end = user.lastIndexOf("]");
        return { text: start >= 0 && end > start ? user.slice(start, end + 1) : "[]" };
      }
      if (system.includes("人物与说话者归属")) return { text: JSON.stringify({ entities: [], attributions: [], unresolved: [] }) };
      if (system.includes("角色语气画像分析器")) return { text: JSON.stringify({ profiles: [] }) };
      if (system.includes("角色语气分析器")) return { text: JSON.stringify({ profiles: [] }) };
      if (system.includes("角色语气档案") || system.includes("拟声拟态词") || system.includes("梗侦探")) return { text: "[]" };
      if (system.includes("术语学家")) {
        const candidates = [...user.matchAll(/\n\s*\d+\.\s+([^\s（(]+)/g)].map((match) => match[1]).filter(Boolean);
        return { text: JSON.stringify(candidates.map((ja) => ({ ja, zh: ja === "アリス" ? "爱丽丝" : ja === "ボブ" ? "鲍勃" : `译${ja}`, type: "term", keep: true, confidence: 0.95 }))) };
      }
      // KA-5：译者在同一次调用里登记新术语，走 register_terms 工具参数（两轮）。
      // ja 必须逐字见于本章原文，否则会被补救层当幻觉丢弃。
      // 假体按真运行时的时序发：轮1 只发工具调用，收到 toolResult 之后才给正文。
      if (!messages.some((message) => message.role === "toolResult")) {
        return {
          text: "",
          stopReason: "toolUse",
          continuation: { role: "assistant", content: [] },
          toolCalls: [{ id: "call_1", name: "register_terms", arguments: {
            terms: [
              { ja: "アリス", zh: "爱丽丝", type: "person", note: null },
              // pun 仍走卡片闸门（ADR-0008 边界）——确认队列由它们填充。
              // 两张卡是并发裁决保护的最低配置：单卡时首个 accept 即完成会话，
              // 第二个并发请求只会 not_found，测不到 conflict。
              { ja: "ボブ", zh: "鲍勃", type: "pun", note: null },
              { ja: "都在", zh: "都在梗", type: "pun", note: null },
            ],
            voices: [],
          } }],
        };
      }
      if (system.includes("术语表")) return { text: xmlFrom(messages, "爱丽丝 鲍勃 爱丽丝 鲍勃 这是翻译结果。") };
      return { text: xmlFrom(messages, "这是翻译结果。") };
    },
  };

  it("keeps import free of implicit terminology and LLM work", async () => {
    let prepareCalls = 0;
    let llmCalls = 0;
    const importOnlyEngine: EngineWiring = {
      ...engineWiring,
    };
    const service = createIpcService({
      engine: importOnlyEngine,
      llm: { complete: async () => { llmCalls += 1; throw new Error("LLM must not run during import"); } },
    });
    const structureEvents: Array<{ payload: { action: string; workspaceId: string; reason?: string } }> = [];
    service.subscribe((event) => {
      if (event.type === "workspace.changed" && event.payload.action === "structure") structureEvents.push(event as typeof structureEvents[number]);
    });
    const root = await mkdtemp(join(tmpdir(), "lightee-import-boundary-"));
    roots.push(root);
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "导入边界测试" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sourcePath = join(root, "input.txt");
    await writeFile(sourcePath, "第1章 导入\n\nこれは本文です。\n", "utf8");

    const imported = await service.invoke(envelope("import.run", { workspaceId: created.value.id, sourcePath }));

    expect(imported).toMatchObject({ ok: true, value: { chapters: 1 } });
    expect(prepareCalls).toBe(0);
    expect(llmCalls).toBe(0);
    expect(structureEvents).toContainEqual(expect.objectContaining({ payload: { action: "structure", workspaceId: created.value.id, reason: "imported" } }));
    const terminology = await service.invoke(envelope("confirm.list", { workspaceId: created.value.id }));
    expect(terminology).toMatchObject({ ok: true, value: { status: { status: "not-extracted" } } });
  });

  /**
   * EX-07 / ADR-0007 验收路径：**导入即可翻**。
   *
   * 原用例叫「runs Terminologist preparation, gates translation, …」——先跑一趟全书提取、
   * 逐项确认完才准翻译。译前提取阶段退役后，确认卡改由译者在翻译途中发现的新词填充
   * （EX-04 融合尾块 → pending-terms → promotePendingTerms），confirm.* 会话机制不变，
   * 变的是**入口**。这里逐条改写为新流程，并保留原用例真正在保护的东西：
   * 并发裁决只能有一个赢家、back 能退回、重启后确认成果还在。
   */
  it("导入后直接翻译，新术语随译文到达确认队列，重启后成果仍在", async () => {
    const service = serviceWith({ llm: TERMINOLOGY_LLM });
    const root = await mkdtemp(join(tmpdir(), "lightee-terminology-"));
    roots.push(root);
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "融合提取测试" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sourcePath = join(root, "input.txt");
    await writeFile(sourcePath, "第1章 术语\n\nアリス和ボブ都在这里。\n\nアリス看向ボブ。\n", "utf8");
    const imported = await service.invoke(envelope("import.run", { workspaceId: created.value.id, sourcePath }));
    expect(imported).toMatchObject({ ok: true, value: { chapters: 1 } });

    // 没跑过任何提取、没确认过任何词，直接开翻——这是本票的全部要点
    const translated = await service.invoke(envelope("translate.run", { workspaceId: created.value.id, chapterId: "ch001" }));
    expect(translated).toMatchObject({ ok: true, value: { chapterId: "ch001", workflowStatus: "approved" } });
    expect(await readFile(join(root, "translations", "ch001_zh.md"), "utf8")).toContain("这是翻译结果");

    // ADR-0008（TP-2）分流：带译法的人名**登记即注入**——不进确认队列，直接以
    // provenance=model 落进档案；确认队列只收双关（策略归作者裁量）。
    const injected = await service.invoke(envelope("terms.query", { workspaceId: created.value.id }));
    expect(injected.ok && (injected.value as { items: Array<{ ja: string; zh: string; provenance?: string }> }).items
      .some((item) => item.ja === "アリス" && item.zh === "爱丽丝" && item.provenance === "model")).toBe(true);
    const listed = await service.invoke(envelope("confirm.list", { workspaceId: created.value.id }));
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const cards = (listed.value as { cards: Array<{ ja: string }> }).cards;
    expect(cards.map((card) => card.ja)).toEqual(["ボブ", "都在"]);

    // 并发裁决只能有一个赢家（原用例的核心保护，逐字保留）
    const firstDecision = service.invoke(envelope("confirm.decide", { workspaceId: created.value.id, action: "accept", chosenZh: "鲍勃", expectedIndex: 0 }));
    const duplicateDecision = service.invoke(envelope("confirm.decide", { workspaceId: created.value.id, action: "accept", chosenZh: "鲍勃", expectedIndex: 0 }));
    const decisions = await Promise.all([firstDecision, duplicateDecision]);
    expect(decisions.filter((result) => result.ok)).toHaveLength(1);
    expect(decisions.find((result) => !result.ok)).toMatchObject({ error: { code: "conflict" } });

    // back 退得回去
    const backed = await service.invoke(envelope("confirm.decide", { workspaceId: created.value.id, action: "back", expectedIndex: 1 }));
    expect(backed).toMatchObject({ ok: true, value: { index: 0 } });
    const retried = await service.invoke(envelope("confirm.decide", { workspaceId: created.value.id, action: "accept", chosenZh: "鲍勃", expectedIndex: 0 }));
    expect(retried).toMatchObject({ ok: true, value: { index: 1 } });
    // 裁决在会话结束时统一落盘（applied）——中途 accept 只是记 verdict
    for (let index = 1; index < cards.length; index += 1) {
      const done = await service.invoke(envelope("confirm.decide", { workspaceId: created.value.id, action: "accept", chosenZh: "都在梗", expectedIndex: index }));
      expect(done.ok).toBe(true);
    }

    // 重启后确认成果还在，且第二章照样能直接翻
    const reopened = createIpcService({ engine: engineWiring, llm: TERMINOLOGY_LLM });
    const opened = await reopened.invoke(envelope("workspace.open", { path: root }));
    expect(opened).toMatchObject({ ok: true, value: { id: created.value.id } });
    const terms = await reopened.invoke(envelope("terms.query", { workspaceId: created.value.id }));
    expect(terms.ok && (terms.value as { items: Array<{ zh: string }> }).items.some((item) => item.zh === "爱丽丝")).toBe(true);
  });



  it("imports pasted text through the real engine pipeline", async () => {
    const service = serviceWith();
    const root = await mkdtemp(join(tmpdir(), "lightee-paste-"));
    roots.push(root);
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "粘贴测试" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const imported = await service.invoke(envelope("import.text", { workspaceId: created.value.id, text: SAMPLE_TXT }));
    expect(imported).toMatchObject({ ok: true, value: { status: "queued", chapters: 2 } });
    expect(await readFile(join(root, "source", "v01", "ch001.md"), "utf8")).toContain("这是第一段");
  });

  it("imports a txt book through the real engine pipeline", async () => {
    const service = serviceWith();
    const { root } = await createImportedWorkspace(service, SAMPLE_TXT);
    expect(await readFile(join(root, "source", "v01", "ch001.md"), "utf8")).toContain("这是第一段");
  });

  /**
   * 账本必须记下**这次发出去的输出预算**。
   *
   * 2026-08-12 的两次真实跑批，8 次失败的 output 分别是 16382/16383/16384/16386——
   * 精确停在配置的 maxTokens=16384 上。可账本里没有这一栏，报告只能写「原因未知」，
   * 答案就在旁边却报不出来。字段加了、序列化写了、引擎也回传了，唯独 `usageLlm`
   * 这一段没接上，于是整条链静默失效。这条测试钉的就是那一段。
   */
  it("records the output budget it actually sent, per attempt", async () => {
    const BUDGET = 16384;
    const fakeLlm = {
      // 回传 maxTokens 与 LlmRuntime 的真实行为一致——桥这一层要把它带进账本
      complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({
        text: xmlFrom(messages, "这是翻译结果。"),
        maxTokens: BUDGET,
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      }),
    };
    const service = serviceWith({ llm: fakeLlm as never });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));

    const raw = await readFile(join(root, "sessions", "usage.jsonl"), "utf8");
    const rows = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { label: string; maxTokens?: number });
    const translate = rows.filter((row) => row.label.startsWith("translate:"));
    expect(translate.length).toBeGreaterThan(0);
    expect(translate.every((row) => row.maxTokens === BUDGET)).toBe(true);
  });

  /**
   * KA-4 验收当天的报告说「尝试 6 次，废因 tool_call_only ×3 · unknown ×3」，
   * 而 llm-history 里只有 3 次调用——终态行在每次逐尝试记录之外又补了一行，
   * 用量全 0、errorKind 落到 unknown。账本存在的意义就是回答「几次尝试」
   * 与「为什么废的」，这两问它当时都答错了。
   */
  it("wasted 非空时不补终态幻影行——账本的尝试数必须等于真实网络尝试数", async () => {
    const fakeLlm = {
      complete: async () => {
        const error = Object.assign(new Error("模型只发了工具调用"), {
          kind: "other",
          attempts: 1,
          wasted: [{
            thinking: "max", ms: 1234, errorKind: "tool_call_only",
            usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
          }],
        });
        throw error;
      },
    };
    const service = serviceWith({ llm: fakeLlm as never });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));

    const raw = await readFile(join(root, "sessions", "usage.jsonl"), "utf8");
    const rows = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { label: string; errorKind?: string; output: number });
    const translate = rows.filter((row) => row.label.startsWith("translate:"));
    expect(translate).toHaveLength(1);
    expect(translate[0]?.errorKind).toBe("tool_call_only");
    expect(translate[0]?.output).toBe(200);
  });

  /** 反面：一次网络尝试都没发生过的失败（鉴权/配置），终态行是唯一的记录，不能一并砍掉 */
  it("wasted 为空时仍落终态行——否则这类失败在账本上完全不存在", async () => {
    const fakeLlm = { complete: async () => { throw new Error("没有可用密钥"); } };
    const service = serviceWith({ llm: fakeLlm as never });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));

    const raw = await readFile(join(root, "sessions", "usage.jsonl"), "utf8");
    const rows = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { label: string; ok: boolean });
    expect(rows.filter((row) => row.label.startsWith("translate:") && !row.ok).length).toBeGreaterThan(0);
  });

  it("translates a chapter through the shared pipeline and persists its transition chain", async () => {
    const fakeLlm = { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, '这是翻译结果。') }) };
    const service = serviceWith({ llm: fakeLlm });
    const stateEvents: Array<{ payload: { from: string; to: string; runId: string; state: { state: string; runId: string | null } } }> = [];
    const agentEvents: Array<{ payload: { workspaceId?: string; chapterId?: string; operation?: string } }> = [];
    service.subscribe((event) => {
      if (event.type === "chapter.stateChanged") stateEvents.push(event as typeof stateEvents[number]);
      if (event.type === "agent.status" && (event.payload.operation === "translate" || event.payload.operation === "review")) agentEvents.push(event as typeof agentEvents[number]);
    });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    const translated = await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    expect(translated).toMatchObject({ ok: true, value: { chapterId: "ch001", workflowStatus: "approved", workflow: { state: "approved", attempt: 1 } } });
    expect(await readFile(join(root, "translations", "ch001_zh.md"), "utf8")).toContain("这是翻译结果");
    const snapshot = JSON.parse(await readFile(join(root, "state", "chapter_state.json"), "utf8"));
    expect(snapshot.chapters.ch001).toMatchObject({ state: "approved", version: 1, attempt: 1, retryCount: 0, reviseCount: 0 });
    const events = (await readFile(join(root, "state", "events.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(agentEvents.length).toBeGreaterThan(0);
    expect(agentEvents.every((event) => event.payload.workspaceId === workspaceId && event.payload.chapterId === "ch001")).toBe(true);
    expect(events.map((event: { from: string; to: string }) => `${event.from}->${event.to}`)).toEqual([
      "imported->ready",
      "ready->translating",
      "translating->translated",
      "translated->reviewing",
      "reviewing->approved",
    ]);
    expect(events.every((event: { runId: string; status: { state: string } }) => event.runId && event.status.state)).toBe(true);
    expect(stateEvents.map((event) => `${event.payload.from}->${event.payload.to}`)).toEqual(events.map((event: { from: string; to: string }) => `${event.from}->${event.to}`));
    expect(stateEvents.every((event) => event.payload.to === event.payload.state.state && event.payload.runId === event.payload.state.runId)).toBe(true);
  });

  it("serializes duplicate translate requests for one chapter", async () => {
    let active = 0;
    let maxActive = 0;
    let translateCalls = 0;
    const fakeLlm = {
      complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => {
        translateCalls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolveWait) => setTimeout(resolveWait, 35));
        active -= 1;
        return { text: xmlFrom(messages, "串行翻译结果。") };
      },
    };
    const service = serviceWith({ llm: fakeLlm });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    const results = await Promise.all([
      service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" })),
      service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" })),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(maxActive).toBe(1);
    expect(translateCalls).toBe(1);
    expect(JSON.parse(await readFile(join(root, "state", "chapter_state.json"), "utf8")).chapters.ch001.state).toBe("approved");
  });

  it("resumes an interrupted translating state after service recreation", async () => {
    const firstLlm = { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, '中断前的占位译文。') }) };
    const first = serviceWith({ llm: firstLlm });
    const { root, workspaceId } = await createImportedWorkspace(first, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    const stateStore = new ChapterStateStore(root);
    await stateStore.transition("ch001", "ready", { runId: "interrupted", reason: "准备翻译" });
    await stateStore.transition("ch001", "translating", { runId: "interrupted", reason: "进程退出" });
    await mkdir(join(root, "state", "staging"), { recursive: true });
    await writeFile(join(root, "state", "staging", "ch001_zh.md"), "旧 staging", "utf8");

    let calls = 0;
    const reopened = serviceWith({ llm: { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => { calls += 1; return { text: xmlFrom(messages, "恢复后的译文。") }; } } });
    const opened = await reopened.invoke(envelope("workspace.open", { path: root }));
    expect(opened).toMatchObject({ ok: true, value: { id: workspaceId } });
    const resumed = await reopened.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    expect(resumed).toMatchObject({ ok: true, value: { workflowStatus: "approved", workflow: { state: "approved", attempt: 2 } } });
    expect(calls).toBe(1);
    expect(await readFile(join(root, "translations", "ch001_zh.md"), "utf8")).toContain("恢复后的译文");
  });

  it("counts missing-staging recovery as one translator attempt", async () => {
    const service = serviceWith({ llm: { complete: async () => ({ text: "恢复 staging 缺失的译文。" }) } });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    const stateStore = new ChapterStateStore(root);
    await stateStore.transition("ch001", "ready", { runId: "missing-staging" });
    await stateStore.transition("ch001", "translating", { runId: "missing-staging" });
    await stateStore.transition("ch001", "translated", { runId: "missing-staging" });
    await rm(join(root, "state", "staging"), { recursive: true, force: true });

    let calls = 0;
    const reopened = serviceWith({ llm: { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => { calls += 1; return { text: xmlFrom(messages, "恢复 staging 缺失的译文。") }; } } });
    const opened = await reopened.invoke(envelope("workspace.open", { path: root }));
    expect(opened).toMatchObject({ ok: true, value: { id: workspaceId } });
    const result = await reopened.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    expect(result).toMatchObject({ ok: true, value: { workflow: { state: "approved", attempt: 2 } } });
    expect(calls).toBe(1);
  });

  it("promotion supersedes a pre-translation draft on reload", async () => {
    const fakeLlm = { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, '这是翻译结果。') }) };
    const service = serviceWith({ llm: fakeLlm });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    const loaded = await service.invoke(envelope("chapter.load", { workspaceId, chapterId: "ch001" }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const drafted = await service.invoke(envelope("chapter.saveDraft", {
      workspaceId,
      chapterId: "ch001",
      baseRevision: loaded.value.revision,
      paragraphs: loaded.value.paragraphs.map((paragraph) => ({ ...paragraph, translation: "旧 draft" })),
    }));
    expect(drafted).toMatchObject({ ok: true });
    const translated = await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    expect(translated).toMatchObject({ ok: true, value: { workflowStatus: "approved" } });
    const reloaded = await service.invoke(envelope("chapter.load", { workspaceId, chapterId: "ch001" }));
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value.hasApprovedTranslation).toBe(true);
      expect(reloaded.value.paragraphs[0]?.translation).toContain("这是翻译结果");
    }
    await expect(readFile(join(root, "state", "drafts", "ch001.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("R3-2：作者改过的段落被标 human，整章重译不再覆盖它", async () => {
    const fakeLlm = { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, "机翻结果。") }) };
    const service = serviceWith({ llm: fakeLlm });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    expect(await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }))).toMatchObject({ ok: true });

    const loaded = await service.invoke(envelope("chapter.load", { workspaceId, chapterId: "ch001" }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // 只改第一段：其余段落同样被提交，但内容未变，不应该被冻成人工段
    await service.invoke(envelope("chapter.saveDraft", {
      workspaceId,
      chapterId: "ch001",
      baseRevision: loaded.value.revision,
      paragraphs: loaded.value.paragraphs.map((paragraph, index) => index === 0 ? { ...paragraph, translation: "我亲手改的译文" } : { ...paragraph }),
    }));
    const paragraphsPath = join(root, "state", "paragraphs", "ch001.json");
    const afterEdit = JSON.parse(await readFile(paragraphsPath, "utf8")) as { paragraphs: Array<{ translation: string; translatedBy?: string }> };
    expect(afterEdit.paragraphs[0]?.translatedBy).toBe("human");
    expect(afterEdit.paragraphs[1]?.translatedBy).not.toBe("human");

    expect(await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }))).toMatchObject({ ok: true });
    const afterRetranslate = JSON.parse(await readFile(paragraphsPath, "utf8")) as { paragraphs: Array<{ translation: string; translatedBy?: string }> };
    expect(afterRetranslate.paragraphs[0]?.translation).toBe("我亲手改的译文");
    expect(afterRetranslate.paragraphs[0]?.translatedBy).toBe("human");
  });

  it("R5-1：stuck 章节可由作者显式接受，进而解锁导出", async () => {
    const fakeLlm = { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, "これは日本語のままです。") }) };
    const service = serviceWith({ llm: fakeLlm });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    const translated = await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    expect(translated).toMatchObject({ ok: true, value: { workflowStatus: "stuck" } });

    // RV-07：卡在 stuck 也导得出——译文在 state/staging，导出回落读它并如实标注来源。
    // 「拿不到书」的唯一合法原因是那部分真的还没译（ch002 从未翻译 → 跳过）。
    const stuckExport = await service.invoke(envelope("export.run", { workspaceId, target: "all", format: "md" }));
    expect(stuckExport).toMatchObject({ ok: true, value: { exported: ["ch001"], fromStaging: ["ch001"], skipped: ["ch002"] } });

    const accepted = await service.invoke(envelope("chapter.accept", { workspaceId, chapterId: "ch001" }));
    expect(accepted).toMatchObject({ ok: true, value: { state: "approved" } });
    const reloaded = await service.invoke(envelope("chapter.load", { workspaceId, chapterId: "ch001" }));
    expect(reloaded).toMatchObject({ ok: true, value: { workflow: { state: "approved" } } });

    // 重复接受幂等
    expect(await service.invoke(envelope("chapter.accept", { workspaceId, chapterId: "ch001" }))).toMatchObject({ ok: true, value: { state: "approved" } });

    // 接受必须同时把暂存译文提升为正式译文：
    // 只改状态不提升，导出会报 Missing translation，approved 就是张空头支票。
    expect(await readFile(join(root, "translations", "ch001_zh.md"), "utf8")).toContain("日本語");
    expect(await service.invoke(envelope("export.run", { workspaceId, target: "ch001", format: "md" }))).toMatchObject({ ok: true });
  });

  it("R5-1：未翻译的普通章节不得直接接受", async () => {
    const service = serviceWith();
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    expect(await service.invoke(envelope("chapter.accept", { workspaceId, chapterId: "ch001" }))).toMatchObject({
      ok: false, error: { code: "conflict" },
    });
  });

  it("keeps approved translation visible when staging fails first review", async () => {
    const fakeLlm = { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, 'これは日本語のままです。') }) };
    const service = serviceWith({ llm: fakeLlm });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    await writeFile(join(root, "translations", "ch001_zh.md"), "旧版已通过译文。\n", "utf8");
    const translated = await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    // RV-03：整章未译不是「局部问题」（2/2 段命中，远超 15% 阈值），直接交给作者，
    // 一次修订都不该发生——从前这里会先烧一轮整章重译，reviseCount 因此是 1。
    expect(translated).toMatchObject({ ok: true, value: { workflowStatus: "stuck", workflow: { state: "stuck", reviseCount: 0 }, review: { issueCount: expect.any(Number) } } });
    if (!translated.ok) return;
    expect(translated.value.review?.issueCount).toBeGreaterThan(0);
    expect(await readFile(join(root, "translations", "ch001_zh.md"), "utf8")).toContain("旧版已通过译文");
    expect(await readFile(join(root, "state", "staging", "ch001_zh.md"), "utf8")).toContain("日本語");
    // RV-07：导出不再被状态挡住，但「定稿优先」保证它拿到的仍是旧版已通过译文，
    // 而不是这次失败的暂存稿——这正是本例要守的东西。
    const exported = await service.invoke(envelope("export.run", { workspaceId, target: "ch001", format: "md" }));
    expect(exported).toMatchObject({ ok: true, value: { exported: ["ch001"], fromStaging: [] } });
    if (!exported.ok) return;
    expect(await readFile(exported.value.outPath!, "utf8")).toContain("旧版已通过译文");
  });

  it("RV-02 翻译流程内的审校跑得到段落级检查（译文里夹着假名必中 kana_leftover）", async () => {
    // 段落级检查此前在应用正常流程里一次都没跑过：管线审校走 translationOverride，
    // 而 review-one 在有 override 时不传段落。这条钉的是「管线路径也跑得到」。
    const leakLlm = {
      complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => {
        const user = messages.find((message) => message.role === "user")?.content ?? "";
        const paras = [...user.matchAll(/<paragraph id="([^"]+)"[^>]*>([\s\S]*?)<\/paragraph>/g)];
        // 中文译文里留着没译的片假名专名——术语表外的角色名最常见的形态
        return { text: paras.map((m) => `<paragraph id="${m[1]}">她朝ヒヤマ喊了一声，没有回应。</paragraph>`).join("\n") };
      },
    };
    const service = serviceWith({ llm: leakLlm });
    const longJa = "彼女は静かに立ち上がり、窓の外に広がる夜の街を見つめていた。";
    const { root, workspaceId } = await createImportedWorkspace(service, `第1章 テスト\n\n${longJa}\n\n第2章 つづき\n\n${longJa}\n`);
    await markTerminologyConfirmed(root);
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));

    const report = JSON.parse(await readFile(join(root, "reviews", "ch001.current.json"), "utf8")) as { issues: Array<{ type: string }> };
    expect(report.issues.map((i) => i.type)).toContain("kana_leftover");
  });

  it("reviews a chapter and reports L0/L1 issues", async () => {
    const fakeLlm = { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, '这是翻译结果。') }) };
    const service = serviceWith({ llm: fakeLlm });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    const beforeWorkflow = await readFile(join(root, "state", "chapter_state.json"), "utf8");
    const reviewed = await service.invoke(envelope("review.run", { workspaceId, chapterId: "ch001" }));
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.chapterId).toBe("ch001");
    expect(Array.isArray(reviewed.value.issues)).toBe(true);
    expect(await readFile(join(root, "state", "chapter_state.json"), "utf8")).toBe(beforeWorkflow);
  });

  it("applies confirmation verdicts through the engine session", async () => {
    const service = serviceWith();
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    const { createSession } = await import("@lightee/engine");
    await createSession({ root }, [
      { id: "c1", ja: "比喩", zh: "比喻", candidates: ["比喻", "隐喻"], type: "道具" },
      { id: "c2", ja: "可憐", zh: "惹人怜爱", candidates: ["惹人怜爱", "怜惜"], type: "称呼" },
    ]);

    const first = await service.invoke(envelope("confirm.decide", { workspaceId, action: "accept", chosenZh: "隐喻" }));
    expect(first).toMatchObject({ ok: true, value: { index: 1, total: 2, applied: 0 } });
    const back = await service.invoke(envelope("confirm.decide", { workspaceId, action: "back" }));
    expect(back).toMatchObject({ ok: true, value: { index: 0 } });
    const retried = await service.invoke(envelope("confirm.decide", { workspaceId, action: "accept", chosenZh: "隐喻" }));
    expect(retried).toMatchObject({ ok: true, value: { index: 1 } });
    const last = await service.invoke(envelope("confirm.decide", { workspaceId, action: "modify", chosenZh: "怜惜" }));
    expect(last).toMatchObject({ ok: true, value: { index: 2, total: 2, applied: 2 } });
    const terms = JSON.parse(await readFile(join(root, "terminology", "terms.json"), "utf8"));
    expect(terms.map((term: { ja: string }) => term.ja)).toEqual(["比喩", "可憐"]);
  });

  /**
   * 选到一个普通目录时，界面要能分辨「这不是工作区」和「这个工作区坏了」——
   * 前者的出路是就地新建，后者不是。这个判断只有服务层知道，靠比对错误文案传不可靠。
   */
  it("workspace.open 打开非工作区目录时标出 notAWorkspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-plain-"));
    roots.push(root);
    await writeFile(join(root, "随手放的.txt"), "这里本来就有文件", "utf8");
    const service = serviceWith();

    const opened = await service.invoke(envelope("workspace.open", { path: root }));
    expect(opened).toMatchObject({ ok: false, error: { code: "invalid_request", details: { notAWorkspace: true } } });

    // 就地初始化不碰目录里已有的东西
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "就地新建" }));
    expect(created).toMatchObject({ ok: true, value: { name: "就地新建" } });
    // 失败的一次打开不许在目录里留下东西——留下半个 book.yaml，书名就再也写不进去了
    expect(await readFile(join(root, "book.yaml"), "utf8")).toContain("name: 就地新建");
    expect(await readFile(join(root, "随手放的.txt"), "utf8")).toBe("这里本来就有文件");
    expect(await service.invoke(envelope("workspace.open", { path: root }))).toMatchObject({ ok: true });
  });

  /**
   * 档案是按名字分表存的。terms.delete 从前不收 archive，一律按 terms 表找 id——
   * 于是「删一条人名」和「拒绝一条模型暂定人名」都以 not_found 收场，
   * 而语气/拟声/字典几栏更是连回收站都进不去（白名单只放行 terms/names）。
   */
  it("术语删除/还原认档案：人名与字典条目都能删、都能原位还原", async () => {
    const service = serviceWith();
    const { workspaceId, root } = await createImportedWorkspace(service, SAMPLE_TXT);
    const namesPath = join(root, "terminology", "names.json");
    await writeFile(namesPath, JSON.stringify([
      { id: "n1", ja: "藤井", zh: "藤井", type: "name" },
      { id: "n2", ja: "白鳥", zh: "白鸟", type: "name" },
    ]), "utf8");
    // 投影必须在首次读术语仓库之前写好：仓库一旦建起快照，快照就是权威，投影只是它的输出
    await writeFile(join(root, "terminology", "post-dict.json"), JSON.stringify([
      { id: "d1", find: "首先", replace: "起初", type: "literal", enabled: true },
    ]), "utf8");

    // 不带 archive 依旧按 terms 找 → 找不到，且一个字节都不写
    const untargeted = await service.invoke(envelope("terms.delete", { workspaceId, termId: "n2", baseRevision: 0 }));
    expect(untargeted).toMatchObject({ ok: false, error: { code: "not_found" } });

    const deletedName = await service.invoke(envelope("terms.delete", { workspaceId, termId: "n2", archive: "names", baseRevision: 0 }));
    expect(deletedName).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(namesPath, "utf8")).map((term: { id: string }) => term.id)).toEqual(["n1"]);
    expect(JSON.parse(await readFile(join(root, "state", "term-trash.json"), "utf8"))).toMatchObject([{ item: { id: "n2" }, archive: "names", originalIndex: 1 }]);

    if (!deletedName.ok) return;
    const restoredName = await service.invoke(envelope("terms.restore", { workspaceId, termId: "n2", archive: "names", baseRevision: (deletedName.value as { revision: number }).revision }));
    expect(restoredName).toMatchObject({ ok: true });
    // 原位回家：还原不该把顺序打乱，也不该落进别的档案
    expect(JSON.parse(await readFile(namesPath, "utf8")).map((term: { id: string }) => term.id)).toEqual(["n1", "n2"]);
    expect(JSON.parse(await readFile(join(root, "terminology", "terms.json"), "utf8")).some((term: { id: string }) => term.id === "n2")).toBe(false);

    // 字典档案同样要能删——只进不出的档案不是术语表，是死档案
    if (!restoredName.ok) return;
    const deletedRule = await service.invoke(envelope("terms.delete", {
      workspaceId, termId: "d1", archive: "postDict", baseRevision: (restoredName.value as { revision: number }).revision,
    }));
    expect(deletedRule).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(join(root, "terminology", "post-dict.json"), "utf8"))).toEqual([]);
  });

  /**
   * 术语表把八个档案摊平成一张表，为了跨档案不撞车，行的 `id` 是造出来的展示 id
   * （`档案名:条目id`，必要时再追加 `-2`）。仓库里没有这个键。
   *
   * 于是界面上除「普通术语」外的七个档案，编辑和删除点了都只会得到
   * `Terminology entry not found: names:names-xxxx`——前缀重了一次，一眼可辨。
   * 服务层本身是对的（给它 `n1` 就删得掉），错在交出一行却不交能改它的键。
   */
  /**
   * 「上次编辑」的语义：所有工作区里 savedAt 最大的**有效**会话。
   *
   * 从前的实现按工作区 openedAt 排序、返回第一个有会话文件的工作区——在 A 里
   * 编辑之后仅仅打开过 B，仪表盘就会举着 B 的陈年会话说那是「上次编辑」；
   * 会话指向的章节被重导入删掉后，还会渲染出一张预览全空、点进去落到第一章的卡。
   */
  it("上次编辑 = 全部工作区里 savedAt 最大的有效会话", async () => {
    const service = serviceWith();
    // A 先建、B 后建（B 的 openedAt 更新）——旧实现会因此偏向 B
    const a = await createImportedWorkspace(service, SAMPLE_TXT);
    const b = await createImportedWorkspace(service, SAMPLE_TXT);
    const chapterOf = async (root: string): Promise<string> =>
      JSON.parse(await readFile(join(root, "source", "manifest.json"), "utf8")).chapters[0].id;
    const chapterA = await chapterOf(a.root);
    const chapterB = await chapterOf(b.root);
    // A 的会话更新（savedAt 更大），B 的更旧
    await writeFile(join(a.root, "state", "session.json"), JSON.stringify({ workspaceId: a.workspaceId, chapterId: chapterA, savedAt: 2_000 }), "utf8");
    await writeFile(join(b.root, "state", "session.json"), JSON.stringify({ workspaceId: b.workspaceId, chapterId: chapterB, savedAt: 1_000 }), "utf8");
    const read = await service.invoke(envelope("workspace.session.read", {}));
    expect(read).toMatchObject({ ok: true, value: { workspaceId: a.workspaceId, chapterId: chapterA, savedAt: 2_000 } });

    // A 的会话指向被删掉的章节 → 作废，回落到 B 的旧会话而不是渲染一张空卡
    await writeFile(join(a.root, "state", "session.json"), JSON.stringify({ workspaceId: a.workspaceId, chapterId: "ch999", savedAt: 3_000 }), "utf8");
    const fallback = await service.invoke(envelope("workspace.session.read", {}));
    expect(fallback).toMatchObject({ ok: true, value: { workspaceId: b.workspaceId, chapterId: chapterB } });

    // 两边都失效 → null，仪表盘显示「尚未开始编辑」
    await writeFile(join(b.root, "state", "session.json"), JSON.stringify({ workspaceId: "别的工作区", chapterId: chapterB, savedAt: 4_000 }), "utf8");
    const none = await service.invoke(envelope("workspace.session.read", {}));
    expect(none).toMatchObject({ ok: true, value: null });
  });

  /**
   * 「上次编辑」恢复的是**位置**不只是章：保存时写入光标所在段（paragraphId），
   * 恢复时编辑器 revealParagraph 直接落回。合并语义：打开章节那次写入不带段落
   * （人还没编辑），不得抹掉同一章已记的位置；换章则位置作废。
   */
  it("会话记段落位置：打开不清位置，换章才清", async () => {
    const service = serviceWith();
    const { workspaceId, root } = await createImportedWorkspace(service, SAMPLE_TXT);
    const chapters = JSON.parse(await readFile(join(root, "source", "manifest.json"), "utf8")).chapters.map((c: { id: string }) => c.id);

    // 保存时带位置 → 存下
    const saved = await service.invoke(envelope("workspace.session.write", { workspaceId, chapterId: chapters[0], paragraphId: "p0003" }));
    expect(saved).toMatchObject({ ok: true, value: { chapterId: chapters[0], paragraphId: "p0003" } });

    // 同一章、不带位置（重新打开）→ 位置保留
    const reopened = await service.invoke(envelope("workspace.session.write", { workspaceId, chapterId: chapters[0] }));
    expect(reopened).toMatchObject({ ok: true, value: { chapterId: chapters[0], paragraphId: "p0003" } });

    // 换章、不带位置 → 位置作废（旧章的段落 id 在新章里毫无意义）
    const switched = await service.invoke(envelope("workspace.session.write", { workspaceId, chapterId: chapters[1] }));
    expect(switched).toMatchObject({ ok: true, value: { chapterId: chapters[1] } });
    if (!switched.ok) return;
    expect((switched.value as { paragraphId?: string }).paragraphId).toBeUndefined();

    // 读回来的会话带着位置字段
    await service.invoke(envelope("workspace.session.write", { workspaceId, chapterId: chapters[1], paragraphId: "p0007" }));
    const read = await service.invoke(envelope("workspace.session.read", {}));
    expect(read).toMatchObject({ ok: true, value: { chapterId: chapters[1], paragraphId: "p0007" } });
  });

  it("术语表交出来的行必须自带变更键，展示 id 不是键", async () => {
    const service = serviceWith();
    const { workspaceId, root } = await createImportedWorkspace(service, SAMPLE_TXT);
    await writeFile(join(root, "terminology", "names.json"), JSON.stringify([
      { id: "n1", ja: "藤井", zh: "藤井", type: "name" },
    ]), "utf8");

    const listed = await service.invoke(envelope("terms.query", { workspaceId }));
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) return;
    const row = listed.value.items.find((item: TermRecord) => item.archive === "names");
    expect(row).toBeDefined();
    // 展示 id 带档案前缀——这正是拿它当键时报错信息里前缀重复的来源
    expect(row!.id).toBe("names:n1");
    expect(row!.entryId).toBe("n1");

    // 拿行里带出来的键去删，必须成功。这一步以前是 not_found。
    const deleted = await service.invoke(envelope("terms.delete", {
      workspaceId, termId: String(row!.entryId), archive: "names", baseRevision: listed.value.revision,
    }));
    expect(deleted).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(join(root, "terminology", "names.json"), "utf8"))).toEqual([]);
  });

  it("keeps term CRUD authoritative, ordered, and revision-safe", async () => {
    const service = serviceWith();
    const events: Array<{ type: string; payload: unknown }> = [];
    service.subscribe((event) => {
      if (event.type === "terms.changed") events.push(event);
    });
    const { workspaceId, root } = await createImportedWorkspace(service, SAMPLE_TXT);
    const termsPath = join(root, "terminology", "terms.json");
    const trashPath = join(root, "state", "term-trash.json");
    const revisionsPath = join(root, "state", "ipc-revisions.json");
    await writeFile(termsPath, JSON.stringify([
      { id: "t1", ja: "第一", zh: "第一", type: "term", reading: "だいいち" },
      { id: "t2", ja: "第二", zh: "第二", type: "term", pending: true, note: "保留字段" },
      { id: "t3", ja: "第三", zh: "第三", type: "term" },
    ]), "utf8");
    await writeFile(trashPath, "[]", "utf8");

    const updated = await service.invoke(envelope("terms.update", { workspaceId, termId: "t2", ja: "第二", zh: "次要", type: "term", baseRevision: 0 }));
    expect(updated).toMatchObject({ ok: true, value: { revision: 1, reloadRequired: true } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "terms.changed", payload: { workspaceId, revision: 1, action: "updated" } });

    const beforeMissingUpdate = [await readFile(termsPath, "utf8"), await readFile(trashPath, "utf8"), await readFile(revisionsPath, "utf8"), events.length];
    const missingUpdate = await service.invoke(envelope("terms.update", { workspaceId, termId: "missing", ja: "不存在", zh: "不存在", baseRevision: 1 }));
    expect(missingUpdate).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect([await readFile(termsPath, "utf8"), await readFile(trashPath, "utf8"), await readFile(revisionsPath, "utf8"), events.length]).toEqual(beforeMissingUpdate);

    const deleted = await service.invoke(envelope("terms.delete", { workspaceId, termId: "t2", baseRevision: 1 }));
    expect(deleted).toMatchObject({ ok: true, value: { revision: 2, reloadRequired: true } });
    expect(JSON.parse(await readFile(trashPath, "utf8"))).toMatchObject([{ item: { id: "t2", note: "保留字段" }, originalIndex: 1 }]);
    const deletedQuery = await service.invoke(envelope("terms.query", { workspaceId, search: "第二", filters: { deleted: true } }));
    expect(deletedQuery).toMatchObject({ ok: true, value: { revision: 2, items: [{ id: "t2", deletedAt: expect.any(Number), readOnly: false }] } });
    expect(events).toHaveLength(2);

    const beforeMissingDelete = [await readFile(termsPath, "utf8"), await readFile(trashPath, "utf8"), await readFile(revisionsPath, "utf8"), events.length];
    const missingDelete = await service.invoke(envelope("terms.delete", { workspaceId, termId: "missing", baseRevision: 2 }));
    expect(missingDelete).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect([await readFile(termsPath, "utf8"), await readFile(trashPath, "utf8"), await readFile(revisionsPath, "utf8"), events.length]).toEqual(beforeMissingDelete);

    const restored = await service.invoke(envelope("terms.restore", { workspaceId, termId: "t2", baseRevision: 2 }));
    expect(restored).toMatchObject({ ok: true, value: { revision: 3, reloadRequired: true } });
    expect(JSON.parse(await readFile(termsPath, "utf8")).map((term: { id: string }) => term.id)).toEqual(["t1", "t2", "t3"]);
    expect(JSON.parse(await readFile(termsPath, "utf8"))[1]).toMatchObject({ id: "t2", zh: "次要", note: "保留字段", pending: true });
    expect(JSON.parse(await readFile(trashPath, "utf8"))).toEqual([]);
    expect(events).toHaveLength(3);

    const beforeMissingRestore = [await readFile(termsPath, "utf8"), await readFile(trashPath, "utf8"), await readFile(revisionsPath, "utf8"), events.length];
    const missingRestore = await service.invoke(envelope("terms.restore", { workspaceId, termId: "missing", baseRevision: 3 }));
    expect(missingRestore).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect([await readFile(termsPath, "utf8"), await readFile(trashPath, "utf8"), await readFile(revisionsPath, "utf8"), events.length]).toEqual(beforeMissingRestore);

    const stale = await service.invoke(envelope("terms.delete", { workspaceId, termId: "t1", baseRevision: 0 }));
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(events).toHaveLength(3);
    // 收窄到 terms 档案：本用例考的是 terms 的 CRUD 与版本安全，不是全档案投影（那条由
    // "queries all terminology archives..." 断言，含新建工作区播种的内置译后规则）。
    const queried = await service.invoke(envelope("terms.query", { workspaceId, filters: { archive: "terms" } }));
    expect(queried).toMatchObject({ ok: true, value: { revision: 3, items: [{ id: "t1" }, { id: "t2", zh: "次要" }, { id: "t3" }] } });
  });

  it("queries all terminology archives as a deterministic editable projection", async () => {
    const service = serviceWith();
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await writeFile(join(root, "terminology", "names.json"), JSON.stringify([
      { id: "same", ja: "アリス", zh: "爱丽丝", type: "person_name", reading: "ありす", confidence: 0.9 },
      { id: "same", ja: "アリス二", zh: "爱丽丝二", type: "person_name", reading: "ありすに", confidence: 0.8 },
    ]), "utf8");
    await writeFile(join(root, "terminology", "terms.json"), JSON.stringify([
      { id: "same", ja: "魔導具", zh: "魔导具", type: "item", status: "confirmed" },
    ]), "utf8");
    await writeFile(join(root, "terminology", "voice.json"), JSON.stringify([
      { id: "voice-1", character: "ボブ", selfRefJa: "俺", selfRefZh: "我", particlesJa: ["だぜ"], zhStrategy: "偏口语", politeStyle: "plain", status: "confirmed", confidence: 0.95 },
    ]), "utf8");
    await writeFile(join(root, "terminology", "onomatopoeia.json"), JSON.stringify([
      { id: "ono-1", ja: "ざあざあ", zh: "哗啦", type: "single", scene: "雨", strategy: "translate", status: "confirmed" },
    ]), "utf8");
    await writeFile(join(root, "terminology", "puns.json"), JSON.stringify([
      { ja: "ひやまあかり", zh: "桧山灯", note: "读音双关", confidence: 0.8 },
      { ja: "ひやまあかり", zh: "灯灯", note: "重复梗", confidence: 0.7 },
    ]), "utf8");
    await writeFile(join(root, "state", "cards.json"), JSON.stringify([{ ja: "待确认候选", type: "term", candidates: [] }]), "utf8");

    const firstPage = await service.invoke(envelope("terms.query", { workspaceId }));
    expect(firstPage).toMatchObject({ ok: true, value: { revision: 0, items: expect.any(Array), nextCursor: null } });
    if (!firstPage.ok) return;
    // 末尾两条是新建工作区播种的内置译后规则（Q3）——它们是工作区的既有事实，
    // 和作者自己写的规则同档案、同权限，因此必须出现在这个投影里。
    expect(firstPage.value.items).toHaveLength(7 + SEEDED_POST_DICT_RULES.length);
    expect(firstPage.value.items.map((item) => item.id)).toEqual([
      "names:same",
      "names:same-2",
      "same",
      "voice:voice-1",
      "onomatopoeia:ono-1",
      "puns:entry-1",
      "puns:entry-2",
      ...SEEDED_POST_DICT_RULES.map((rule) => `postDict:${rule.id}`),
    ]);
    expect(firstPage.value.items.map((item) => item.archive)).toEqual([
      "names", "names", "terms", "voice", "onomatopoeia", "puns", "puns",
      ...SEEDED_POST_DICT_RULES.map(() => "postDict"),
    ]);
    expect(firstPage.value.items[0]).toMatchObject({ id: "names:same", sourceId: "same", archiveFile: "names.json", readOnly: false, reading: "ありす" });
    expect(firstPage.value.items[2]).toMatchObject({ id: "same", archive: "terms", readOnly: false, type: "item" });
    expect(firstPage.value.items[3]).toMatchObject({ ja: "ボブ / 俺", zh: "我", character: "ボブ", particlesJa: ["だぜ"], readOnly: false });

    const missingToken = await service.invoke(envelope("terms.query", { workspaceId, cursor: 5 }));
    expect(missingToken).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const secondPage = await service.invoke(envelope("terms.query", { workspaceId, cursor: 5, baseRevision: firstPage.value.revision }));
    expect(secondPage).toMatchObject({ ok: true, value: { items: [
      { id: "puns:entry-1" },
      { id: "puns:entry-2" },
      ...SEEDED_POST_DICT_RULES.map((rule) => ({ id: `postDict:${rule.id}` })),
    ], nextCursor: null } });
    const archiveFiltered = await service.invoke(envelope("terms.query", { workspaceId, filters: { archive: "voice" } }));
    expect(archiveFiltered).toMatchObject({ ok: true, value: { items: [{ id: "voice:voice-1", archive: "voice", ja: "ボブ / 俺" }] } });
    const metadataSearch = await service.invoke(envelope("terms.query", { workspaceId, search: "口语" }));
    expect(metadataSearch).toMatchObject({ ok: true, value: { items: [{ id: "voice:voice-1" }] } });
    const statusFiltered = await service.invoke(envelope("terms.query", { workspaceId, filters: { status: "confirmed" } }));
    expect(statusFiltered).toMatchObject({ ok: true, value: { items: expect.any(Array) } });
    if (!statusFiltered.ok) return;
    expect(statusFiltered.value.items.map((item) => item.id)).toEqual(expect.arrayContaining(["same", "voice:voice-1"]));

    const beforeTerms = await readFile(join(root, "terminology", "terms.json"), "utf8");
    const beforeRevision = await readFile(join(root, "state", "ipc-revisions.json"), "utf8").catch(() => "");
    const mutation = await service.invoke(envelope("terms.update", { workspaceId, termId: "names:same", ja: "不应修改", zh: "不应修改", baseRevision: 0 }));
    expect(mutation).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await readFile(join(root, "terminology", "terms.json"), "utf8")).toBe(beforeTerms);
    expect(await readFile(join(root, "state", "ipc-revisions.json"), "utf8").catch(() => "")).toBe(beforeRevision);
    const listed = await service.invoke(envelope("confirm.list", { workspaceId }));
    expect(listed).toMatchObject({ ok: true, value: { cards: [{ ja: "待确认候选" }] } });
    expect(firstPage.value.items.some((item) => item.ja === "待确认候选")).toBe(false);
  });

  it("lets the author add ordinary terms and repair unresolved voice entries", async () => {
    const service = serviceWith();
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await writeFile(join(root, "terminology", "voice.json"), JSON.stringify([
      { id: "voice-1", character: "unknown_character", selfRefJa: "俺", selfRefZh: "老子", zhStrategy: "粗鲁直率", ja: "unknown_character / 俺", context: "unknown_character: 粗鲁直率", status: "confirmed" },
    ]), "utf8");

    const initial = await service.invoke(envelope("terms.query", { workspaceId, filters: { archive: "voice" } }));
    expect(initial).toMatchObject({ ok: true, value: { revision: 0, items: [{ id: "voice:voice-1", character: "", status: "pending_review", readOnly: false }] } });
    const repaired = await service.invoke(envelope("terms.update", {
      workspaceId,
      termId: "voice:voice-1",
      archive: "voice",
      character: "森村透",
      ja: "俺",
      zh: "我",
      strategy: "第一人称自然口语",
      baseRevision: 0,
    }));
    expect(repaired).toMatchObject({ ok: true, value: { revision: 1 } });
    const created = await service.invoke(envelope("terms.create", {
      workspaceId,
      archive: "terms",
      ja: "生徒会",
      zh: "学生会",
      baseRevision: 1,
    }));
    expect(created).toMatchObject({ ok: true, value: { revision: 2 } });

    const queried = await service.invoke(envelope("terms.query", { workspaceId }));
    expect(queried).toMatchObject({ ok: true, value: { items: expect.arrayContaining([
      expect.objectContaining({ archive: "voice", character: "森村透", ja: "森村透 / 俺", zh: "我", status: "confirmed" }),
      expect.objectContaining({ archive: "terms", ja: "生徒会", zh: "学生会", readOnly: false }),
    ]) } });
    expect(await readFile(join(root, "terminology", "voice.json"), "utf8")).not.toContain("unknown_character");
  });

  it("R1: 三类作者字典经 terms.* 往返，存储用 find/replace 而界面看到的是 ja/zh 投影", async () => {
    const service = serviceWith();
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);

    const pre = await service.invoke(envelope("terms.create", {
      workspaceId, archive: "preDict", ja: "―", zh: "——", baseRevision: 0,
    }));
    expect(pre).toMatchObject({ ok: true, value: { revision: 1 } });
    const post = await service.invoke(envelope("terms.create", {
      workspaceId, archive: "postDict", ja: "(\u4ed6)+", zh: "$1", type: "regex", baseRevision: 1,
    }));
    expect(post).toMatchObject({ ok: true, value: { revision: 2 } });
    const ban = await service.invoke(envelope("terms.create", {
      workspaceId, archive: "noTranslate", ja: "Wi-Fi", zh: "Wi-Fi", strategy: "品牌名", baseRevision: 2,
    }));
    expect(ban).toMatchObject({ ok: true, value: { revision: 3 } });

    const queried = await service.invoke(envelope("terms.query", { workspaceId }));
    expect(queried).toMatchObject({ ok: true, value: { items: expect.arrayContaining([
      expect.objectContaining({ archive: "preDict", ja: "―", zh: "——", find: "―", replace: "——", enabled: true }),
      expect.objectContaining({ archive: "postDict", type: "regex", find: "(\u4ed6)+" }),
      expect.objectContaining({ archive: "noTranslate", ja: "Wi-Fi", zh: "Wi-Fi", note: "品牌名" }),
    ]) } });

    // 落盘投影用引擎读得懂的字段名
    const stored = JSON.parse(await readFile(join(root, "terminology", "pre-dict.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(stored[0]).toMatchObject({ find: "―", replace: "——" });

    // 关掉一条规则：字典条目删不掉，停用是唯一的止损手段
    const preId = (queried as { value: { items: Array<Record<string, unknown>> } }).value.items.find((item) => item.archive === "preDict")!.id as string;
    const disabled = await service.invoke(envelope("terms.update", {
      workspaceId, termId: preId, archive: "preDict", ja: "―", zh: "——", enabled: false, baseRevision: 3,
    }));
    expect(disabled).toMatchObject({ ok: true, value: { revision: 4 } });
    const after = await service.invoke(envelope("terms.query", { workspaceId }));
    expect((after as { value: { items: Array<Record<string, unknown>> } }).value.items.find((item) => item.archive === "preDict")).toMatchObject({ enabled: false });
  });

  it("rejects a stale pagination token instead of mixing terminology snapshots", async () => {
    const service = serviceWith();
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await writeFile(join(root, "terminology", "terms.json"), JSON.stringify([
      { id: "page-a", ja: "分页甲", zh: "分页甲", type: "term" },
      { id: "page-b", ja: "分页乙", zh: "分页乙", type: "term" },
    ]), "utf8");
    const first = await service.invoke(envelope("terms.query", { workspaceId }));
    expect(first).toMatchObject({ ok: true, value: { revision: 0 } });
    const external = new TerminologyRepository(root);
    await external.mergeEntries({ operationId: "pagination-commit", baseRevision: 0, action: "confirmed", entries: [{ archive: "names", entry: { id: "page-name", ja: "分页名称", zh: "分页名称" } }] });
    const stalePage = await service.invoke(envelope("terms.query", { workspaceId, cursor: 1, baseRevision: 0 }));
    expect(stalePage).toMatchObject({ ok: false, error: { code: "conflict", details: { currentRevision: 1, baseRevision: 0 } } });
  });

  it("keeps malformed and duplicate terms IDs writable through query round trips", async () => {
    const service = serviceWith();
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await writeFile(join(root, "terminology", "terms.json"), JSON.stringify([
      { ja: "缺失ID", zh: "缺失 ID", type: "term" },
      { id: "dup", ja: "重复一", zh: "重复一", type: "term" },
      { id: "dup", ja: "重复二", zh: "重复二", type: "term" },
    ]), "utf8");

    const queried = await service.invoke(envelope("terms.query", { workspaceId, filters: { archive: "terms" } }));
    expect(queried).toMatchObject({ ok: true, value: { items: [
      { id: "terms:entry-1", ja: "缺失ID" },
      { id: "dup", ja: "重复一" },
      { id: "dup-2", ja: "重复二" },
    ] } });
    const updated = await service.invoke(envelope("terms.update", { workspaceId, termId: "terms:entry-1", ja: "缺失ID", zh: "已修正 ID", baseRevision: 0 }));
    expect(updated).toMatchObject({ ok: true, value: { revision: 1 } });
    const deleted = await service.invoke(envelope("terms.delete", { workspaceId, termId: "dup-2", baseRevision: 1 }));
    expect(deleted).toMatchObject({ ok: true, value: { revision: 2 } });
    const after = await service.invoke(envelope("terms.query", { workspaceId, filters: { archive: "terms" } }));
    expect(after).toMatchObject({ ok: true, value: { revision: 2, items: [{ id: "terms:entry-1", zh: "已修正 ID" }, { id: "dup" }] } });
  });

  it("canonicalizes unsafe archive IDs before renderer-facing projection", async () => {
    const service = serviceWith();
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await writeFile(join(root, "terminology", "names.json"), JSON.stringify([
      { id: "bad\" data-x=\"broken", ja: "危险名称", zh: "危险名", type: "person_name" },
    ]), "utf8");
    const queried = await service.invoke(envelope("terms.query", { workspaceId, filters: { archive: "names" } }));
    expect(queried).toMatchObject({ ok: true, value: { items: [{ id: "names:entry-1", sourceId: "bad\" data-x=\"broken", readOnly: false }] } });
  });

  it("emits one canonical event and one compatibility event for an external repository commit", async () => {
    const service = serviceWith({ terminologyWatcher: true });
    const canonical: Array<{ type: string; payload: unknown }> = [];
    const compatibility: Array<{ type: string; payload: unknown }> = [];
    service.subscribe((event) => {
      if (event.type === "terminology.changed") canonical.push(event);
      if (event.type === "terms.changed") compatibility.push(event);
    });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    const external = new TerminologyRepository(root);
    const committed = await external.mergeEntries({
      operationId: "external-term-1",
      baseRevision: 0,
      action: "confirmed",
      entries: [{ archive: "terms", entry: { id: "external-1", ja: "外部术语", zh: "外部译名", type: "term" } }],
    });
    expect(committed.commit).toMatchObject({ revision: 1, archives: ["terms"] });
    const started = Date.now();
    while (canonical.length === 0 && Date.now() - started < 2_000) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({ type: "terminology.changed", payload: { workspaceId, revision: 1, archives: ["terms"], action: "confirmed" } });
    expect(compatibility).toHaveLength(1);
    expect(compatibility[0]).toMatchObject({ type: "terms.changed", payload: { workspaceId, revision: 1, action: "updated" } });
    service.markClosing();
  });

  it("只从快照兜底看到的提交，也带真实动作发出（不改标成 recovered）", async () => {
    // 仓库先写快照、再追加事件；轮询恰好落在这两次写中间，就会「事件日志里没有、快照里已经有」。
    // 旧代码把这种正常提交一律标成 recovered，而窗口宽窄只取决于磁盘快慢——CI 上随机翻车。
    // 这里删掉事件日志把兜底分支固定下来：不管走的是哪条路，作者看到的动作都必须是真实的那个。
    const seed = serviceWith({ terminologyWatcher: false });
    const { root } = await createImportedWorkspace(seed, SAMPLE_TXT);
    const external = new TerminologyRepository(root);
    const committed = await external.mergeEntries({
      operationId: "late-event-1",
      baseRevision: 0,
      action: "confirmed",
      entries: [{ archive: "terms", entry: { id: "late-1", ja: "迟到术语", zh: "迟到译名", type: "term" } }],
    });
    expect(committed.commit).toMatchObject({ revision: 1, action: "confirmed" });
    await rm(join(root, "state", "terminology-events.jsonl"), { force: true });

    const watching = serviceWith({ terminologyWatcher: true });
    const canonical: Array<{ type: string; payload: any }> = [];
    watching.subscribe((event) => { if (event.type === "terminology.changed") canonical.push(event as never); });
    const opened = await watching.invoke(envelope("workspace.open", { path: root }));
    expect(opened.ok).toBe(true);
    const started = Date.now();
    while (canonical.length === 0 && Date.now() - started < 3_000) await new Promise((wait) => setTimeout(wait, 50));
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.payload).toMatchObject({ revision: 1, archives: ["terms"], action: "confirmed" });
    watching.markClosing();
  });

  it("polls external confirmation progress and final status through durable terminology events", async () => {
    const service = serviceWith({ terminologyWatcher: true });
    const events: Array<{ type: string; payload: any }> = [];
    service.subscribe((event) => {
      if (event.type === "terminology.changed") events.push(event);
    });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    const session = await createSession({ root }, [{ ja: "外部确认", type: "term", candidates: [{ zh: "外部译名", confidence: 0.9, evidence: [] }], cardKind: "confirm", cardId: "external-card" }] as never);
    await confirmVerdict({ root }, session, { action: "accept", chosenZh: "外部译名" });
    const started = Date.now();
    while (!events.some((event) => event.payload.action === "status") && Date.now() - started < 2_000) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(events.some((event) => event.payload.action === "status" && event.payload.status === "pending")).toBe(true);
    const progress = await service.invoke(envelope("confirm.list", { workspaceId }));
    expect(progress).toMatchObject({ ok: true, value: { revision: 0, status: { status: "pending" }, session: { index: 1 } } });
    await finishConfirmSession({ root }, session);
    const finalStarted = Date.now();
    while (!events.some((event) => event.payload.action === "confirmed") && Date.now() - finalStarted < 2_000) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(events.some((event) => event.payload.action === "confirmed" && event.payload.revision === 1)).toBe(true);
    const completed = await service.invoke(envelope("confirm.list", { workspaceId }));
    expect(completed).toMatchObject({ ok: true, value: { revision: 1, status: { status: "confirmed" }, session: null } });

    const beforeSkipped = events.length;
    const skippedSession = await createSession({ root }, [{ ja: "外部跳过", type: "term", candidates: [{ zh: "不进入术语表", confidence: 0.5, evidence: [] }], cardKind: "confirm", cardId: "external-skip" }] as never);
    await confirmVerdict({ root }, skippedSession, { action: "skip" });
    await finishConfirmSession({ root }, skippedSession);
    const skippedStarted = Date.now();
    while (events.length <= beforeSkipped && Date.now() - skippedStarted < 2_000) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(events.length).toBeGreaterThan(beforeSkipped);
    const skippedCompleted = await service.invoke(envelope("confirm.list", { workspaceId }));
    expect(skippedCompleted).toMatchObject({ ok: true, value: { revision: 1, status: { status: "confirmed" }, session: null } });
  });

  it("rejects invalid terminology archive filters at the IPC boundary", async () => {
    const invalid = createIpcService().invoke(envelope("terms.query", { workspaceId: "workspace", filters: { archive: "unknown" } }));
    await expect(invalid).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  // CHK-02：审校自定义规则整族删除（IPC 命令、服务、面板、引擎侧规则轮）。
  // 文字写成的规则判不出模型有没有遵守，那一轮把「像是违规」当成「违规」。

  it("RV-01 未定稿章节审校读 staging，而不是打绿勾", async () => {
    // 译文只躺在 state/staging（翻完未定稿、也没在编辑器里保存过）——这是最常见的状态，
    // 从前在这里点「审校本章」必得一个假的 0 问题。
    // 判据用 untranslated：暂存稿整段还是日文，只有真读了 staging 才查得出来。
    // 不用段落级检查——这个场景下没有 state/paragraphs，那些检查按设计不跑。
    const service = serviceWith({});
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await mkdir(join(root, "state", "staging"), { recursive: true });
    await writeFile(join(root, "state", "staging", "ch001_zh.md"), "彼女は静かに立ち上がり、窓の外を見つめていた。\n", "utf8");
    expect(existsSync(join(root, "translations", "ch001_zh.md"))).toBe(false);

    const reviewed = await service.invoke(envelope("review.run", { workspaceId, chapterId: "ch001" }));
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.noTranslation).toBeFalsy();
    expect(reviewed.value.issues).toEqual(expect.arrayContaining([expect.objectContaining({ type: "untranslated" })]));
  });

  it("RV-04 review.run 返回结构化 paragraphId 与真实的 checksRun", async () => {
    const service = serviceWith({});
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    // 段落权威文件在位 → 六项段落检查跑得到，且问题带段落 id。
    await mkdir(join(root, "state", "paragraphs"), { recursive: true });
    await writeFile(join(root, "state", "paragraphs", "ch001.json"), JSON.stringify({
      revision: 1,
      chapterId: "ch001",
      paragraphs: [
        { id: "p0001", type: "text", source: "第1章 测试", translation: "第1章 测试" },
        { id: "p0002", type: "text", source: "这是第一段。", translation: "这是第一段。" },
        { id: "p0003", type: "text", source: "这是第二段。", translation: "她朝ヒヤマ小姐喊了一声，可是没有任何回应传来。" },
      ],
    }), "utf8");
    await mkdir(join(root, "translations"), { recursive: true });
    await writeFile(join(root, "translations", "ch001_zh.md"), "第1章 测试\n\n这是第一段。\n\n她朝ヒヤマ小姐喊了一声，可是没有任何回应传来。\n", "utf8");

    const reviewed = await service.invoke(envelope("review.run", { workspaceId, chapterId: "ch001" }));
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.checksRun).toEqual(expect.arrayContaining(["kana_leftover", "dialogue_format", "untranslated"]));
    const kana = reviewed.value.issues.find((i) => i.type === "kana_leftover");
    expect(kana?.paragraphId).toBe("p0003");
  });

  it("RV-01 完全没有译文时返回 noTranslation，且不落一份「0 个问题」的报告", async () => {
    const service = serviceWith({});
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);

    const reviewed = await service.invoke(envelope("review.run", { workspaceId, chapterId: "ch001" }));
    expect(reviewed).toMatchObject({ ok: true, value: { noTranslation: true, issueCount: 0, issues: [] } });
    expect(existsSync(join(root, "reviews", "ch001.current.json"))).toBe(false);
  });

  it("exports a chapter to markdown through the engine", async () => {
    const fakeLlm = { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, '这是翻译结果。') }) };
    const service = serviceWith({ llm: fakeLlm });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    const exported = await service.invoke(envelope("export.run", { workspaceId, target: "ch001", format: "md" }));
    expect(exported).toMatchObject({ ok: true, value: { status: "queued" } });
    const output = await readFile(join(root, "output", "input.txt_ch001.md"), "utf8");
    expect(output).toContain("这是翻译结果");
  });

  it("chapter.create 新建章节（自动建卷 + manifest + workflow）", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-create-"));
    roots.push(root);
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "Create" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceId = created.value.id;
    // 目标卷不存在 → 自动建卷
    const chapter = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v09", title: "新卷新章" }));
    expect(chapter).toMatchObject({ ok: true, value: { status: "created", volumeId: "v09", title: "新卷新章" } });
    if (!chapter.ok) return;
    const chapterId = chapter.value.chapterId;
    expect(await readFile(join(root, "source", "v09", `${chapterId}.md`), "utf8")).toContain("# 新卷新章");
    const manifest = JSON.parse(await readFile(join(root, "source", "manifest.json"), "utf8"));
    expect(manifest.chapters).toContainEqual(expect.objectContaining({ id: chapterId, volume: "v09" }));
    expect((await new ChapterStateStore(root).readChapter(chapterId)).state).toBe("imported");
    // 刷新后卷树含 v09
    const listed = await service.invoke(envelope("workspace.list", {}));
    expect(listed.ok && listed.value.find((ws) => ws.id === workspaceId)?.volumes.some((vol) => vol.id === "v09")).toBe(true);
  });

  it("chapter.delete → trash → chapter.restore 原位置放回", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-del-"));
    roots.push(root);
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "Del" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceId = created.value.id;
    const a = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "章A" }));
    const b = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "章B" }));
    if (!a.ok || !b.ok) return;
    const aId = a.value.chapterId, bId = b.value.chapterId;
    // 删除章A
    const deleted = await service.invoke(envelope("chapter.delete", { workspaceId, volumeId: "v01", chapterId: aId }));
    expect(deleted).toMatchObject({ ok: true, value: { status: "deleted", trashId: expect.any(String) } });
    if (!deleted.ok) return;
    // 源文件已移除 + manifest 无此章
    await expect(readFile(join(root, "source", "v01", `${aId}.md`), "utf8")).rejects.toThrow();
    let manifest = JSON.parse(await readFile(join(root, "source", "manifest.json"), "utf8"));
    expect(manifest.chapters.map((c: { id: string }) => c.id)).not.toContain(aId);
    // trash 目录存在
    const trashIndex = JSON.parse(await readFile(join(root, "state", "trash", "trash-index.json"), "utf8"));
    expect(trashIndex.entries).toHaveLength(1);
    // 恢复
    const restored = await service.invoke(envelope("chapter.restore", { workspaceId, trashId: deleted.value.trashId }));
    expect(restored).toMatchObject({ ok: true, value: { status: "restored", chapterId: aId } });
    manifest = JSON.parse(await readFile(join(root, "source", "manifest.json"), "utf8"));
    const order = manifest.chapters.map((c: { id: string }) => c.id);
    expect(order).toEqual([aId, bId]); // 原位置放回
    expect(await readFile(join(root, "source", "v01", `${aId}.md`), "utf8")).toContain("# 章A");
    const trashIndexAfter = JSON.parse(await readFile(join(root, "state", "trash", "trash-index.json"), "utf8"));
    expect(trashIndexAfter.entries).toHaveLength(0);
  });

  it("workspace.open 在 fsck 前恢复崩溃遗留的 prepared 文件事务", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-fstx-recover-"));
    roots.push(root);
    const registryPath = join(root, "registry.json");
    const service = createIpcService({ registryPath });
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "Recover" }));
    if (!created.ok) return;
    const chapter = await service.invoke(envelope("chapter.create", { workspaceId: created.value.id, volumeId: "v01", title: "One" }));
    if (!chapter.ok) return;
    const manifestPath = join(root, "source", "manifest.json");
    const before = await readFile(manifestPath, "utf8");
    const txDir = join(root, "state", "fs-transactions", "fstx-crash");
    await mkdir(txDir, { recursive: true });
    await writeFile(join(txDir, "0.bin"), before);
    await writeFile(join(txDir, "journal.json"), JSON.stringify({ version: 1, id: "fstx-crash", phase: "prepared", entries: [{ path: join("source", "manifest.json"), kind: "file", data: "0.bin" }] }));
    await writeFile(manifestPath, JSON.stringify({ book: "Recover", chapters: [] }));
    const restarted = createIpcService({ registryPath });
    const listed = await restarted.invoke(envelope("workspace.list", {}));
    expect(listed).toMatchObject({ ok: true, value: [expect.objectContaining({ id: created.value.id, status: "ready" })] });
    const opened = await restarted.invoke(envelope("workspace.open", { path: root }));
    expect(opened).toMatchObject({ ok: true, value: { status: "ready" } });
    expect(JSON.parse(await readFile(manifestPath, "utf8")).chapters).toEqual(expect.arrayContaining([expect.objectContaining({ id: chapter.value.chapterId })]));
    await expect(readFile(join(txDir, "journal.json"), "utf8")).rejects.toThrow();
  });

  it("chapter.restore 冲突时不覆盖现有章节文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-restore-conflict-"));
    roots.push(root);
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "Conflict" }));
    if (!created.ok) return;
    const workspaceId = created.value.id;
    const chapter = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "Old" }));
    if (!chapter.ok) return;
    const deleted = await service.invoke(envelope("chapter.delete", { workspaceId, volumeId: "v01", chapterId: chapter.value.chapterId }));
    if (!deleted.ok) return;
    const manifestPath = join(root, "source", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.chapters.push({ id: chapter.value.chapterId, title: "New", volume: "v01", marker: "preserve" });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const sourcePath = join(root, "source", "v01", `${chapter.value.chapterId}.md`);
    await writeFile(sourcePath, "new live source");
    const restored = await service.invoke(envelope("chapter.restore", { workspaceId, trashId: deleted.value.trashId }));
    expect(restored).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await readFile(sourcePath, "utf8")).toBe("new live source");
  });

  it("chapter.move 同卷排序 + 跨卷移动", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-move-"));
    roots.push(root);
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "Move" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceId = created.value.id;
    const a = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "章A" }));
    const b = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "章B" }));
    const c = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "章C" }));
    if (!a.ok || !b.ok || !c.ok) return;
    const aId = a.value.chapterId, bId = b.value.chapterId, cId = c.value.chapterId;
    // 同卷排序：C 移到 A 之后 → [A, C, B]
    const moved = await service.invoke(envelope("chapter.move", { workspaceId, chapterId: cId, targetVolumeId: "v01", afterChapterId: aId }));
    expect(moved.ok).toBe(true);
    let manifest = JSON.parse(await readFile(join(root, "source", "manifest.json"), "utf8"));
    expect(manifest.chapters.map((x: { id: string }) => x.id)).toEqual([aId, cId, bId]);
    // 跨卷移动：A 移到新卷 v02
    const cross = await service.invoke(envelope("chapter.move", { workspaceId, chapterId: aId, targetVolumeId: "v02" }));
    expect(cross.ok).toBe(true);
    manifest = JSON.parse(await readFile(join(root, "source", "manifest.json"), "utf8"));
    expect(manifest.chapters.find((x: { id: string }) => x.id === aId)?.volume).toBe("v02");
    // 源文件移动
    expect(await readFile(join(root, "source", "v02", `${aId}.md`), "utf8")).toContain("# 章A");
  });

  it("chapter.move 拒绝不存在或跨卷 anchor，且不改变 manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-move-anchor-"));
    roots.push(root);
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "Move" }));
    if (!created.ok) return;
    const workspaceId = created.value.id;
    const a = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "A" }));
    const b = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "B" }));
    if (!a.ok || !b.ok) return;
    const before = await readFile(join(root, "source", "manifest.json"), "utf8");
    const missing = await service.invoke(envelope("chapter.move", { workspaceId, chapterId: b.value.chapterId, targetVolumeId: "v01", afterChapterId: "ch999", atStart: false }));
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await readFile(join(root, "source", "manifest.json"), "utf8")).toBe(before);
  });

  it("chapter.move atStart 移到卷首", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-move-start-"));
    roots.push(root);
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "MoveStart" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceId = created.value.id;
    const a = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "章A" }));
    const b = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "章B" }));
    const c = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "章C" }));
    if (!a.ok || !b.ok || !c.ok) return;
    const aId = a.value.chapterId, bId = b.value.chapterId, cId = c.value.chapterId;
    // 当前 [A,B,C]；把 C 移到卷首 → [C,A,B]
    const moved = await service.invoke(envelope("chapter.move", { workspaceId, chapterId: cId, targetVolumeId: "v01", atStart: true }));
    expect(moved.ok).toBe(true);
    const manifest = JSON.parse(await readFile(join(root, "source", "manifest.json"), "utf8"));
    expect(manifest.chapters.map((x: { id: string }) => x.id)).toEqual([cId, aId, bId]);
  });

  it("volume.delete → volume.restore 整卷软删除与恢复", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-vol-"));
    roots.push(root);
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "Vol" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceId = created.value.id;
    const a = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "卷章A" }));
    const b = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "卷章B" }));
    if (!a.ok || !b.ok) return;
    const aId = a.value.chapterId, bId = b.value.chapterId;
    const stateStore = new ChapterStateStore(root);
    await stateStore.transition(aId, "ready", { reason: "round-trip" });
    await stateStore.transition(aId, "translating", { reason: "round-trip" });
    const beforeState = await stateStore.readChapter(aId);
    const beforeManifest = JSON.parse(await readFile(join(root, "source", "manifest.json"), "utf8"));
    const deleted = await service.invoke(envelope("volume.delete", { workspaceId, volumeId: "v01" }));
    expect(deleted).toMatchObject({ ok: true, value: { status: "deleted", chapterCount: 2 } });
    if (!deleted.ok) return;
    // 卷目录消失
    await expect(readFile(join(root, "source", "v01", `${aId}.md`), "utf8")).rejects.toThrow();
    // 恢复
    const restored = await service.invoke(envelope("volume.restore", { workspaceId, trashId: deleted.value.trashId }));
    expect(restored).toMatchObject({ ok: true, value: { status: "restored", chapterCount: 2 } });
    expect(await readFile(join(root, "source", "v01", `${aId}.md`), "utf8")).toContain("# 卷章A");
    const manifest = JSON.parse(await readFile(join(root, "source", "manifest.json"), "utf8"));
    expect(manifest.chapters).toEqual(beforeManifest.chapters);
    expect(await stateStore.readChapter(aId)).toEqual(beforeState);
  });

  it("marks a historical workspace with duplicate chapter ids invalid instead of guessing an owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-duplicate-chapter-"));
    roots.push(root);
    const registryPath = join(root, "registry.json");
    const workspaceRoot = join(root, "workspace");
    await mkdir(join(workspaceRoot, "source", "v01"), { recursive: true });
    await mkdir(join(workspaceRoot, "source", "v02"), { recursive: true });
    await writeFile(join(workspaceRoot, "book.yaml"), "name: Duplicate\nvolumes:\n  - id: v01\n    label: One\n  - id: v02\n    label: Two\n");
    await writeFile(join(workspaceRoot, "source", "manifest.json"), JSON.stringify({ chapters: [
      { id: "ch001", title: "A", volume: "v01" },
      { id: "ch001", title: "B", volume: "v02" },
    ] }));
    await writeFile(registryPath, JSON.stringify({ workspaces: [{ id: "ws-duplicate", path: workspaceRoot, name: "Duplicate", srcLang: "ja", tgtLang: "zh", openedAt: 1 }] }));
    const service = createIpcService({ registryPath });
    const listed = await service.invoke(envelope("workspace.list", {}));
    expect(listed).toMatchObject({ ok: true, value: [{ status: "invalid" }] });
    if (listed.ok) expect(listed.value[0]?.error).toContain("重复章节 ID ch001");
  });

  it("import.text target.volume=new 强制新建卷", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-imp-"));
    roots.push(root);
    const service = serviceWith();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "Imp" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceId = created.value.id;
    // 先默认导入 → v01
    const first = await service.invoke(envelope("import.text", { workspaceId, text: "第1章 X\n\n内容。\n" }));
    expect(first.ok).toBe(true);
    // target.volume=new → 强制新建 v02
    const imported = await service.invoke(envelope("import.text", { workspaceId, text: "第1章 Y\n\n内容。\n", target: { volume: "new" } }));
    expect(imported.ok).toBe(true);
    const listed = await service.invoke(envelope("workspace.list", {}));
    const ws = listed.ok ? listed.value.find((x) => x.id === workspaceId) : null;
    const ids = ws?.volumes.map((vol) => vol.id) ?? [];
    expect(ids).toContain("v02");
    expect(ids.filter((id) => id === "v01")).toHaveLength(1);
  });

  it("过期 trash 启动时清理（7 天）", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-trash-"));
    roots.push(root);
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "Trash" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceId = created.value.id;
    const a = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "旧章" }));
    if (!a.ok) return;
    const deleted = await service.invoke(envelope("chapter.delete", { workspaceId, volumeId: "v01", chapterId: a.value.chapterId }));
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    // 手动把 deletedAt 改为超期
    const indexPath = join(root, "state", "trash", "trash-index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.entries[0]!.deletedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await writeFile(indexPath, JSON.stringify(index), "utf8");
    // 关闭再打开 → 清理
    await service.invoke(envelope("workspace.close", { workspaceId }));
    const reopened = await service.invoke(envelope("workspace.open", { path: root }));
    expect(reopened.ok).toBe(true);
    const indexAfter = JSON.parse(await readFile(indexPath, "utf8"));
    expect(indexAfter.entries).toHaveLength(0);
  });

  it("RV-06/07：翻译 → 主动通读 → 导出全程无门禁，作者改稿只留提示", async () => {
    const service = serviceWith({ llm: { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, "这是翻译结果。") }) } });
    const bookReviewEvents: Array<{ payload: { workspaceId: string; status: string } }> = [];
    service.subscribe((event) => {
      if (event.type === "bookReview.changed") bookReviewEvents.push(event as typeof bookReviewEvents[number]);
    });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);

    const none = await service.invoke(envelope("bookReview.status", { workspaceId }));
    expect(none).toMatchObject({ ok: true, value: { status: "none" } });

    // RV-06：通读是作者主动问的一句意见，不再要求全书完工

    const t1 = await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    expect(t1).toMatchObject({ ok: true, value: { workflowStatus: "approved" } });
    const t2 = await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch002" }));
    expect(t2).toMatchObject({ ok: true, value: { workflowStatus: "approved" } });

    const review = await service.invoke(envelope("bookReview.run", { workspaceId }));
    expect(review).toMatchObject({ ok: true, value: { status: "advisory" } });

    const exported = await service.invoke(envelope("export.run", { workspaceId, target: "all", format: "md" }));
    expect(exported).toMatchObject({ ok: true, value: { exported: ["ch001", "ch002"], skipped: [] } });

    // 作者修改译文 → 非阻塞提示（authorEditedSinceReview），不 stale、不阻止导出（作者自由）
    const loaded = await service.invoke(envelope("chapter.load", { workspaceId, chapterId: "ch001" }));
    if (!loaded.ok) throw new Error("load failed");
    await service.invoke(envelope("chapter.saveDraft", {
      workspaceId,
      chapterId: "ch001",
      baseRevision: loaded.value.revision,
      paragraphs: loaded.value.paragraphs.map((p) => ({ ...p, translation: "手动改" })),
    }));
    const after = await service.invoke(envelope("bookReview.status", { workspaceId }));
    expect(after).toMatchObject({ ok: true, value: { status: "advisory", authorEditedSinceReview: true } });
    expect(bookReviewEvents.some((event) => event.payload.workspaceId === workspaceId && event.payload.status === "advisory")).toBe(true);
    const exportAfter = await service.invoke(envelope("export.run", { workspaceId, target: "all", format: "md" }));
    expect(exportAfter).toMatchObject({ ok: true });
  });

  it("RV-06 取代 RH-06/BQ-06 的两级批准：全书审校只留建议，没有需要接受的否决", async () => {
    // 旧行为：needs-repair 状态下 accept 需 confirmHigh，接受后才放行整书导出。
    // 新行为：状态里没有 needs-repair，没有 accept，导出也不看它一眼。
    const service = serviceWith({ llm: { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, "译") }) } });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch002" }));

    const run = await service.invoke(envelope("bookReview.run", { workspaceId }));
    expect(run).toMatchObject({ ok: true, value: { status: "advisory" } });
    // 报告里有 high 也一样：建议不构成否决，整书导出照常
    expect(await service.invoke(envelope("export.run", { workspaceId, target: "all", format: "md" }))).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(join(root, "state", "book-review.json"), "utf8"))).toMatchObject({ status: "advisory" });
  });

  it("全书 AI 审校只看有译文的章节：没译的排除出范围，不是事后才说一句跳过", async () => {
    // 从前不传 scope，engine 按全书目录跑，把译文为空串的章节也送进模型——
    // 花了钱、回一堆「整段未译」的废建议，而状态里却写着这些章被跳过了。
    const seen: Array<string[] | undefined> = [];
    const service = serviceWith({
      llm: { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, "译") }) },
      engine: {
        ...engineWiring,
        runBookReview: async (_ws: { root: string }, options: { scope?: string[] }) => {
          seen.push(options.scope);
          return {
            runId: "run-scope",
            report: { reportId: "bookrev_scope", summary: { high: 0, medium: 0, low: 0 }, issues: [], scope: options.scope ?? [] },
            reportPath: "reviews/book/run-scope/report.json",
          };
        },
      } as EngineWiring,
    });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    // 只翻 ch001，ch002 留着没译
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));

    const run = await service.invoke(envelope("bookReview.run", { workspaceId }));
    expect(run).toMatchObject({ ok: true, value: { status: "advisory" } });
    expect(seen).toEqual([["ch001"]]);
    // 跳过的章节仍要如实说明——排除范围不等于闷声少看
    expect(JSON.parse(await readFile(join(root, "state", "book-review.json"), "utf8"))).toMatchObject({ skippedChapters: ["ch002"] });
  });

  it("BQ-P1：源文修正——cosmetic 不触发重译/不失效；semantic 标记需重新翻译并失效", async () => {
    const service = serviceWith({ llm: { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, "译") }) } });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch002" }));
    const review = await service.invoke(envelope("bookReview.run", { workspaceId }));
    expect(review).toMatchObject({ ok: true, value: { status: "advisory" } });

    const original = await (async () => {
      for (const p of [join(root, "source", "ch001.md"), join(root, "source", "v01", "ch001.md")]) {
        try { return await readFile(p, "utf8"); } catch { /* next */ }
      }
      throw new Error("source not found");
    })();

    // cosmetic：仅标点/空白变化 → 不触发重译、不失效
    const cosmetic = original.replace(/。/g, "！");
    const c1 = await service.invoke(envelope("chapter.saveSourceCorrection", { workspaceId, chapterId: "ch001", baseRevision: 0, source: cosmetic }));
    expect(c1).toMatchObject({ ok: true, value: { changeClass: "cosmetic", requiresRetranslation: false } });
    const st1 = await service.invoke(envelope("bookReview.status", { workspaceId }));
    expect(st1).toMatchObject({ ok: true, value: { status: "advisory", staleReason: undefined } });
    const run1 = await service.invoke(envelope("bookReview.run", { workspaceId }));
    expect(run1).toMatchObject({ ok: true, value: { status: "advisory" } });

    // semantic：正文/结构变化 → 需重新翻译，且现有建议基于旧底稿。
    // RV-06/07：这条信息以注记形式给出，不再阻止通读、也不再阻止导出——
    // 作者知道底稿变了之后要不要重跑、要不要现在就导，是作者的判断。
    const semantic = original + "\n\n新しい段落が追加されました。";
    const c2 = await service.invoke(envelope("chapter.saveSourceCorrection", { workspaceId, chapterId: "ch001", baseRevision: 1, source: semantic }));
    expect(c2).toMatchObject({ ok: true, value: { changeClass: "semantic", requiresRetranslation: true } });
    const st2 = await service.invoke(envelope("bookReview.status", { workspaceId }));
    expect(st2.ok).toBe(true);
    if (!st2.ok) return;
    expect(st2.value.status).toBe("advisory");
    expect(st2.value.staleReason).toBeTruthy();
    expect(await service.invoke(envelope("bookReview.run", { workspaceId }))).toMatchObject({ ok: true });
    expect(await service.invoke(envelope("export.run", { workspaceId, target: "all", format: "md" }))).toMatchObject({ ok: true });
  });

  /**
   * 新建章节只写下一行 `# 标题`，没有作者原文。此时在「保存原文」里粘进正文，
   * 从前只写 `state/source-corrections/<id>.json`——而 `chapter.load` 是从
   * `source/<vol>/<id>.md` 建段落的，**没有任何引擎代码读 source-corrections**。
   * 于是界面报「原文已保存」，回到正文却还是「无原文」：保存这件事字面为真，
   * 存下来的东西却没有一个读者。
   */
  it("首次为空章节保存原文时，正文必须能读到它", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-"));
    roots.push(root);
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "空章节书" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceId = created.value.id;

    const chapter = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "第一章" }));
    expect(chapter).toMatchObject({ ok: true, value: { chapterId: "ch001" } });

    const authored = "「……なにやってるんだ」\n\n少年は窓の外を見た。";
    const saved = await service.invoke(envelope("chapter.saveSourceCorrection", { workspaceId, chapterId: "ch001", baseRevision: 0, source: authored }));
    expect(saved).toMatchObject({ ok: true });

    const loaded = await service.invoke(envelope("chapter.load", { workspaceId, chapterId: "ch001" }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // 判据与正文面板的 hasAuthorVisibleSource 同义：标题行不算原文
    const sources = loaded.value.paragraphs.map((paragraph) => paragraph.source);
    expect(sources.some((source) => source.includes("なにやってるんだ"))).toBe(true);
    expect(sources.some((source) => source.includes("窓の外"))).toBe(true);
  });

  it("keeps full-book review behind an explicit bookReview.run command", async () => {
    let bookReviewCalls = 0;
    const explicitReviewEngine: EngineWiring = {
      ...engineWiring,
      runBookReview: async (...args) => {
        bookReviewCalls += 1;
        return engineWiring.runBookReview!(...args);
      },
    };
    const service = serviceWith({ engine: explicitReviewEngine, llm: { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, "译") }) } });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    expect(await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }))).toMatchObject({ ok: true, value: { workflowStatus: "approved" } });
    expect(await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch002" }))).toMatchObject({ ok: true, value: { workflowStatus: "approved" } });
    expect(bookReviewCalls).toBe(0);
    expect(await service.invoke(envelope("bookReview.status", { workspaceId }))).toMatchObject({ ok: true, value: { status: "none" } });
    expect(await service.invoke(envelope("bookReview.run", { workspaceId }))).toMatchObject({ ok: true, value: { status: "advisory" } });
    expect(bookReviewCalls).toBe(1);
  });

  // RV-06：原 P2-1「显式全文审校 high 修订不会重入章节队列死锁」已删除——
  // 那道死锁的来源是全书审校自动逐章重译，该能力本身已退役，没有可重入的队列了。
  // 取而代之的是下面「全书审校不再自动重译任何章节」的正向断言。

  it("RV-06 全书审校是建议：不要求全部完成也能跑，且明细逐条送到界面", async () => {
    const detailed: EngineWiring = {
      ...engineWiring,
      runBookReview: async () => ({
        runId: "book-advice",
        report: {
          reportId: "book-advice",
          summary: { high: 1, medium: 0, low: 0 },
          issues: [{
            chapterIds: ["ch002"], type: "tone", severity: "high",
            found: "语气偏硬", expected: "与前文一致的轻松口吻",
            repairInstruction: "把 ch002 的旁白语气调回与 ch001 一致",
            evidenceRefs: [{ source: "ch002_zh.md", context: "示例上下文" }],
          }],
          scope: ["ch001", "ch002"],
        },
        reportPath: "reviews/book/book-advice/report.json",
      }),
    };
    const service = serviceWith({ engine: detailed, llm: { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, "译") }) } });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    // 只翻译第一章：第二章还没译完 —— 作者依然可以主动问一句意见
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));

    const run = await service.invoke(envelope("bookReview.run", { workspaceId }));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.status).toBe("advisory");
    expect(run.value.issues?.[0]).toMatchObject({
      chapterIds: ["ch002"],
      found: "语气偏硬",
      expected: "与前文一致的轻松口吻",
      repairInstruction: "把 ch002 的旁白语气调回与 ch001 一致",
    });
    expect(run.value.issues?.[0]!.evidenceRefs?.[0]).toMatchObject({ source: "ch002_zh.md" });
  });

  it("RV-06 全书审校不再自动重译任何章节", async () => {
    let bookRuns = 0;
    const alwaysHigh: EngineWiring = {
      ...engineWiring,
      runBookReview: async () => {
        bookRuns += 1;
        return {
          runId: `book-${bookRuns}`,
          report: {
            reportId: `book-${bookRuns}`,
            summary: { high: 1, medium: 0, low: 0 },
            issues: [{ chapterIds: ["ch002"], type: "accuracy", severity: "high" }],
            scope: ["ch001", "ch002"],
          },
          reportPath: `reviews/book/book-${bookRuns}/report.json`,
        };
      },
    };
    let translateCalls = 0;
    const service = serviceWith({
      engine: alwaysHigh,
      llm: {
        complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => {
          if (messages.some((msg) => msg.content.includes("<paragraph"))) translateCalls += 1;
          return { text: xmlFrom(messages, "译") };
        },
      },
    });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch002" }));
    const before = translateCalls;

    await service.invoke(envelope("bookReview.run", { workspaceId }));
    expect(bookRuns).toBe(1);          // 跑一次，不是「发现 high → 重译 → 再跑」的循环
    expect(translateCalls).toBe(before); // 一个字都没被机器改写
  });

  it("RV-06 「接受为全书通过」已退役：bookReview.decide 不再是合法命令", async () => {
    const service = serviceWith();
    const { workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    const decided = await service.invoke(envelope("bookReview.decide", { workspaceId, action: "accept" }));
    // 命令本身已从契约里移除 → 未知命令（不是「当前状态不允许」那种业务拒绝）
    expect(decided).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("P2-2：running 残留（上次中断）→ status 返回 blocked 提示", async () => {
    const service = serviceWith();
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await writeFile(join(root, "state", "book-review.json"), JSON.stringify({ status: "running", updatedAt: Date.now() - 2 * 60 * 60 * 1000 }));
    // RV-06：中断没有留下报告，回到「没跑过」并附一句原因，比一个特殊状态诚实
    const st = await service.invoke(envelope("bookReview.status", { workspaceId }));
    expect(st).toMatchObject({ ok: true, value: { status: "none", lastError: expect.stringContaining("中断") } });
  });

  it("E5：翻译指南变更 → 现有建议标记为基于旧底稿", async () => {
    const service = serviceWith();
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    const read = await service.invoke(envelope("settings.read", { workspaceId }));
    if (!read.ok) throw new Error("settings.read failed");
    const written = await service.invoke(envelope("settings.write", { workspaceId, key: "translation.guide", value: "新指南", baseRevision: read.value.revision }));
    expect(written).toMatchObject({ ok: true });
    await writeFile(join(root, "state", "book-review.json"), JSON.stringify({ status: "advisory", reviewedAt: Date.now(), updatedAt: Date.now() }));
    const baseRev = written.ok ? written.value.revision : 0;
    const again = await service.invoke(envelope("settings.write", { workspaceId, key: "translation.guide", value: "新指南2", baseRevision: baseRev }));
    expect(again).toMatchObject({ ok: true });
    const st = await service.invoke(envelope("bookReview.status", { workspaceId }));
    // RV-06：建议还在、还能看，只是附一句「基于旧底稿」——它不再是会被作废的门禁
    expect(st).toMatchObject({ ok: true, value: { status: "advisory", staleReason: expect.stringContaining("翻译指南") } });
  });

  // ===== RH-16 长任务取消（A-3）=====
  /** 可控的挂起 LLM：第一次调用挂住直到 signal abort，之后恢复正常翻译 */
  function hangingLlm() {
    let hangs = true;
    let entered: (() => void) | null = null;
    const firstCall = new Promise<void>((resolve) => { entered = resolve; });
    return {
      firstCall,
      release: () => { hangs = false; },
      llm: {
        complete: async (_m: string, messages: Array<{ role: string; content: string }>, opts?: { thinking?: string; signal?: AbortSignal }) => {
          if (!hangs) return { text: xmlFrom(messages, "取消后重译的译文。") };
          entered?.();
          entered = null;
          await new Promise<void>((_resolve, reject) => {
            if (opts?.signal?.aborted) { reject(new Error("aborted")); return; }
            opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          return { text: "" };
        },
      },
    };
  }

  it("RH-16：翻译可取消，取消后状态回 ready 且能立即重新翻译", async () => {
    const controllable = hangingLlm();
    const service = serviceWith({ llm: controllable.llm });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);

    const running = service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    await controllable.firstCall;
    const cancelled = await service.invoke(envelope("translate.cancel", { workspaceId, chapterId: "ch001" }));
    expect(cancelled).toMatchObject({ ok: true, value: { status: "cancelling" } });

    const outcome = await running;
    expect(outcome).toMatchObject({ ok: false, error: { code: "conflict", details: { cancelled: true } } });

    // 状态干净：回到 ready（管线自身的失败处理已经把它带回 ready，settleCancelledChapter 是兜底）
    const afterCancel = await service.invoke(envelope("chapter.load", { workspaceId, chapterId: "ch001" }));
    expect(afterCancel).toMatchObject({ ok: true, value: { workflow: { state: "ready" } } });

    // 无进行中任务 → idle
    expect(await service.invoke(envelope("translate.cancel", { workspaceId, chapterId: "ch001" }))).toMatchObject({ ok: true, value: { status: "idle" } });

    // 立即重新发起：走完整闭环
    controllable.release();
    const retried = await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    expect(retried).toMatchObject({ ok: true, value: { workflowStatus: "approved" } });
    expect(await readFile(join(root, "translations", "ch001_zh.md"), "utf8")).toContain("取消后重译的译文");
  });

  it("RH-16：全文审校可取消，状态回「没跑过」而不是留下一个失败态", async () => {
    const controllable = hangingLlm();
    const service = serviceWith({
      llm: controllable.llm,
      engine: { ...engineWiring, runBookReview: async (_ws: unknown, options: { llm: { complete: (system: string, user: string) => Promise<string> } }) => {
        await options.llm.complete("汇总", "user");
        return { runId: "run-1", report: { reportId: "r", summary: { high: 0, medium: 0, low: 0 }, issues: [], scope: [] }, reportPath: "reviews/book/run-1/report.json" };
      } } as unknown as EngineWiring,
    });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    controllable.release();
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch002" }));

    // 让全文审校的 LLM 调用挂住
    const hang = hangingLlm();
    const cancellableService = serviceWith({
      llm: hang.llm,
      engine: { ...engineWiring, runBookReview: async (_ws: unknown, options: { llm: { complete: (system: string, user: string) => Promise<string> } }) => {
        await options.llm.complete("汇总", "user");
        return { runId: "run-1", report: { reportId: "r", summary: { high: 0, medium: 0, low: 0 }, issues: [], scope: [] }, reportPath: "reviews/book/run-1/report.json" };
      } } as unknown as EngineWiring,
    });
    const opened = await cancellableService.invoke(envelope("workspace.open", { path: root }));
    expect(opened).toMatchObject({ ok: true });

    const running = cancellableService.invoke(envelope("bookReview.run", { workspaceId }));
    await hang.firstCall;
    expect(await cancellableService.invoke(envelope("bookReview.cancel", { workspaceId }))).toMatchObject({ ok: true, value: { status: "cancelling" } });
    expect(await running).toMatchObject({ ok: false, error: { code: "conflict", details: { cancelled: true } } });

    const state = JSON.parse(await readFile(join(root, "state", "book-review.json"), "utf8"));
    // 取消没有留下报告，也不是错误：状态回 none，且不留 lastError
    expect(state.status).toBe("none");
    expect(state.lastError).toBeUndefined();
    expect(await cancellableService.invoke(envelope("bookReview.cancel", { workspaceId }))).toMatchObject({ ok: true, value: { status: "idle" } });
  });

  // ===== RS-1 范围跑批（translate.runScope / D6-D9、D13）=====

  /** アリス/ボブ 逐字在原文里（KA-5 幻觉过滤要求），两章共享同一批登记词 */
  const SCOPE_TXT = "第1章 术语\n\nアリス和ボブ都在这里。\n\n第2章 继续\n\nアリス看向ボブ。\n";

  /**
   * 可控栅栏 LLM：所有调用先等 release，abort 到达则立刻拒绝。
   * 与 hangingLlm 的差别：这里要**不经取消**放行（章边界停的测试需要章正常翻完）。
   */
  function gatedLlm() {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    let enter: (() => void) | null = null;
    const firstCall = new Promise<void>((resolveFirst) => { enter = resolveFirst; });
    return {
      firstCall,
      release,
      llm: {
        complete: async (model: string, messages: Array<{ role: string; content: string }>, opts?: { thinking?: string; signal?: AbortSignal }) => {
          enter?.();
          enter = null;
          await Promise.race([gate, new Promise<never>((_resolve, reject) => {
            if (opts?.signal?.aborted) { reject(new Error("aborted")); return; }
            opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          })]);
          return TERMINOLOGY_LLM.complete(model, messages);
        },
      },
    };
  }

  function collectScopeEvents(service: ReturnType<typeof createIpcService>) {
    const events: Array<{ phase: string; index?: number; chapterId?: string; reason?: string; total?: number; stop?: string }> = [];
    service.subscribe((event) => {
      if (event.type === "translate.scopeChanged") events.push(event.payload as typeof events[number]);
    });
    return events;
  }

  it("RS-1：意图清单串行跑批——事件流、结算单、多章结束通知与点击回执", async () => {
    const notices: Array<{ title: string; body: string; onClick?: () => void }> = [];
    const service = createIpcService({ engine: engineWiring, llm: TERMINOLOGY_LLM, notify: (notice) => notices.push(notice) });
    services.push(service);
    const { workspaceId } = await createImportedWorkspace(service, SCOPE_TXT);
    const events = collectScopeEvents(service);

    const result = await service.invoke(envelope("translate.runScope", { workspaceId, chapters: [{ chapterId: "ch001" }, { chapterId: "ch002" }] }));

    expect(result).toMatchObject({ ok: true, value: {
      total: 2, approved: ["ch001", "ch002"], needsReview: [], stuck: [], skipped: [], failed: [], remaining: [],
      stopped: "none",
      // 待终审 = 档案暂定 アリス（provenance=model）+ 双关卡 ボブ/都在（两来源一队列）
      pendingTerms: 3,
    } });
    expect(events.map((event) => event.phase)).toEqual([
      "started", "chapter-started", "chapter-done", "chapter-started", "chapter-done", "finished",
    ]);
    expect(events[1]).toMatchObject({ phase: "chapter-started", index: 1, chapterId: "ch001", total: 2 });
    expect(events[3]).toMatchObject({ phase: "chapter-started", index: 2, chapterId: "ch002" });
    // D13：多章 → 系统通知，三个数
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain("完成 2");
    expect(notices[0]!.body).toContain("待审术语 3");
    // 点击通知 → notification-clicked 回执（RS-2 据此落 Agent 控制台）
    notices[0]!.onClick?.();
    expect(events.at(-1)).toMatchObject({ phase: "notification-clicked" });
    // 跑批已结束 → stopScope idle
    expect(await service.invoke(envelope("translate.stopScope", { workspaceId }))).toMatchObject({ ok: true, value: { status: "idle" } });
  });

  it("RS-1 / D6：清单是意图不是命令——开工前复核，已完成的章跳过并在事件流出声", async () => {
    const service = serviceWith({ llm: TERMINOLOGY_LLM });
    const { workspaceId } = await createImportedWorkspace(service, SCOPE_TXT);
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
    const events = collectScopeEvents(service);

    const result = await service.invoke(envelope("translate.runScope", { workspaceId, chapters: [{ chapterId: "ch001" }, { chapterId: "ch002" }] }));

    expect(result).toMatchObject({ ok: true, value: {
      approved: ["ch002"],
      skipped: [{ chapterId: "ch001", reason: expect.stringContaining("已在本次工作之外完成") }],
    } });
    expect(events.find((event) => event.phase === "chapter-skipped")).toMatchObject({ chapterId: "ch001", reason: expect.stringContaining("已在本次工作之外完成") });
  });

  it("RS-1 / D4：retranslate=true 是作者的显式重译意图——approved 不再是跳过理由；单章不发通知", async () => {
    const notices: Array<{ title: string; body: string }> = [];
    const service = createIpcService({ engine: engineWiring, llm: TERMINOLOGY_LLM, notify: (notice) => notices.push(notice) });
    services.push(service);
    const { workspaceId } = await createImportedWorkspace(service, SCOPE_TXT);
    await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));

    const result = await service.invoke(envelope("translate.runScope", { workspaceId, chapters: [{ chapterId: "ch001", retranslate: true }] }));

    expect(result).toMatchObject({ ok: true, value: { approved: ["ch001"], skipped: [] } });
    // D13：单章的完成本来就在眼前——不打扰
    expect(notices).toHaveLength(0);
  });

  it("RS-1 / D8：一章失败不终结跑批——记入结算单，下一章继续（无人值守是存在理由）", async () => {
    const failingEngine: EngineWiring = {
      ...engineWiring,
      runChapterPipeline: (async (ws: never, chapterId: string, ...rest: never[]) => {
        if (chapterId === "ch001") throw new Error("模型抽风");
        return (runChapterPipeline as (...args: unknown[]) => unknown)(ws, chapterId, ...rest);
      }) as EngineWiring["runChapterPipeline"],
    };
    const service = serviceWith({ engine: failingEngine, llm: TERMINOLOGY_LLM });
    const { workspaceId } = await createImportedWorkspace(service, SCOPE_TXT);

    const result = await service.invoke(envelope("translate.runScope", { workspaceId, chapters: [{ chapterId: "ch001" }, { chapterId: "ch002" }] }));

    expect(result).toMatchObject({ ok: true, value: {
      approved: ["ch002"],
      failed: [{ chapterId: "ch001", reason: expect.stringContaining("模型抽风") }],
      stopped: "none",
    } });
  });

  it("RS-1 / D7 第一击：章边界停——当前章翻完落盘，后面的章不再开工；跑批期间再发跑批是 conflict", async () => {
    const controllable = gatedLlm();
    const service = serviceWith({ llm: controllable.llm });
    const { root, workspaceId } = await createImportedWorkspace(service, SCOPE_TXT);
    const events = collectScopeEvents(service);

    const running = service.invoke(envelope("translate.runScope", { workspaceId, chapters: [{ chapterId: "ch001" }, { chapterId: "ch002" }] }));
    await controllable.firstCall;
    // 一个工作区同时至多一个跑批
    expect(await service.invoke(envelope("translate.runScope", { workspaceId, chapters: [{ chapterId: "ch002" }] }))).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await service.invoke(envelope("translate.stopScope", { workspaceId }))).toMatchObject({ ok: true, value: { status: "boundary" } });
    controllable.release();

    const result = await running;
    expect(result).toMatchObject({ ok: true, value: { approved: ["ch001"], remaining: ["ch002"], stopped: "boundary" } });
    // 章边界停 = 当前章**完整**落盘
    expect(await readFile(join(root, "translations", "ch001_zh.md"), "utf8")).toContain("翻译结果");
    expect(events.find((event) => event.phase === "stop-requested")).toMatchObject({ stop: "boundary" });
  });

  it("RS-1 / D7 第二击：立即取消——当前章走单章取消路收敛回 ready，剩余章全部 remaining", async () => {
    const controllable = gatedLlm();
    const service = serviceWith({ llm: controllable.llm });
    const { workspaceId } = await createImportedWorkspace(service, SCOPE_TXT);

    const running = service.invoke(envelope("translate.runScope", { workspaceId, chapters: [{ chapterId: "ch001" }, { chapterId: "ch002" }] }));
    await controllable.firstCall;
    expect(await service.invoke(envelope("translate.stopScope", { workspaceId }))).toMatchObject({ ok: true, value: { status: "boundary" } });
    expect(await service.invoke(envelope("translate.stopScope", { workspaceId }))).toMatchObject({ ok: true, value: { status: "cancelling" } });

    const result = await running;
    expect(result).toMatchObject({ ok: true, value: { approved: [], remaining: ["ch001", "ch002"], stopped: "cancelled" } });
    // 取消不是失败：章状态收敛到 ready，可立即重新发起
    const loaded = await service.invoke(envelope("chapter.load", { workspaceId, chapterId: "ch001" }));
    expect(loaded).toMatchObject({ ok: true, value: { workflow: { state: "ready" } } });
  });

  it("RS-1：空清单被契约校验拒绝；无跑批时 stopScope 返回 idle", async () => {
    const service = serviceWith({ llm: TERMINOLOGY_LLM });
    const { workspaceId } = await createImportedWorkspace(service, SCOPE_TXT);
    expect(await service.invoke(envelope("translate.runScope", { workspaceId, chapters: [] }))).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await service.invoke(envelope("translate.stopScope", { workspaceId }))).toMatchObject({ ok: true, value: { status: "idle" } });
  });

  // ===== RH-08 生命周期与资源卫生（M-3 / M-4 / M-6）=====
  it("RH-08：临时 integrity 失败不再把已打开的工作区踢出（M-4）", async () => {
    const registryPath = join(await mkdtemp(join(tmpdir(), "lightee-registry-")), "workspaces.json");
    roots.push(join(registryPath, ".."));
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-"));
    roots.push(root);
    const service = createIpcService({ registryPath });
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "生命周期" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceId = created.value.id;
    await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "第1章" }));

    // 人为破坏 book.yaml → registryInfo 变成 invalid
    const bookYaml = join(root, "book.yaml");
    const original = await readFile(bookYaml, "utf8");
    await rm(bookYaml, { force: true });
    const broken = await service.invoke(envelope("workspace.list", {}));
    expect(broken.ok).toBe(true);
    if (broken.ok) expect(broken.value.find((item) => item.id === workspaceId)?.status).not.toBe("ready");

    // 关键断言：仍能定位到该工作区（可判定错误），而不是 not_found / Workspace not open
    const load = await service.invoke(envelope("chapter.load", { workspaceId, chapterId: "ch001" }));
    expect(load.ok || load.error.code !== "not_found").toBe(true);
    if (!load.ok) expect(load.error.message).not.toContain("Workspace not open");

    // 恢复后回到 ready
    await writeFile(bookYaml, original, "utf8");
    const healed = await service.invoke(envelope("workspace.list", {}));
    expect(healed.ok && healed.value.find((item) => item.id === workspaceId)?.status).toBe("ready");
  });

  it("RH-08：oauth 会话完成后不留定时器与会话条目（M-3）", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "lightee-config-"));
    roots.push(configDir);
    const previous = process.env.LIGHTEE_CONFIG_DIR;
    process.env.LIGHTEE_CONFIG_DIR = configDir;
    try {
      const service = createIpcService({ openExternal: async () => true });
      await service.invoke(envelope("ai.provider.upsert", { providerId: "demo", name: "Demo", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions" }));
      // 直接写 oauth 配置（契约里没有单独的 oauth 写入命令）
      const modelsPath = join(configDir, "models.json");
      const models = JSON.parse(await readFile(modelsPath, "utf8"));
      models.providers.demo.oauth = { authorizeUrl: "http://127.0.0.1:1/authorize", tokenUrl: "http://127.0.0.1:1/token", clientId: "cid" };
      await writeFile(modelsPath, JSON.stringify(models, null, 2), "utf8");

      const login = await service.invoke(envelope("ai.oauth.login", { providerId: "demo" }));
      expect(login).toMatchObject({ ok: true });
      if (!login.ok) return;
      expect(service.oauthSessionCount()).toBe(1);

      // 回调不带 code → 会话以失败收尾，但必须完整清理
      await fetch(login.value.redirectUri);
      const waited = await service.invoke(envelope("ai.oauth.wait", { providerId: "demo" }));
      expect(waited).toMatchObject({ ok: true, value: { ok: false } });
      expect(service.oauthSessionCount()).toBe(0);
      // 会话已删除 → 再 wait 返回 not_found 而不是永久挂起
      expect(await service.invoke(envelope("ai.oauth.wait", { providerId: "demo" }))).toMatchObject({ ok: false, error: { code: "not_found" } });
    } finally {
      if (previous === undefined) delete process.env.LIGHTEE_CONFIG_DIR;
      else process.env.LIGHTEE_CONFIG_DIR = previous;
    }
  });

  it("预置对账：撤下的服务商与停用模型清掉，但配过密钥的与用户自建的一律不动", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "lightee-config-"));
    roots.push(configDir);
    const previous = process.env.LIGHTEE_CONFIG_DIR;
    process.env.LIGHTEE_CONFIG_DIR = configDir;
    try {
      // 老配置快照：没有 presetRevision，带两个已撤下的预置服务商与一批停用模型 id
      await writeFile(join(configDir, "models.json"), JSON.stringify({
        providers: {
          deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", api: "openai-responses", models: [{ id: "deepseek-chat", name: "退役模型" }] },
          zhipu: { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions", models: [{ id: "glm-4", name: "GLM-4" }] },
          gemini: { name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "openai-completions", models: [{ id: "gemini-1.5-pro", name: "Gemini 1.5" }] },
          "my-proxy": { name: "我自建的中转", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "whatever", name: "自定义" }] },
        },
      }), "utf8");
      const service = createIpcService({});
      // gemini 配过密钥 → 撤下的是预置不是能力，不许替用户删
      await service.invoke(envelope("ai.key.write", { providerId: "gemini", apiKey: "sk-user-choice" }));

      const created = await service.invoke(envelope("workspace.create", { path: join(configDir, "ws"), name: "对账" }));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const listed = await service.invoke(envelope("ai.providers.list", { workspaceId: created.value.id }));
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const ids = listed.value.providers.map((provider) => provider.id);

      expect(ids, "无密钥的已撤下预置应被移除").not.toContain("zhipu");
      expect(ids, "配过密钥的已撤下预置必须保留").toContain("gemini");
      expect(ids, "用户自建的服务商一律不动").toContain("my-proxy");
      // 预置服务商的模型清单换成当前预置 → 停用 id 消失
      const deepseek = listed.value.providers.find((provider) => provider.id === "deepseek");
      expect(deepseek?.models.some((model) => model.id === "deepseek-chat"), "停用模型 id 应被清掉").toBe(false);
      expect(deepseek?.models.length).toBeGreaterThan(0);

      // 对账只跑一次：戳落盘后再列不应再改写
      const after = JSON.parse(await readFile(join(configDir, "models.json"), "utf8")) as { presetRevision?: number };
      expect(typeof after.presetRevision).toBe("number");

      // 恢复为预置的服务商要真的下发到老配置里（Gemini 3.7 Flash，2026-08-13）：
      // 只改 PRESET_PROVIDERS 而不提 PRESET_REVISION 的话，老配置一辈子看不到它。
      const google = listed.value.providers.find((provider) => provider.id === "google");
      expect(google, "恢复为预置的服务商应补进老配置").toBeTruthy();
      expect(google?.models.map((model) => model.id)).toContain("gemini-3.7-flash");
      // 档位按官方文档只开三档；xhigh/max 显式 null，免得被当成「透传支持」发出去
      const flash = google?.models.find((model) => model.id === "gemini-3.7-flash");
      expect(flash?.thinkingLevelMap?.medium).toBe("medium");
      expect(flash?.thinkingLevelMap?.xhigh).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.LIGHTEE_CONFIG_DIR;
      else process.env.LIGHTEE_CONFIG_DIR = previous;
    }
  });

  it("workspace.forget：条目从最近列表消失，但磁盘目录原封不动", async () => {
    const registryDir = await mkdtemp(join(tmpdir(), "lightee-forget-"));
    roots.push(registryDir);
    const service = createIpcService({ registryPath: join(registryDir, "workspaces.json") });
    const created = await service.invoke(envelope("workspace.create", { path: join(registryDir, "ws"), name: "要移除的书" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const forgotten = await service.invoke(envelope("workspace.forget", { workspaceId: created.value.id }));
    expect(forgotten.ok).toBe(true);
    if (!forgotten.ok) return;
    expect(forgotten.value.some((item) => item.id === created.value.id)).toBe(false);
    // 移除的是列表条目，不是作者的译文——目录必须还在
    expect(existsSync(join(registryDir, "ws", "book.yaml"))).toBe(true);
    // 不存在的 id → not_found，而不是静默成功
    expect(await service.invoke(envelope("workspace.forget", { workspaceId: "ws_nope" }))).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("RH-08：文件写队列在排空后不再残留 Map 条目（M-6）", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-queue-"));
    roots.push(root);
    const path = join(root, "queued.json");
    const before = pendingFileMutationQueues();
    await withFileMutationQueue(path, async () => undefined);
    await withFileMutationQueue(path, async () => undefined);
    await Promise.resolve();
    expect(pendingFileMutationQueues()).toBe(before);
  });

  // ===== RH-04 写追踪（DEF-07）=====
  it("RH-04：terms.create 进入 flushPendingWrites 的排空集合", async () => {
    const service = serviceWith();
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    const creating = service.invoke(envelope("terms.create", { workspaceId, archive: "terms", ja: "剣", zh: "剑", baseRevision: 0 }));
    const flushed = await service.flushPendingWrites();
    expect(flushed).toMatchObject({ ok: true, value: { status: "drained" } });
    expect(flushed.ok && flushed.value.pendingAtStart).toBeGreaterThan(0);
    expect(await creating).toMatchObject({ ok: true });
  });

  // ===== RH-05 翻译前置正文检测（DEF-05 / M-8）=====
  it("RH-05：空章节（仅标题）拒绝翻译且不调用 LLM", async () => {
    let llmCalls = 0;
    const countingLlm = {
      complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => {
        llmCalls += 1;
        return { text: xmlFrom(messages, "不应该被调用。") };
      },
    };
    const service = serviceWith({ llm: countingLlm });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);

    // chapter.create 产出的正是 `# <标题>\n`——DEF-03 实测中它被判定为「有正文」并真的跑完了一轮翻译
    const created = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: "空章节" }));
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) return;
    const emptyChapterId = created.value.chapterId;
    expect(await readFile(join(root, "source", "v01", `${emptyChapterId}.md`), "utf8").catch(() => "")).toContain("# 空章节");

    const rejected = await service.invoke(envelope("translate.run", { workspaceId, chapterId: emptyChapterId }));
    expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_request", message: "该章节没有可翻译的正文内容" } });
    expect(llmCalls).toBe(0);
  });

  it("RH-05：标题 + 正文正常进入翻译；无空格标题与空文件被拒绝", async () => {
    const service = serviceWith({ llm: { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, "译文。") }) } });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);

    const cases: Array<{ title: string; source: string; translatable: boolean }> = [
      { title: "有正文", source: "# 有正文\n\n日文本文。\n", translatable: true },
      { title: "单字符正文", source: "# 单字符\n\n…\n", translatable: true },
      { title: "无空格标题", source: "#无空格标题\n", translatable: false },
      { title: "空文件", source: "", translatable: false },
      { title: "仅分隔符", source: "# 仅分隔\n\n***\n", translatable: false },
    ];
    for (const testCase of cases) {
      const created = await service.invoke(envelope("chapter.create", { workspaceId, volumeId: "v01", title: testCase.title }));
      expect(created).toMatchObject({ ok: true });
      if (!created.ok) continue;
      const chapterId = created.value.chapterId;
      await writeFile(join(root, "source", "v01", `${chapterId}.md`), testCase.source, "utf8");
      const result = await service.invoke(envelope("translate.run", { workspaceId, chapterId }));
      if (testCase.translatable) expect(result, testCase.title).toMatchObject({ ok: true });
      else expect(result, testCase.title).toMatchObject({ ok: false, error: { code: "invalid_request", message: "该章节没有可翻译的正文内容" } });
    }
  });

  // ===== RH-02 写权威回归（DEF-02）=====
  // EX-08：translation.storyContext.write 随全书概览退役，本例从六类收为五类；
  // 验的东西没变——不同字段并发写互不覆盖。
  it("RH-02：五类配置写入并发发出后全部持久化，互不覆盖", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-ipc-"));
    roots.push(root);
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "写权威" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceId = created.value.id;

    const rounds = 3;
    const pending: Array<Promise<unknown>> = [];
    for (let round = 0; round < rounds; round += 1) {
      pending.push(service.invoke(envelope("ai.model.write", { workspaceId, model: `provider/model-${round}` })));
      pending.push(service.invoke(envelope("ai.thinking.write", { workspaceId, thinking: `think-${round}` })));
      pending.push(service.invoke(envelope("ai.reviewThinking.write", { workspaceId, thinking: `review-${round}` })));
    }
    // settings.write 走 revision 检查：并发发出一次，必须与上面三类共存而不是互相清空
    pending.push(service.invoke(envelope("settings.write", { workspaceId, key: "editor.fontSize", value: 22, baseRevision: 0 })));
    const results = await Promise.all(pending);
    for (const result of results) expect(result).toMatchObject({ ok: true });

    const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    // 同一字段按发出顺序串行 → 最后一轮的值；不同字段互不覆盖 → 全部存在
    expect(config.ai).toMatchObject({
      model: `provider/model-${rounds - 1}`,
      thinking: `think-${rounds - 1}`,
      reviewThinking: `review-${rounds - 1}`,
    });
    expect(config.editor.fontSize).toBe(22);
  });

  it("RH-02：models.json 并发 upsert 两个模型都保留", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "lightee-config-"));
    roots.push(configDir);
    const previous = process.env.LIGHTEE_CONFIG_DIR;
    process.env.LIGHTEE_CONFIG_DIR = configDir;
    try {
      const service = createIpcService();
      const [first, second] = await Promise.all([
        service.invoke(envelope("ai.model.upsert", { providerId: "deepseek", modelId: "model-a", modelName: "A" })),
        service.invoke(envelope("ai.model.upsert", { providerId: "deepseek", modelId: "model-b", modelName: "B" })),
      ]);
      expect(first).toMatchObject({ ok: true });
      expect(second).toMatchObject({ ok: true });
      const models = JSON.parse(await readFile(join(configDir, "models.json"), "utf8"));
      const ids = (models.providers?.deepseek?.models ?? []).map((model: { id: string }) => model.id);
      expect(ids).toContain("model-a");
      expect(ids).toContain("model-b");
    } finally {
      if (previous === undefined) delete process.env.LIGHTEE_CONFIG_DIR;
      else process.env.LIGHTEE_CONFIG_DIR = previous;
    }
  });

  it("RH-02：auth.json 并发写入两个服务商密钥都保留", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "lightee-config-"));
    roots.push(configDir);
    const previous = process.env.LIGHTEE_CONFIG_DIR;
    process.env.LIGHTEE_CONFIG_DIR = configDir;
    try {
      const service = createIpcService();
      const written = await Promise.all([
        service.invoke(envelope("ai.key.write", { providerId: "deepseek", apiKey: "key-deepseek" })),
        service.invoke(envelope("ai.key.write", { providerId: "openai", apiKey: "key-openai" })),
      ]);
      for (const result of written) expect(result).toMatchObject({ ok: true });
      const auth = JSON.parse(await readFile(join(configDir, "auth.json"), "utf8"));
      expect(auth.deepseek).toMatchObject({ key: "key-deepseek" });
      expect(auth.openai).toMatchObject({ key: "key-openai" });
    } finally {
      if (previous === undefined) delete process.env.LIGHTEE_CONFIG_DIR;
      else process.env.LIGHTEE_CONFIG_DIR = previous;
    }
  });

  // ===== RH-17 密钥加密存储（A-4） =====
  /** 假编解码器：可逆但显然不是明文（reverse + base64），用来断言「磁盘上没有明文」 */
  function fakeCodec(available: () => boolean = () => true): SecretCodec {
    return {
      available,
      encrypt: (plain) => Buffer.from([...plain].reverse().join(""), "utf8").toString("base64"),
      decrypt: (sealed) => [...Buffer.from(sealed, "base64").toString("utf8")].reverse().join(""),
    };
  }
  async function withConfigDir<T>(fn: (configDir: string) => Promise<T>): Promise<T> {
    const configDir = await mkdtemp(join(tmpdir(), "lightee-config-"));
    roots.push(configDir);
    const previous = process.env.LIGHTEE_CONFIG_DIR;
    process.env.LIGHTEE_CONFIG_DIR = configDir;
    try {
      return await fn(configDir);
    } finally {
      setSecretCodec(null);
      if (previous === undefined) delete process.env.LIGHTEE_CONFIG_DIR;
      else process.env.LIGHTEE_CONFIG_DIR = previous;
    }
  }

  it("RH-17：codec 可用时 auth.json 落盘不含明文密钥，读取仍还原", async () => {
    await withConfigDir(async (configDir) => {
      setSecretCodec(fakeCodec());
      const service = createIpcService();
      const workspaceRoot = await mkdtemp(join(tmpdir(), "lightee-ws-"));
      roots.push(workspaceRoot);
      const created = await service.invoke(envelope("workspace.create", { path: workspaceRoot, name: "加密" }));
      expect(created).toMatchObject({ ok: true });
      const workspaceId = (created as { value: { id: string } }).value.id;

      expect(await service.invoke(envelope("ai.key.write", { providerId: "deepseek", apiKey: "sk-plain-secret" }))).toMatchObject({ ok: true });

      const text = await readFile(join(configDir, "auth.json"), "utf8");
      expect(text).not.toContain("sk-plain-secret");
      expect(JSON.parse(text).deepseek.sealed).toBe(AUTH_SEALED_TAG);

      const listed = await service.invoke(envelope("ai.providers.list", { workspaceId }));
      const providers = (listed as { value: { providers: Array<{ id: string; hasKey?: boolean }> } }).value.providers;
      expect(providers.find((provider) => provider.id === "deepseek")?.hasKey).toBe(true);
    });
  });

  it("RH-17：明文旧条目在 codec 可用时被加密回写（机会式迁移）", async () => {
    await withConfigDir(async (configDir) => {
      await writeFile(join(configDir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-legacy-plain" } }), "utf8");
      setSecretCodec(fakeCodec());
      expect(await migrateLighteeAuthEncryption()).toBe(1);

      const text = await readFile(join(configDir, "auth.json"), "utf8");
      expect(text).not.toContain("sk-legacy-plain");
      expect(JSON.parse(text).deepseek.sealed).toBe(AUTH_SEALED_TAG);

      // 迁移后读取仍还原成明文（消费侧无感）
      const service = createIpcService();
      const workspaceRoot = await mkdtemp(join(tmpdir(), "lightee-ws-"));
      roots.push(workspaceRoot);
      const created = await service.invoke(envelope("workspace.create", { path: workspaceRoot, name: "迁移" }));
      const workspaceId = (created as { value: { id: string } }).value.id;
      const listed = await service.invoke(envelope("ai.providers.list", { workspaceId }));
      const providers = (listed as { value: { providers: Array<{ id: string; hasKey?: boolean }> } }).value.providers;
      expect(providers.find((provider) => provider.id === "deepseek")?.hasKey).toBe(true);
    });
  });

  it("RH-17：密文被篡改 → hasKey 为 false 且不抛异常", async () => {
    await withConfigDir(async (configDir) => {
      setSecretCodec({
        available: () => true,
        encrypt: (plain) => plain,
        decrypt: (sealed) => { if (sealed === "tampered") throw new Error("解密失败"); return sealed; },
      });
      await writeFile(join(configDir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "tampered", sealed: AUTH_SEALED_TAG } }), "utf8");

      const service = createIpcService();
      const workspaceRoot = await mkdtemp(join(tmpdir(), "lightee-ws-"));
      roots.push(workspaceRoot);
      const created = await service.invoke(envelope("workspace.create", { path: workspaceRoot, name: "篡改" }));
      const workspaceId = (created as { value: { id: string } }).value.id;
      const listed = await service.invoke(envelope("ai.providers.list", { workspaceId }));
      expect(listed).toMatchObject({ ok: true });
      const providers = (listed as { value: { providers: Array<{ id: string; hasKey?: boolean }> } }).value.providers;
      expect(providers.find((provider) => provider.id === "deepseek")?.hasKey).toBe(false);

      // 无法解密的条目不得被后续写入抹掉——用户换回原账户/修好 keyring 后还能用
      expect(await service.invoke(envelope("ai.key.write", { providerId: "openai", apiKey: "sk-other" }))).toMatchObject({ ok: true });
      expect(JSON.parse(await readFile(join(configDir, "auth.json"), "utf8")).deepseek).toMatchObject({ key: "tampered", sealed: AUTH_SEALED_TAG });
    });
  });

  it("RH-20/B-2：workspace.list 不给未打开的工作区启动术语 watcher", async () => {
    const registry = await mkdtemp(join(tmpdir(), "lightee-registry-"));
    roots.push(registry);
    const service = createIpcService({ engine: engineWiring, registryPath: join(registry, "workspaces.json"), terminologyWatcher: true });
    const first = await createImportedWorkspace(service, SAMPLE_TXT);
    const second = await createImportedWorkspace(service, SAMPLE_TXT);
    // create 会打开工作区 → 两个 watcher
    expect(service.terminologyWatcherCount()).toBe(2);

    await service.invoke(envelope("workspace.close", { workspaceId: first.workspaceId }));
    await service.invoke(envelope("workspace.close", { workspaceId: second.workspaceId }));
    expect(service.terminologyWatcherCount()).toBe(0);

    // 关键断言：仅仅列出书架不得把 watcher 重新全部拉起来
    const listed = await service.invoke(envelope("workspace.list", {}));
    expect(listed).toMatchObject({ ok: true });
    expect(service.terminologyWatcherCount()).toBe(0);

    // 显式打开的那一个仍然被监视
    await service.invoke(envelope("workspace.open", { path: first.root }));
    expect(service.terminologyWatcherCount()).toBe(1);
    await service.invoke(envelope("workspace.close", { workspaceId: first.workspaceId }));
  });

  // ===== RH-19 settings 真实生效（A-7） =====
  /**
   * 跑一次真实 translate.run，捕获**实际交给引擎的** pipeline config。
   * 断言「值真实传递」而不是断言下游巧合结果——RH-19 的 Non-Goals 明确只保证传递。
   */
  async function capturePipelineTranslation(patchConfig: (current: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | null = null;
    const wiring: EngineWiring = {
      ...engineWiring,
      runChapterPipeline: ((ws: never, chapterId: never, llm: never, config: { translation: Record<string, unknown> }, options: never) => {
        captured = config.translation;
        return (engineWiring.runChapterPipeline as (...args: unknown[]) => unknown)(ws, chapterId, llm, config, options);
      }) as EngineWiring["runChapterPipeline"],
    };
    const service = serviceWith({ engine: wiring, llm: { complete: async (_m, messages) => ({ text: xmlFrom(messages, "这是翻译结果。") }) } });
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    await markTerminologyConfirmed(root);
    const configPath = join(root, "config.json");
    const current = JSON.parse(await readFile(configPath, "utf8").catch(() => "{}")) as Record<string, unknown>;
    await writeFile(configPath, JSON.stringify(patchConfig(current), null, 2), "utf8");
    expect(await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }))).toMatchObject({ ok: true });
    expect(captured).not.toBeNull();
    return captured!;
  }

  it("RH-19：settings 的 batchChars / quoteStyle / guide 真实进入引擎配置", async () => {
    const translation = await capturePipelineTranslation((current) => ({
      ...current,
      quoteStyle: "jp",
      translation: { ...(current.translation as Record<string, unknown>), batchChars: 1000, guide: "面向高中生的口语化译法" },
    }));
    expect(translation.batchChars).toBe(1000);
    expect(translation.quoteStyle).toBe("jp");
    expect(translation.guide).toBe("面向高中生的口语化译法");
  });

  // EX-05：termInjection 随 subset/frozen 两种模式一起退役——注入只有一种形态
  // （累积词表、追加序）。本例收缩为 styleAnchor 的可写性与真实生效。
  it("R2：styleAnchor 可写且真实进入引擎配置", async () => {
    const service = serviceWith();
    const { workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    const read = await service.invoke(envelope("settings.read", { workspaceId }));
    expect(read).toMatchObject({ ok: true });
    expect(await service.invoke(envelope("settings.write", {
      workspaceId, baseRevision: (read as { value: { revision: number } }).value.revision, key: "translation.styleAnchor", value: "夜色沉下来。",
    }))).toMatchObject({ ok: true });

    const translation = await capturePipelineTranslation((current) => ({
      ...current,
      translation: { ...(current.translation as Record<string, unknown>), styleAnchor: "夜色沉下来。" },
    }));
    expect(translation.styleAnchor).toBe("夜色沉下来。");
  });


  it("RH-19：非法设置值被钳制而不是静默取默认", async () => {
    const translation = await capturePipelineTranslation((current) => ({
      ...current,
      translation: { ...(current.translation as Record<string, unknown>), batchChars: 99_999 },
    }));
    expect(translation.batchChars).toBe(20_000);
  });

  it("RH-19：contextWindow 优先取模型定义，其次取 settings", async () => {
    await withConfigDir(async (configDir) => {
      // models.json 中为当前模型声明 262144 → 必须压过 settings 里的 200000
      await writeFile(join(configDir, "models.json"), JSON.stringify({
        providers: { deepseek: { name: "DeepSeek", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "deepseek-v4-pro", contextWindow: 262_144 }] } },
      }), "utf8");
      const defined = await capturePipelineTranslation((current) => ({ ...current, contextWindow: 200_000 }));
      expect(defined.contextWindow).toBe(262_144);
    });
    await withConfigDir(async (configDir) => {
      // 模型无定义 → 退到 settings
      await writeFile(join(configDir, "models.json"), JSON.stringify({ providers: { deepseek: { models: [] } } }), "utf8");
      const fromSettings = await capturePipelineTranslation((current) => ({ ...current, contextWindow: 200_000 }));
      expect(fromSettings.contextWindow).toBe(200_000);
    });
  });

  it("RH-19：translation.concurrency 已从可写白名单移除（无消费点）", async () => {
    const service = serviceWith();
    const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
    void root;
    const read = await service.invoke(envelope("settings.read", { workspaceId }));
    expect(read).toMatchObject({ ok: true });
    if (!read.ok) return;
    const rejected = await service.invoke(envelope("settings.write", { workspaceId, baseRevision: read.value.revision, key: "translation.concurrency", value: 4 }));
    expect(rejected).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    // 仍然可写的项不受影响
    expect(await service.invoke(envelope("settings.write", { workspaceId, baseRevision: read.value.revision, key: "translation.batchChars", value: 1500 }))).toMatchObject({ ok: true });
  });

  // ===== RH-18 OAuth state 闭环（A-6） =====
  /** 假 token 端点：记录收到的 code，返回合法 token 响应 */
  async function withFakeTokenEndpoint<T>(fn: (tokenUrl: string, received: string[]) => Promise<T>): Promise<T> {
    const received: string[] = [];
    const server = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        received.push(new URLSearchParams(body).get("code") ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "token-from-fake-endpoint", refresh_token: "refresh-1", expires_in: 3600 }));
      });
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const port = (server.address() as { port: number }).port;
    try {
      return await fn(`http://127.0.0.1:${port}/token`, received);
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  }
  /** 注册一个带 oauth 配置的服务商（契约里没有单独的 oauth 写入命令） */
  async function seedOauthProvider(service: ReturnType<typeof createIpcService>, configDir: string, tokenUrl: string): Promise<void> {
    await service.invoke(envelope("ai.provider.upsert", { providerId: "demo", name: "Demo", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions" }));
    const modelsPath = join(configDir, "models.json");
    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    models.providers.demo.oauth = { authorizeUrl: "http://127.0.0.1:1/authorize", tokenUrl, clientId: "cid" };
    await writeFile(modelsPath, JSON.stringify(models, null, 2), "utf8");
  }

  it("RH-18：state 不匹配的回调被拒绝，且不交换 code、不写 auth.json", async () => {
    await withConfigDir(async (configDir) => {
      await withFakeTokenEndpoint(async (tokenUrl, received) => {
        const service = createIpcService({ openExternal: async () => true });
        await seedOauthProvider(service, configDir, tokenUrl);
        const login = await service.invoke(envelope("ai.oauth.login", { providerId: "demo" }));
        expect(login).toMatchObject({ ok: true });
        if (!login.ok) return;

        const response = await fetch(`${login.value.redirectUri}?code=injected-code&state=wrong-state`);
        const waited = await service.invoke(envelope("ai.oauth.wait", { providerId: "demo" }));
        // 首要断言：伪造的 code 从未被拿去换 token，密钥文件也没被写
        expect(received).toEqual([]);
        await expect(readFile(join(configDir, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        // 其次：回调本身要以 400 拒绝，不能先回 200 让用户以为登录成功了
        expect(response.status).toBe(400);
        expect(waited).toMatchObject({ ok: true, value: { ok: false } });
        expect((waited as { value: { message: string } }).value.message).toContain("state");
      });
    });
  });

  it("RH-18：state 匹配的回调正常换取 token 并写入 auth.json", async () => {
    await withConfigDir(async (configDir) => {
      await withFakeTokenEndpoint(async (tokenUrl, received) => {
        const service = createIpcService({ openExternal: async () => true });
        await seedOauthProvider(service, configDir, tokenUrl);
        const login = await service.invoke(envelope("ai.oauth.login", { providerId: "demo" }));
        expect(login).toMatchObject({ ok: true });
        if (!login.ok) return;
        const state = new URL(login.value.authUrl).searchParams.get("state");
        expect(state).toBeTruthy();

        await fetch(`${login.value.redirectUri}?code=real-code&state=${encodeURIComponent(state!)}`);
        expect(await service.invoke(envelope("ai.oauth.wait", { providerId: "demo" }))).toMatchObject({ ok: true, value: { ok: true } });
        expect(received).toEqual(["real-code"]);
        const auth = JSON.parse(await readFile(join(configDir, "auth.json"), "utf8"));
        expect(auth.demo).toMatchObject({ type: "oauth", key: "token-from-fake-endpoint" });
      });
    });
  });

  it("RH-17：codec 不可用时全链路明文可用且不留假标记", async () => {
    await withConfigDir(async (configDir) => {
      setSecretCodec(fakeCodec(() => false));
      const service = createIpcService();
      expect(await service.invoke(envelope("ai.key.write", { providerId: "deepseek", apiKey: "sk-plain-mode" }))).toMatchObject({ ok: true });
      const entry = JSON.parse(await readFile(join(configDir, "auth.json"), "utf8")).deepseek;
      expect(entry).toMatchObject({ key: "sk-plain-mode" });
      expect(entry.sealed).toBeUndefined();
      expect(await migrateLighteeAuthEncryption()).toBe(0);
    });
  });

    it("翻译结束后，译文里的【待审:原文】进入术语确认队列", async () => {
      // 译文带新术语标记：这些词产生在 prepareTerminology 之后，赶不上那一轮的队列
      const fakeLlm = {
        complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({
          text: xmlFrom(messages, "他打开了道具箱【待审:アイテムボックス】。"),
        }),
      };
      const service = serviceWith({ llm: fakeLlm });
      const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
      await markTerminologyConfirmed(root);

      const translated = await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
      expect(translated).toMatchObject({ ok: true });

      const session = JSON.parse(await readFile(join(root, "state", "confirm-session.json"), "utf8"));
      expect(session.cards.map((card: { ja: string }) => card.ja)).toContain("アイテムボックス");
      // 入队后从待办文件移除，重复翻译不会重复入队
      const pending = JSON.parse(await readFile(join(root, "state", "pending-terms.json"), "utf8"));
      expect(pending).toEqual([]);
    });

    it("译文无标记时不建会话、不留空队列", async () => {
      const fakeLlm = { complete: async (_m: unknown, messages: Array<{ role: string; content: string }>) => ({ text: xmlFrom(messages, "普通译文。") }) };
      const service = serviceWith({ llm: fakeLlm });
      const { root, workspaceId } = await createImportedWorkspace(service, SAMPLE_TXT);
      await markTerminologyConfirmed(root);
      await service.invoke(envelope("translate.run", { workspaceId, chapterId: "ch001" }));
      expect(existsSync(join(root, "state", "confirm-session.json"))).toBe(false);
    });
});

/**
 * Q3 回归：创建工作区有两条路径（engine 的 createWorkspace 与这里的 workspace.create），
 * 首版播种只做了前者，真实用户走的正是后者——端到端跑真实模型才发现 post-dict.json 是空的、
 * 规则一条没生效。这条断言守住的是「用户实际走的那条路」。
 */
describe("内置译后规则播种（IPC 创建路径）", () => {
  it("workspace.create 写入译后字典种子规则并默认启用", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-seed-ipc-"));
    roots.push(root);
    const service = createIpcService();
    const created = await service.invoke(envelope("workspace.create", { path: root, name: "播种" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const rows = JSON.parse(await readFile(join(root, "terminology", "post-dict.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.id)).toEqual(SEEDED_POST_DICT_RULES.map((rule) => rule.id));
    expect(rows.every((row) => row.enabled === true)).toBe(true);

    // 种子必须进得了术语仓库（投影被接管），否则界面上看不到、也停用不了
    const listed = await service.invoke(envelope("terms.query", { workspaceId: created.value.id, archive: "postDict" }));
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const ids = (listed.value.items as Array<{ id: string }>).map((item) => item.id);
    for (const rule of SEEDED_POST_DICT_RULES) expect(ids.some((id) => id.includes(rule.id))).toBe(true);
  });
});
