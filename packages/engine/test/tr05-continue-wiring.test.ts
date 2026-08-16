/**
 * TR-05 接线回归：截断之后**真的只重发缺的段落**。
 *
 * `salvageTruncated` 的单测只证明「捞得出来」，证明不了调用点用上了它。
 * 这里钉的是行为：第一次调用被砍断 → 后续调用的 user 里不该再出现已经
 * 完整到达的那些 id。
 *
 * 少了这条，2026-08-12 那 380 秒（三次从零重跑整章）会悄悄回来。
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

const PARAS = 6;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tr05-"));
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
  const src = Array.from({ length: PARAS }, (_, i) => `第${i}段。日本語の本文。`).join("\n\n");
  await writeFile(join(root, "source", "v01", "ch001.md"), src, "utf-8");
});

const idsIn = (user: string): string[] => [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((m) => m[1]!);

/**
 * 只在**第一次**调用时砍断：前两段完整闭合，第三段停在半个开标签上。
 * 这正是实测里那次砍断的形状。
 */
function truncateOnceLlm(log: Array<{ user: string; ids: string[] }>) {
  let call = 0;
  return {
    complete: async (_model: string, messages: Array<{ role: string; content: string }>) => {
      const user = messages[messages.length - 1]!.content;
      const ids = idsIn(user);
      log.push({ user, ids });
      call += 1;
      const full = (list: string[]) => list.map((id) => `<paragraph id="${id}">译文${id}</paragraph>`).join("\n");
      if (call === 1) {
        const head = full(ids.slice(0, 2));
        return { text: `${head}\n<paragraph id="${ids[2]}` };
      }
      return { text: full(ids) };
    },
  };
}

describe("截断后续译", () => {
  test("已完整到达的段落不再重发——第二次调用只带缺的那些 id", async () => {
    const log: Array<{ user: string; ids: string[] }> = [];
    await translateChapterToFile(ws, "ch001", truncateOnceLlm(log) as never, config);

    expect(log.length).toBeGreaterThan(1);
    const first = log[0]!.ids;
    const kept = first.slice(0, 2);
    const laterIds = log.slice(1).flatMap((c) => c.ids);
    // 关键断言：p0001/p0002 已经完整到手，绝不该再花一次钱重译
    for (const id of kept) expect(laterIds).not.toContain(id);
    // 缺的那些必须全部补上
    for (const id of first.slice(2)) expect(laterIds).toContain(id);
  });

  test("续译后落盘的正文段落数与原文一致，且保留的是第一次那份译文", async () => {
    const log: Array<{ user: string; ids: string[] }> = [];
    await translateChapterToFile(ws, "ch001", truncateOnceLlm(log) as never, config);

    const out = (await readFile(join(root, "translations", "ch001_zh.md"), "utf-8")).trimEnd();
    const paragraphs = out.split("\n\n");
    expect(paragraphs).toHaveLength(PARAS);
    expect(paragraphs.every((p) => p.trim().length > 0)).toBe(true);
    // 顺序必须是原文顺序：合并时按 expectedIds 排，不是按到达顺序
    const first = log[0]!.ids;
    expect(paragraphs[0]).toContain(`译文${first[0]}`);
    expect(paragraphs[PARAS - 1]).toContain(`译文${first[PARAS - 1]}`);
  });

  /**
   * checkpoint 是按「**整章**分批」的批次序号存的。续译只处理缺口，两者的批号
   * 根本不是同一套坐标系——续译若去读它，`done: 1` 会让缺口的第一批被跳过，
   * 中间几段就凭空消失了，而状态上一切正常。
   *
   * 这里预置一份陈旧的整章 checkpoint：续译一旦复用它，就会漏段落。
   */
  test("续译不复用整章 checkpoint——两者批号不是同一套坐标系", async () => {
    await mkdir(join(root, "state", "batches"), { recursive: true });
    await writeFile(
      join(root, "state", "batches", "ch001.json"),
      JSON.stringify({ done: 1, paras: [[{ id: "p0001", type: "text", text: "陈旧的译文" }]] }),
      "utf-8"
    );

    const log: Array<{ user: string; ids: string[] }> = [];
    await translateChapterToFile(ws, "ch001", truncateOnceLlm(log) as never, config);

    const out = (await readFile(join(root, "translations", "ch001_zh.md"), "utf-8")).trimEnd();
    expect(out.split("\n\n")).toHaveLength(PARAS);
    // 陈旧 checkpoint 的内容绝不能混进来
    expect(out).not.toContain("陈旧的译文");
  });
});
