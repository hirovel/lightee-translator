/**
 * TP-4 飞行中改名补扫。
 *
 * 三段时序保证的中段：作者在某章飞行中改译法 → 那次全书追溯扫不到本章
 * （还没落盘）→ 本章落盘后按时间戳补扫。这里从两层验证：
 *  1. rename-log 的事件语义（追加、裁剪、按时刻过滤、按序）；
 *  2. 端到端：翻译进行中发生 retroRename，章落盘后译文已是新译名 + recheck 标记。
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRenameEvent, readRenameEventsSince } from "../src/rename-log.ts";
import { retroRename } from "../src/rename-repair.ts";
import { readChapterParagraphs } from "../src/paragraph-gate.ts";
import { createWorkspace } from "../src/workspace.ts";
import { importTxtBook } from "../src/txt-import.ts";
import { runTranslate } from "../src/cli-pipeline.ts";
import { runChapterPipeline } from "../src/chapter-pipeline.ts";
import type { LlmRuntime } from "../src/llm-runtime.ts";
import type { Workspace } from "../src/workspace.ts";

/** 假 LLM：正文轮先触发一次改名再吐旧译名——时序与真实飞行中改名一致 */
function inflightRenameRuntime(ws: Workspace): { llm: Pick<LlmRuntime, "complete">; renamed: () => Promise<{ replaced: number }> | null } {
  let midFlightRename: Promise<{ replaced: number }> | null = null;
  const llm: Pick<LlmRuntime, "complete"> = {
    complete: async (_model: string, messages: Array<{ role: string; content: string }>) => {
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      if (sys.includes("人物与说话者归属")) return { text: JSON.stringify({ entities: [], attributions: [], unresolved: [] }) };
      if (sys.includes("角色语气画像分析器")) return { text: JSON.stringify({ profiles: [] }) };
      if (!messages.some((m) => m.role === "toolResult")) {
        return {
          text: "",
          stopReason: "toolUse",
          continuation: { role: "assistant", content: [] } as never,
          toolCalls: [{ id: "call_1", name: "register_terms", arguments: {
            terms: [{ ja: "アリス", zh: "爱丽丝", type: "person", note: null }],
            voices: [],
          } }],
        } as never;
      }
      // 正文轮：此刻本章正在飞。作者改名 爱丽丝 → 艾莉丝
      midFlightRename ??= retroRename(ws, { ja: "アリス", oldZh: "爱丽丝", newZh: "艾莉丝", otherZh: [] });
      await midFlightRename;
      const ids = [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((m) => m[1]!);
      return { text: ids.map((id) => `<paragraph id="${id}">「你好」爱丽丝说道。</paragraph>`).join("\n") };
    },
  };
  return { llm, renamed: () => midFlightRename };
}

async function makeInflightWorkspace(): Promise<{ dir: string; ws: Workspace }> {
  const dir = await mkdtemp(join(tmpdir(), "lightee-inflight-"));
  const ws = await createWorkspace(dir, { name: "补扫测试", srcLang: "ja" });
  await writeFile(join(dir, "book.txt"), "第1章\n\n「こんにちは」アリスが言った。", "utf-8");
  await importTxtBook(join(dir, "book.txt"), ws);
  return { dir, ws };
}

async function expectRescanned(dir: string, ws: Workspace): Promise<void> {
  const translated = await readFile(join(dir, "translations", "ch001_zh.md"), "utf-8");
  expect(translated).toContain("艾莉丝");
  expect(translated).not.toContain("爱丽丝");
  const paragraphs = await readChapterParagraphs(ws, "ch001");
  const touched = paragraphs?.paragraphs.find((p) => p.translation.includes("艾莉丝"));
  expect(touched?.recheck?.reason).toContain("爱丽丝 → 艾莉丝");
}

describe("rename-log（TP-4 数据源）", () => {
  it("追加、按时刻过滤、保持发生顺序（链式改名要按序重放）", async () => {
    const ws = { root: await mkdtemp(join(tmpdir(), "lightee-rlog-")) } as Workspace;
    await appendRenameEvent(ws, { ja: "ア", oldZh: "爱丽丝", newZh: "艾莉丝", at: 100 });
    await appendRenameEvent(ws, { ja: "ア", oldZh: "艾莉丝", newZh: "阿莉丝", at: 200 });
    await appendRenameEvent(ws, { ja: "イ", oldZh: "鲍勃", newZh: "波布", at: 300 });

    expect((await readRenameEventsSince(ws, 150)).map((event) => event.newZh)).toEqual(["阿莉丝", "波布"]);
    expect((await readRenameEventsSince(ws, 0)).map((event) => event.oldZh)).toEqual(["爱丽丝", "艾莉丝", "鲍勃"]);
    expect(await readRenameEventsSince(ws, 400)).toEqual([]);
  });

  it("retroRename 自动落一条事件（正在飞的章之后靠它发现自己错过了什么）", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-rlog-"));
    const ws = { root } as Workspace;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "source"), { recursive: true });
    // 没有任何章节：扫描为空但事件必须照记——事件记录的是「作者改了名」
    // 这个事实本身，与这次扫到多少无关
    await writeFile(join(root, "source", "manifest.json"), JSON.stringify({ chapters: [] }), "utf-8");
    await retroRename(ws, { ja: "ア", oldZh: "爱丽丝", newZh: "艾莉丝", otherZh: [] });
    const events = await readRenameEventsSince(ws, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ oldZh: "爱丽丝", newZh: "艾莉丝" });
  });
});

describe("TP-4 端到端：飞行中改名 → 落盘后补扫", () => {
  it("CLI 管线：翻译进行中作者改名，落盘后自动补扫到新译名并带 recheck 标记", async () => {
    const { dir, ws } = await makeInflightWorkspace();
    const runtime = inflightRenameRuntime(ws);

    const result = await runTranslate({
      workspace: ws,
      config: { agents: {}, translation: { mode: "balanced", concurrency: 1, batchChars: 2000 }, project: { name: "t", srcLang: "ja", tgtLang: "zh" } },
      llm: runtime.llm as unknown as LlmRuntime,
    });
    expect(result.approved).toEqual(["ch001"]);

    // 飞行中那次改名本身替换了 0 处（本章当时没落盘）——补扫才是把它追上的那一步
    expect((await runtime.renamed()!).replaced).toBe(0);
    await expectRescanned(dir, ws);
  });

  it("App 管线（runChapterPipeline）：同一保证——落盘后补扫 + 降级告警不阻塞", async () => {
    const { dir, ws } = await makeInflightWorkspace();
    const runtime = inflightRenameRuntime(ws);
    const warnings: string[] = [];

    const result = await runChapterPipeline(ws, "ch001", runtime.llm as never, {
      agents: {},
      translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
    }, { onWarn: (message) => warnings.push(message) });

    expect(result.outcome.state).toBe("approved");
    expect((await runtime.renamed()!).replaced).toBe(0);
    await expectRescanned(dir, ws);
    // 补扫结果要出声：补了多少段，作者要能知道正文被机器动过
    expect(warnings.some((message) => message.includes("飞行中改名补扫"))).toBe(true);
  });
});
