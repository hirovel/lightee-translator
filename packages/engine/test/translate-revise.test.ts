import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace, type Workspace } from "../src/workspace.ts";
import { writeChapterParagraphs } from "../src/paragraph-gate.ts";
import { reviseChapterPassages } from "../src/translate-revise.ts";

let dir: string;
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lightee-revise-"));
  ws = await createWorkspace(dir, { name: "局部修订" });
  await mkdir(join(dir, "source"), { recursive: true });
  await mkdir(join(dir, "terminology"), { recursive: true });
  await writeFile(
    join(dir, "source", "manifest.json"),
    JSON.stringify({ book: "t", chapters: [{ id: "ch001" }] })
  );
  await writeFile(join(dir, "terminology", "names.json"), JSON.stringify([{ ja: "アリス", zh: "爱丽丝", type: "name" }]));
  await writeChapterParagraphs(ws, "ch001", [
    { id: "p0001", type: "body", source: "第一段原文", translation: "第一段译文" },
    { id: "p0002", type: "body", source: "第二段原文", translation: "第二段译文" },
    { id: "p0003", type: "body", source: "第三段原文", translation: "第三段译文" },
  ], { staging: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const config = {
  project: { name: "t", srcLang: "ja", tgtLang: "zh" },
  agents: { translator: { model: "m", thinking: "high" } },
  translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
};

describe("reviseChapterPassages", () => {
  it("只输出授权段落 → 返回修订 changes", async () => {
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        const user = messages[messages.length - 1]!.content;
        // 校验上下文注入（前后段只读 + 问题）
        expect(user).toContain("p0002");
        expect(user).toContain("第一段译文"); // 前段上下文
        expect(user).toContain("第三段译文"); // 后段上下文
        expect(user).toContain("[term_drift] 乙");
        expect(messages[0]!.content).toContain("局部修订模式");
        expect(messages[0]!.content).toContain("爱丽丝");
        return { text: '<paragraph id="p0002">第二段译文（修订）</paragraph>' };
      },
    };
    const changes = await reviseChapterPassages(ws, "ch001", [
      { paragraphId: "p0002", issues: ["[term_drift] 乙（应为: 乙）"] },
    ], llm as never, config);
    expect(changes).toEqual([{ paragraphId: "p0002", translation: "第二段译文（修订）" }]);
  });

  it("输出未授权段落 → 拒绝", async () => {
    const llm = {
      complete: async () => ({ text: '<paragraph id="p9999">越权</paragraph>' }),
    };
    await expect(
      reviseChapterPassages(ws, "ch001", [{ paragraphId: "p0002", issues: ["x"] }], llm as never, config)
    ).rejects.toThrow(/未授权段落/);
  });

  it("空输出 → 拒绝", async () => {
    const llm = { complete: async () => ({ text: "   " }) };
    await expect(
      reviseChapterPassages(ws, "ch001", [{ paragraphId: "p0002", issues: ["x"] }], llm as never, config)
    ).rejects.toThrow(/空/);
  });

  it("多段修订 → 返回多段 changes", async () => {
    const llm = {
      complete: async () => ({
        text: '<paragraph id="p0001">一修订</paragraph>\n<paragraph id="p0003">三修订</paragraph>',
      }),
    };
    const changes = await reviseChapterPassages(ws, "ch001", [
      { paragraphId: "p0001", issues: ["a"] },
      { paragraphId: "p0003", issues: ["b"] },
    ], llm as never, config);
    expect(changes.map((c) => c.paragraphId)).toEqual(["p0001", "p0003"]);
  });

  // PL-22：修订通道曾缺双关档案与作者偏好，局部修订会改丢主翻遵守的约束
  it("system 含本章双关档案与作者偏好（与主翻通道同一组装）", async () => {
    await writeFile(
      join(dir, "terminology", "puns.json"),
      JSON.stringify([
        { ja: "第二段原文", zh: "梗译", note: "本章出现" },
        { ja: "别章的梗", zh: "别译", note: "别章出现" },
      ])
    );
    const { saveAuthorPreferences } = await import("../src/author-preferences.ts");
    await saveAuthorPreferences(
      ws,
      "语气保持轻快。",
      {
        complete: async () =>
          JSON.stringify({
            rules: [{ id: "p1", scope: { kind: "book" }, kind: "constraint", rule: "语气保持轻快", confidence: 0.99 }],
            unresolved: [],
            conflicts: [],
          }),
      } as never
    );
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages[0]!.content;
        return { text: '<paragraph id="p0002">第二段译文（修订）</paragraph>' };
      },
    };
    await reviseChapterPassages(ws, "ch001", [{ paragraphId: "p0002", issues: ["x"] }], llm as never, config);
    expect(system).toContain("【翻译指南】");
    expect(system).toContain("【双关档案】");
    expect(system).toContain("本章出现");
    expect(system).not.toContain("别章的梗"); // 双关按章过滤同样生效
    expect(system).toContain("【作者偏好】");
    expect(system).toContain("语气保持轻快");
    // 修订模式保留自己的输出规则
    expect(system).toContain("只输出需要修订的段落");
  });

  // R0-1：修订产出与初译走同一 L0 引号映射，否则修订段会把整章引号风格改花
  it("修订产出经 L0 引号映射（quoteStyle=zh → 日式引号被规整）", async () => {
    const llm = {
      complete: async () => ({ text: '<paragraph id="p0002">「修订后」的『内容』</paragraph>' }),
    };
    const changes = await reviseChapterPassages(
      ws,
      "ch001",
      [{ paragraphId: "p0002", issues: ["x"] }],
      llm as never,
      { ...config, translation: { ...config.translation, quoteStyle: "zh" } }
    );
    expect(changes[0]!.translation).toBe("“修订后”的‘内容’");
  });

  it("quoteStyle=jp → 修订产出的中文引号被映射回日式", async () => {
    const llm = {
      complete: async () => ({ text: '<paragraph id="p0002">“修订后”</paragraph>' }),
    };
    const changes = await reviseChapterPassages(
      ws,
      "ch001",
      [{ paragraphId: "p0002", issues: ["x"] }],
      llm as never,
      { ...config, translation: { ...config.translation, quoteStyle: "jp" } }
    );
    expect(changes[0]!.translation).toBe("「修订后」");
  });

  it("修订 system 不再承担引号约束", async () => {
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages[0]!.content;
        return { text: '<paragraph id="p0002">修订</paragraph>' };
      },
    };
    await reviseChapterPassages(ws, "ch001", [{ paragraphId: "p0002", issues: ["x"] }], llm as never, config);
    expect(system).not.toContain("引号");
  });

  it("未知段落 item → 拒绝", async () => {
    await expect(
      reviseChapterPassages(ws, "ch001", [{ paragraphId: "p9999", issues: ["x"] }], { complete: async () => ({ text: "x" }) } as never, config)
    ).rejects.toThrow(/修订段落不存在/);
  });
});
