import { describe, expect, test, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translateChapterToFile, DEFAULT_GUIDE } from "../src/translate-one.ts";
import type { Workspace } from "../src/workspace.ts";
import type { PipelineConfig } from "../src/cli-pipeline.ts";

let root: string;
let ws: Workspace;
let config: PipelineConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "guide-test-"));
  ws = { root } as Workspace;
  await mkdir(join(root, "source", "v01"), { recursive: true });
  await mkdir(join(root, "terminology"), { recursive: true });
  await mkdir(join(root, "translations"), { recursive: true });
  await writeFile(
    join(root, "source", "manifest.json"),
    JSON.stringify({ book: "测试书", chapters: [{ id: "ch001", title: "第一章", volume: "v01" }] }),
    "utf-8"
  );
  await writeFile(join(root, "source", "v01", "ch001.md"), "灯来了。", "utf-8");
  config = {
    project: { name: "测试", srcLang: "ja", tgtLang: "zh" },
    agents: { translator: { model: "deepseek/deepseek-v4-flash", thinking: "high" } },
    translation: { mode: "quality", concurrency: 1, batchChars: 2000, contextWindow: 131072 },
  };
});

describe("翻译指南（用户需求：目标读者水平 + 语言风格）", () => {
  test("默认指南注入 system", async () => {
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages.find((x) => x.role === "system")?.content ?? "";
        return { text: "<paragraph id=\"p0001\">译</paragraph>" };
      },
    };
    await translateChapterToFile(ws, "ch001", llm as never, config);
    expect(system).toContain("【翻译指南】");
    expect(system).toContain("目标读者");
    expect(system).toContain(DEFAULT_GUIDE.split("\n")[1]!);
    expect(system).toContain("术语表");
  });

  test("settings 覆盖指南（config.translation.guide）", async () => {
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages.find((x) => x.role === "system")?.content ?? "";
        return { text: "<paragraph id=\"p0001\">译</paragraph>" };
      },
    };
    config.translation.guide = "【自定义指南】目标读者: 小学五年级。";
    await translateChapterToFile(ws, "ch001", llm as never, config);
    expect(system).toContain("【自定义指南】");
    expect(system).toContain("小学五年级");
    expect(system).not.toContain(DEFAULT_GUIDE.split("\n")[1]!);
  });
});

describe("重译附带详细问题（审校/Manager 反馈）", () => {
  test("retryNote 注入 user【重译要求】", async () => {
    let user = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        user = messages.find((x) => x.role === "user")?.content ?? "";
        return { text: "<paragraph id=\"p0001\">重译</paragraph>" };
      },
    };
    await translateChapterToFile(
      ws, "ch001", llm as never, config,
      "- [term_drift] 透君（应为: 辽君）\n- [untranslated] アイテムボックス"
    );
    expect(user).toContain("【重译要求】");
    expect(user).toContain("审校/Manager 反馈");
    expect(user).toContain("[term_drift] 透君");
    expect(user).toContain("[untranslated] アイテムボックス");
  });

  test("无 retryNote → 不注入重译段", async () => {
    let user = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        user = messages.find((x) => x.role === "user")?.content ?? "";
        return { text: "<paragraph id=\"p0001\">译</paragraph>" };
      },
    };
    await translateChapterToFile(ws, "ch001", llm as never, config);
    expect(user).not.toContain("【重译要求】");
    expect(user).toContain("【原文】");
  });
});
