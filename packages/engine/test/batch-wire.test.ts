import { describe, expect, test, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { translateChapterToFile } from "../src/translate-one.ts";
import type { Workspace } from "../src/workspace.ts";
import type { PipelineConfig } from "../src/cli-pipeline.ts";

let root: string;
let ws: Workspace;
let config: PipelineConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "batch-e2e-test-"));
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
  config = {
    project: { name: "测试", srcLang: "ja", tgtLang: "zh" },
    agents: { translator: { model: "deepseek/deepseek-v4-flash", thinking: "high" } },
    translation: { mode: "quality", concurrency: 1, batchChars: 2000, contextWindow: 131072 },
  };
});

/** 生成长文本 */
function longText(paras: number, perPara = 200): string {
  const arr: string[] = [];
  for (let i = 0; i < paras; i++) {
    arr.push(`第${i}段。${"测试内容。".repeat(perPara / 5)}`);
  }
  return arr.join("\n\n");
}

/** 从 user 提取源段落 id */
function extractIds(user: string): string[] {
  return [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((m) => m[1]!);
}

/** mock llm：记录调用，按该批源段落 id 返回对应 XML */
function mockLlm(log: Array<{ system: string; user: string }>) {
  return {
    complete: async (_model: string, messages: Array<{ role: string; content: string }>) => {
      log.push({ system: messages[0]!.content, user: messages[1]!.content });
      const ids = extractIds(messages[1]!.content);
      return { text: ids.map((id) => `<paragraph id="${id}">译文批(${log.length})</paragraph>`).join("\n") };
    },
  };
}

describe("切批翻译（G2）", () => {
  test("超长章 + 小窗口(16k) → 切批多调用 + 拼接落盘 + checkpoint 清理", async () => {
    const src = longText(160); // 160 段 × 210 字 ≈ 33k 字符（块边界切批）
    await writeFile(join(root, "source", "v01", "ch001.md"), src, "utf-8");
    config.translation.contextWindow = 16384;
    config.translation.batchChars = 2000;
    const log: Array<{ system: string; user: string }> = [];
    const r = await translateChapterToFile(ws, "ch001", mockLlm(log), config);
    expect(log.length).toBeGreaterThan(2); // 切成多批
    expect(log[0]!.user).toContain("【第 1/");
    expect(log[1]!.user).toContain("【前批衔接】"); // 批间衔接注入
    expect(log[1]!.user).toContain("译文批(1)"); // 衔接 = 前批译文尾部
    // 拼接落盘（每批保持该批源段落数）
    const out = await readFile(join(root, "translations", "ch001_zh.md"), "utf-8");
    expect(out.split("\n\n").length).toBe(160); // 全部源段落
    // checkpoint 清理
    expect(existsSync(join(root, "state", "batches", "ch001.json"))).toBe(false);
    expect(r.charCount).toBe(out.trimEnd().length);
  });

  test("超长章 + 输出额度充足 → 不切批（整章一次）", async () => {
    const src = longText(160);
    await writeFile(join(root, "source", "v01", "ch001.md"), src, "utf-8");
    // 判定按输出预算：33k 源字符可见输出约 2.2 万 token，high 档还要为思考里的
    // 整章草稿留出同量级（TR-08 实测），额度给够才走单发
    (config.translation as { maxTokens?: number }).maxTokens = 200000;
    const log: Array<{ system: string; user: string }> = [];
    await translateChapterToFile(ws, "ch001", mockLlm(log), config);
    expect(log.length).toBe(1);
    expect(log[0]!.user).toContain("【原文】");
    expect(log[0]!.user).not.toContain("【第 ");
  });

  test("超长章 + 大窗口但输出上限只有注册表默认 8192 → 仍切批（PL-01）", async () => {
    const src = longText(160);
    await writeFile(join(root, "source", "v01", "ch001.md"), src, "utf-8");
    config.translation.contextWindow = 131072;
    const log: Array<{ system: string; user: string }> = [];
    await translateChapterToFile(ws, "ch001", mockLlm(log), config);
    expect(log.length).toBeGreaterThan(1);
  });

  test("短章 → 不切批（整章一次）", async () => {
    await writeFile(join(root, "source", "v01", "ch001.md"), "短文本。", "utf-8");
    const log: Array<{ system: string; user: string }> = [];
    await translateChapterToFile(ws, "ch001", mockLlm(log), config);
    expect(log.length).toBe(1);
  });

  test("checkpoint 恢复：第 2 批失败后重跑从未完成批继续", async () => {
    const src = longText(160);
    await writeFile(join(root, "source", "v01", "ch001.md"), src, "utf-8");
    config.translation.contextWindow = 16384;
    config.translation.batchChars = 2000;
    // 预写 checkpoint（前 1 批已完成：真实前批段落，batchChars=2000 时每批约 9 段）
    const { buildParagraphs } = await import("@lightee/core/paragraph");
    const sourceParas = buildParagraphs(src);
    const firstBatch = sourceParas.slice(0, 9).map((p) => ({
      id: p.id,
      type: p.type,
      text: `前批译文(${p.id})`,
    }));
    await mkdir(join(root, "state", "batches"), { recursive: true });
    await writeFile(
      join(root, "state", "batches", "ch001.json"),
      JSON.stringify({ done: 1, paras: [firstBatch] }),
      "utf-8"
    );
    const log: Array<{ system: string; user: string }> = [];
    const r = await translateChapterToFile(ws, "ch001", mockLlm(log), config);
    // 只翻译剩余批（不含已完成批）
    expect(log.length).toBeGreaterThan(0);
    const out = await readFile(join(root, "translations", "ch001_zh.md"), "utf-8");
    expect(out).toContain("前批译文(p0001)"); // checkpoint 译文保留
    expect(out.split("\n\n").length).toBe(160); // 全部段落
    expect(existsSync(join(root, "state", "batches", "ch001.json"))).toBe(false);
    expect(r.charCount).toBe(out.trimEnd().length);
  });
});
