import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "../src/workspace.js";
import { importTxtBook } from "../src/txt-import.js";
import { runTranslate } from "../src/cli-pipeline.js";
import { readPendingTerms } from "../src/pending-terms.js";
import type { LlmRuntime } from "../src/llm-runtime.js";

/** 假 LLM runtime：按角色返回固定内容 */
function fakeRuntime(): Pick<LlmRuntime, "complete"> {
  return {
    complete: async (modelRef: string, messages: Array<{ role: string; content: string }>) => {
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      if (sys.includes("人物与说话者归属")) {
        const request = JSON.parse(user) as { blocks: Array<{ id: string; kind: string; text: string }> };
        const dialogues = request.blocks.filter((block) => block.kind === "dialogue");
        if (dialogues.length === 0) return { text: JSON.stringify({ entities: [], attributions: [], unresolved: [] }) };
        return { text: JSON.stringify({
          entities: [],
          attributions: [],
          unresolved: [{ blockIds: dialogues.map((block) => block.id), reason: "ambiguous_speaker", evidenceBlockIds: dialogues.map((block) => block.id), explanation: "此基线 fake 不承担人物归属。" }],
        }) };
      }
      if (sys.includes("角色语气画像分析器")) {
        const request = JSON.parse(user) as { entities: Array<{ entityId: string }>; assignedAttributions: Array<{ entityId: string; blockIds: string[] }> };
        return { text: JSON.stringify({ profiles: request.entities.map((entity) => {
          const assigned = request.assignedAttributions.find((item) => item.entityId === entity.entityId)?.blockIds ?? [];
          return { entityId: entity.entityId, selfRefs: [], particles: [], register: "plain", strategyZh: "保持自然口语", evidenceBlockIds: assigned, explanation: "根据已归属台词生成画像。" };
        }) }) };
      }
      if (sys.includes("术语学家") || user.includes("术语表")) {
        // Terminologist: 返回人名
        return { text: `[{"ja":"アリス","zh":"爱丽丝","type":"person_name","keep":true,"confidence":0.9}]` };
      }
      // Translator：CLI 与 App 现在走同一条实现，输出必须是段落 XML 且 id/顺序/数量与原文一致。
      // 此前 CLI 有一份简化直译实现（纯文本落盘、无段落门禁），假模型是照那份写的。
      // KA-5：术语走 register_terms 工具参数，两轮完成——假体必须按真运行时的时序发。
      if (!messages.some((m) => m.role === "toolResult")) {
        // continuation 在真运行时是 pi 的 AssistantMessage；这里只需要它被原样回灌
        return {
          text: "",
          stopReason: "toolUse",
          continuation: { role: "assistant", content: [] } as never,
          toolCalls: [{ id: "call_1", name: "register_terms", arguments: {
            terms: [{ ja: "アリス", zh: "爱丽丝", type: "person", note: null }],
            voices: [],
          } }],
          usage: { input: 100, output: 20 },
        } as never;
      }
      const ids = [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((m) => m[1]!);
      return {
        text: ids.map((id) => `<paragraph id="${id}">「你好」爱丽丝说道。</paragraph>`).join("\n"),
        usage: { input: 100, output: 50 },
      };
    },
  };
}

describe("CLI 全流程（假 Agent）", () => {
  it("TXT 导入 → 翻译 → 审校 → approved（EX-07：不再有译前提取一步）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qx-cli-"));
    const ws = await createWorkspace(dir, { name: "测试", srcLang: "ja" });
    const src = join(dir, "book.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(src, "第1章\n\n「こんにちは」アリスが言った。\n\n第2章\n\n「こんにちは」アリスが言った。", "utf-8");
    await importTxtBook(src, ws);

    const result = await runTranslate({
      workspace: ws,
      config: { agents: {}, translation: { mode: "balanced", concurrency: 2, batchChars: 2000 }, project: { name: "t", srcLang: "ja", tgtLang: "zh" } },
      llm: fakeRuntime() as unknown as LlmRuntime,
    });

    expect(result.approved.length).toBeGreaterThan(0);
    // 译文落盘
    const tr = readFileSync(join(dir, "translations", "ch001_zh.md"), "utf-8");
    expect(tr).toContain("爱丽丝");
    // 契约变迁：EX-04 时登记词进待办队列等确认；ADR-0008（TP-2）改为**登记即注入**——
    // 带译法的人名直写 names 档案（provenance=model），下一章立即可注入。
    // 12 章实测证明等确认的结局是档案空转、注入块全程「（无）」。
    const { TerminologyRepository } = await import("@lightee/core/terminology-repository");
    const snapshot = await new TerminologyRepository(dir).readSnapshot();
    const registered = snapshot.archives.names.find((entry) => entry.ja === "アリス");
    expect(registered).toMatchObject({ zh: "爱丽丝", provenance: "model" });
    // 待办队列不再收已落档的词
    expect((await readPendingTerms(ws)).map((term) => term.ja)).not.toContain("アリス");
    // 尾块一个字都不进译文
    expect(tr).not.toContain("TERMS");
  });

  // EX-07 / ADR-0007：原断言是「术语未确认时停等（不翻译）」。
  // 译前提取阶段退役后空词表不是错误状态，只是第一章还没翻——**导入即可翻**。
  it("空工作区（无任何术语档案）直接开翻，不被任何门禁挡住", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qx-cli-"));
    const ws = await createWorkspace(dir, { name: "t" });
    const src = join(dir, "book.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(src, "第1章\n\n「こんにちは」アリスが言った。", "utf-8");
    await importTxtBook(src, ws);

    const result = await runTranslate({
      workspace: ws,
      config: { agents: {}, translation: { mode: "balanced", concurrency: 1, batchChars: 2000 }, project: { name: "t", srcLang: "ja", tgtLang: "zh" } },
      llm: fakeRuntime() as unknown as LlmRuntime,
    });
    expect(result.approved).toEqual(["ch001"]);
    expect(readFileSync(join(dir, "translations", "ch001_zh.md"), "utf-8")).toContain("爱丽丝");
  });
});
