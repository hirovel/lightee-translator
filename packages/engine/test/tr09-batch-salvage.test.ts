/**
 * TR-09：批处理路径也要按段落边界续译。
 *
 * TR-05 只补了单发路径。分批路径的 `translateUnitsWithLadder` 在门禁失败后
 * 原样重发整批、再二分——**每一步都把已经完整到达的段落扔掉重译**，
 * 与修好之前的单发路径是同一个浪费。
 *
 * maxTokens 拉到官方上限之后，单发是常态、分批是兜底；兜底那条路自己漏着，
 * 等于没有兜底。
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

const PARAS = 8;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tr09-"));
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
    agents: { translator: { model: "m", thinking: "high" } },
    // 预算小到整章必然走分批通道；单批落在 batchCharsForBudget 的 500 字符地板上
    translation: { mode: "quality", concurrency: 1, batchChars: 2000, contextWindow: 131072, maxTokens: 500 },
  };
  // 每段约 60 字符 → 整章约 480 字符：在 maxTokens=500 下必然超输出预算走分批，
  // 而 batchCharsForBudget 的 500 字符地板又让这一批装得下全部 8 段——
  // 正好把 8 个单元一次喂进 translateUnitsWithLadder，也就是要测的那条路。
  const src = Array.from({ length: PARAS }, (_, i) => `第${i}段。${"日本語の本文。".repeat(7)}`).join("\n\n");
  await writeFile(join(root, "source", "v01", "ch001.md"), src, "utf-8");
});

const idsIn = (user: string): string[] => [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((m) => m[1]!);

/** 第一次调用砍在半个开标签上：前两段完整闭合，第三段没写完 */
function truncateOnceLlm(log: string[][]) {
  let call = 0;
  return {
    complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
      const ids = idsIn(messages[messages.length - 1]!.content);
      log.push(ids);
      call += 1;
      const full = (list: string[]) => list.map((id) => `<paragraph id="${id}">译文${id}</paragraph>`).join("\n");
      if (call === 1 && ids.length > 2) return { text: `${full(ids.slice(0, 2))}\n<paragraph id="${ids[2]}` };
      return { text: full(ids) };
    },
  };
}

describe("分批路径的截断续译", () => {
  test("首批被砍断 → 已闭合的段落不再重发", async () => {
    const log: string[][] = [];
    await translateChapterToFile(ws, "ch001", truncateOnceLlm(log) as never, config);

    expect(log.length).toBeGreaterThan(1);
    const kept = log[0]!.slice(0, 2);
    const later = log.slice(1).flat();
    for (const id of kept) expect(later).not.toContain(id);
  });

  test("续译后整章段落数完整，顺序与原文一致", async () => {
    const log: string[][] = [];
    await translateChapterToFile(ws, "ch001", truncateOnceLlm(log) as never, config);

    const out = (await readFile(join(root, "translations", "ch001_zh.md"), "utf-8")).trimEnd();
    const paragraphs = out.split("\n\n");
    expect(paragraphs).toHaveLength(PARAS);
    expect(paragraphs.every((p) => p.trim().length > 0)).toBe(true);
    expect(paragraphs[0]).toContain("译文p0001");
    expect(paragraphs[PARAS - 1]).toContain(`译文p000${PARAS}`);
  });

  test("门禁失败但不是截断时仍走原来的重译/二分阶梯——续译只治截断", async () => {
    const log: string[][] = [];
    const chatty = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        const ids = idsIn(messages[messages.length - 1]!.content);
        log.push(ids);
        // 单段请求才正常作答：坏批必然被二分定位出来
        if (ids.length !== 1) return { text: "好的，以下是翻译：\n\n（内容略）" };
        return { text: `<paragraph id="${ids[0]}">译${ids[0]}</paragraph>` };
      },
    };
    await expect(translateChapterToFile(ws, "ch001", chatty as never, config)).rejects.toThrow(/重试预算耗尽/);
    // 二分阶梯确实跑起来了（出现过比首批更小的请求）
    expect(log.some((ids) => ids.length < log[0]!.length)).toBe(true);
  });
});
