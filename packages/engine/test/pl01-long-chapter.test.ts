/**
 * PL-01 长章节熔断回归：输出预算判定 · maxTokens 显式传递 · 截断转分批 ·
 * 分批与单发共用 system · reroute 备用模型进分批路径。
 */
import { describe, expect, test, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translateChapterToFile } from "../src/translate-one.ts";
import type { Workspace } from "../src/workspace.ts";
import type { PipelineConfig } from "../src/cli-pipeline.ts";

let root: string;
let ws: Workspace;
let config: PipelineConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pl01-"));
  ws = { root } as Workspace;
  await mkdir(join(root, "source", "v01"), { recursive: true });
  await mkdir(join(root, "terminology"), { recursive: true });
  await mkdir(join(root, "translations"), { recursive: true });
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(
    join(root, "source", "manifest.json"),
    JSON.stringify({ book: "测试书", chapters: [{ id: "ch001", title: "第一章", volume: "v01" }] }),
    "utf-8"
  );
  await writeFile(
    join(root, "state", "book-understanding.json"),
    JSON.stringify({ overview: "全书概览文本", chapterDigests: { ch001: "本章摘要文本" } }),
    "utf-8"
  );
  config = {
    project: { name: "测试", srcLang: "ja", tgtLang: "zh" },
    agents: { translator: { model: "deepseek/deepseek-v4-flash", thinking: "high" } },
    translation: { mode: "quality", concurrency: 1, batchChars: 2000, contextWindow: 131072 },
  };
});

/** 长章节：paras 段 × perPara 字符 */
function longText(paras: number, perPara = 200): string {
  return Array.from({ length: paras }, (_, i) => `第${i}段。${"日本語の本文。".repeat(Math.ceil(perPara / 7))}`).join("\n\n");
}

function extractIds(user: string): string[] {
  return [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((m) => m[1]!);
}

interface CallLog {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  truncated: boolean;
}

/**
 * 假模型：按本次调用的 maxTokens 截断输出（reasoning 先吃掉 2000 token 余量，
 * 剩余额度按 1.5 字符/token 折算）——真实模型超限截断的最小复现。
 */
function truncatingLlm(log: CallLog[], registryDefaultMaxTokens = 8192) {
  return {
    complete: async (
      model: string,
      messages: Array<{ role: string; content: string }>,
      opts?: { thinking?: string; maxTokens?: number }
    ) => {
      const user = messages[messages.length - 1]!.content;
      const xml = extractIds(user)
        .map((id) => `<paragraph id="${id}">译文内容。${"译文内容。".repeat(19)}</paragraph>`)
        .join("\n");
      const budgetChars = Math.max(0, ((opts?.maxTokens ?? registryDefaultMaxTokens) - 2000) * 1.5);
      const truncated = xml.length > budgetChars;
      log.push({ model, system: messages[0]!.content, user, maxTokens: opts?.maxTokens, truncated });
      return { text: truncated ? xml.slice(0, budgetChars) : xml };
    },
  };
}

describe("PL-01 输出预算熔断", () => {
  test("超长章 + 8192 输出上限的假模型 → 走分批，译文完整无截断", async () => {
    const src = longText(200); // ≈ 4 万字符
    await writeFile(join(root, "source", "v01", "ch001.md"), src, "utf-8");
    const log: CallLog[] = [];

    const r = await translateChapterToFile(ws, "ch001", truncatingLlm(log) as never, config);

    expect(log.length).toBeGreaterThan(1); // 分批
    expect(log.some((c) => c.truncated)).toBe(false); // 每批都在输出预算内
    const out = await readFile(join(root, "translations", "ch001_zh.md"), "utf-8");
    const paragraphs = out.trimEnd().split("\n\n");
    expect(paragraphs).toHaveLength(200);
    expect(paragraphs.every((p) => p.trim().length > 0)).toBe(true);
    expect(r.charCount).toBe(out.trimEnd().length);
  });

  test("配置 maxTokens 显式传给模型；额度足够时不分批", async () => {
    const src = longText(200);
    await writeFile(join(root, "source", "v01", "ch001.md"), src, "utf-8");
    // 4 万字符源文在 high 档：可见输出约 2.7 万 token，连同思考里的整章草稿约 10.7 万（TR-08）。
    // 原来写 65536——那是按「reasoning 只占 2000」估出来的，实测 ch002 的思考吃满 16384 仍未写完。
    (config.translation as { maxTokens?: number }).maxTokens = 200000;
    const log: CallLog[] = [];

    await translateChapterToFile(ws, "ch001", truncatingLlm(log) as never, config);

    expect(log).toHaveLength(1);
    expect(log[0]!.maxTokens).toBe(200000);
    expect(log[0]!.truncated).toBe(false);
  });

  test("超长单段（段内无空行）也能被安全切分，不会整段撞上限", async () => {
    const src = `序。\n\n${"長い一段落の本文。".repeat(2200)}`; // 单段约 2 万字符
    await writeFile(join(root, "source", "v01", "ch001.md"), src, "utf-8");
    const log: CallLog[] = [];

    await translateChapterToFile(ws, "ch001", truncatingLlm(log) as never, config);

    expect(log.length).toBeGreaterThan(1);
    expect(log.some((c) => c.truncated)).toBe(false);
    const out = await readFile(join(root, "translations", "ch001_zh.md"), "utf-8");
    const paragraphs = out.trimEnd().split("\n\n");
    expect(paragraphs).toHaveLength(2); // 段落数与源一致（切分只在段内）
    expect(paragraphs[1]!.length).toBeGreaterThan(500); // 超长段的译文由多批拼回
  });

  test("首次输出被截断 → 直接转分批，不原样重发整章", async () => {
    const src = longText(30); // 输出预算内，不预判分批
    await writeFile(join(root, "source", "v01", "ch001.md"), src, "utf-8");
    (config.translation as { maxTokens?: number }).maxTokens = 65536;
    const log: CallLog[] = [];
    const base = truncatingLlm(log);
    let calls = 0;
    const flakyLlm = {
      complete: async (
        model: string,
        messages: Array<{ role: string; content: string }>,
        opts?: { thinking?: string; maxTokens?: number }
      ) => {
        calls++;
        const res = await base.complete(model, messages, opts);
        // 第一次调用模拟被上游截断（输出停在半个段落上）
        if (calls === 1) {
          const cut = res.text.slice(0, Math.floor(res.text.length / 2));
          log[log.length - 1]!.truncated = true;
          return { text: cut };
        }
        return res;
      },
    };

    await translateChapterToFile(ws, "ch001", flakyLlm as never, config);

    expect(log.length).toBeGreaterThan(2);
    // 第二次调用是分批（不是整章原样重发）
    expect(log[1]!.user).toContain("【第 1/");
    expect(extractIds(log[1]!.user).length).toBeLessThan(30);
    const out = await readFile(join(root, "translations", "ch001_zh.md"), "utf-8");
    expect(out.trimEnd().split("\n\n")).toHaveLength(30);
  });
});

describe("PL-01 分批路径与单发路径同源", () => {
  test("分批 system 与单发 system 完全一致（指南/作者偏好不再缺失）", async () => {
    const { saveAuthorPreferences } = await import("../src/author-preferences.ts");
    const compilerLlm = {
      complete: async () =>
        JSON.stringify({
          rules: [{ id: "p1", scope: { kind: "book" }, kind: "constraint", rule: "语气保持轻快", confidence: 0.99 }],
          unresolved: [],
          conflicts: [],
        }),
    };
    await saveAuthorPreferences(ws, "语气保持轻快。", compilerLlm as never);

    const shortLog: CallLog[] = [];
    await writeFile(join(root, "source", "v01", "ch001.md"), "短い章。", "utf-8");
    await translateChapterToFile(ws, "ch001", truncatingLlm(shortLog) as never, config);
    expect(shortLog).toHaveLength(1);

    const longLog: CallLog[] = [];
    await writeFile(join(root, "source", "v01", "ch001.md"), longText(200), "utf-8");
    await translateChapterToFile(ws, "ch001", truncatingLlm(longLog) as never, config);
    expect(longLog.length).toBeGreaterThan(1);

    expect(longLog[0]!.system).toBe(shortLog[0]!.system);
    expect(longLog[0]!.system).toContain("【翻译指南】");
    expect(longLog[0]!.system).toContain("【作者偏好】");
  });

  test("reroute_translator 的备用模型传到分批路径", async () => {
    await writeFile(join(root, "source", "v01", "ch001.md"), longText(200), "utf-8");
    const log: CallLog[] = [];
    await translateChapterToFile(ws, "ch001", truncatingLlm(log) as never, config, undefined, "backup/model-x");
    expect(log.length).toBeGreaterThan(1);
    expect(log.every((c) => c.model === "backup/model-x")).toBe(true);
  });
});
