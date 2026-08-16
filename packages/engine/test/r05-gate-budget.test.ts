/**
 * R0-5 门禁宽容层：寒暄剥离 · 章级重试总预算 · 单批连败二分降级到逐段单发。
 *
 * 竞品教训（AiNiee 单例一上午烧 4200 万 token）：分批路径每批各自无限重试没有硬顶。
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
  root = await mkdtemp(join(tmpdir(), "r05-"));
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
    // maxTokens 500 → 整章必然超输出预算，走分批通道；单批落到 batchCharsForBudget 的 500 字符地板。
    // TR-08 之前这里写 2000：旧公式里 reasoning 是个 +2000 的常数加项，在 2000 的预算下
    // 压倒一切，于是闸门说「装不下」而分批器的 500 地板又说「一批装得下」——两个判断互相矛盾，
    // 而这些用例钉的正是那个矛盾态。推理开销改成按倍数算之后两边自洽了，校准值随之重算。
    translation: { mode: "quality", concurrency: 1, batchChars: 2000, contextWindow: 131072, maxTokens: 500 },
  };
});

/** n 段、每段 100 字符的章节 */
async function writeChapter(n: number): Promise<void> {
  const paras = Array.from({ length: n }, (_, i) => `第${i}段。${"日本語の本文。".repeat(13)}`.slice(0, 100));
  await writeFile(join(root, "source", "v01", "ch001.md"), paras.join("\n\n"), "utf-8");
}

function idsOf(user: string): string[] {
  return [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((m) => m[1]!);
}

/** 永远只回寒暄的模型（wire 里一个段落都没有） */
function chattyLlm(log: string[][]) {
  return {
    complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
      log.push(idsOf(messages[messages.length - 1]!.content));
      return { text: "好的，以下是翻译：\n\n（内容略）" };
    },
  };
}

describe("寒暄剥离", () => {
  test("wire 前后的寒暄与尾注不阻断门禁", async () => {
    await writeFile(join(root, "source", "v01", "ch001.md"), "第一段。\n\n第二段。", "utf-8");
    delete (config.translation as { maxTokens?: number }).maxTokens; // 短章走单发
    let calls = 0;
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        calls++;
        const body = idsOf(messages[messages.length - 1]!.content)
          .map((id) => `<paragraph id="${id}">译${id}</paragraph>`)
          .join("\n");
        return { text: `好的，以下是翻译：\n\n${body}\n\n以上，如需调整请告知。` };
      },
    };

    const r = await translateChapterToFile(ws, "ch001", llm as never, config);

    expect(calls).toBe(1); // 一次通过，不触发重译
    expect(r.translation).toBe("译p0001\n\n译p0002");
    const md = await readFile(join(root, "translations", "ch001_zh.md"), "utf-8");
    expect(md).not.toContain("好的，以下是翻译");
    expect(md).not.toContain("如需调整");
  });
});

describe("章级门禁重试预算", () => {
  test("永远寒暄的模型 → 单章调用数有硬顶，错误写明重试预算耗尽", async () => {
    await writeChapter(4);
    const log: string[][] = [];

    await expect(translateChapterToFile(ws, "ch001", chattyLlm(log) as never, config)).rejects.toThrow(
      /重试预算耗尽/
    );

    // 首批首次尝试不计费 + 预算 4 次 = 5 次调用封顶
    expect(log).toHaveLength(5);
  });
});

describe("单批连败降级", () => {
  test("整批连败两次 → 二分为逐段单发，调用序可断言", async () => {
    await writeChapter(2);
    const log: string[][] = [];
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        const ids = idsOf(messages[messages.length - 1]!.content);
        log.push(ids);
        // 只有单段请求才正常作答：坏段落必然被二分定位出来
        if (ids.length !== 1) return { text: "好的，以下是翻译：\n\n（内容略）" };
        return { text: `<paragraph id="${ids[0]}">译${ids[0]}</paragraph>` };
      },
    };

    const r = await translateChapterToFile(ws, "ch001", llm as never, config);

    expect(log).toEqual([
      ["p0001", "p0002"], // 首次尝试
      ["p0001", "p0002"], // 带门禁明细重试一次
      ["p0001"], // 二分：左半
      ["p0002"], // 二分：右半
    ]);
    expect(r.translation).toBe("译p0001\n\n译p0002");
  });
});
