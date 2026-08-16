/**
 * translate-one 测试：单章翻译到文件（TUI /translate 用真实 pipeline）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { createWorkspace, type Workspace } from "../src/workspace.ts";
import { translateChapterToFile } from "../src/translate-one.ts";
import { extractPendingTerms } from "../src/pending-terms.ts";
import { toolLlm, toolLlmWithRawArgs } from "./helpers/tool-llm.ts";

let dir: string;
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lightee-t1-"));
  ws = await createWorkspace(dir, { name: "单章翻译" });
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(dir, "source", "v01"), { recursive: true });
  mkdirSync(join(dir, "terminology"), { recursive: true });
  mkdirSync(join(dir, "translations", "v01"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "source", "v01", "ch001.md"), "# 第1章\n\n「こんにちは」アリスが言った。", "utf-8");
  writeFileSync(
    join(dir, "source", "manifest.json"),
    JSON.stringify({ book: "t", chapters: [{ id: "ch001", title: "第1章", volume: "v01" }] })
  );
  writeFileSync(join(dir, "terminology", "names.json"), JSON.stringify([{ ja: "アリス", zh: "爱丽丝", type: "name" }]));
  writeFileSync(
    join(dir, "state", "book-understanding.json"),
    JSON.stringify({ overview: "x", chapterDigests: { ch001: "アリス打招呼" } })
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("translateChapterToFile", () => {
  // 标题原来写着「带术语/puns 上下文」，而 puns 那一半从来没有断言过
  //（多出来的 sawPuns 变量赋值都没有）。双关注入现在由下方
  // `buildChapterPunBlock` 那一组覆盖，这里只认它该认的那件事。
  it("翻译 + 落盘 + 累积词表进 system", async () => {
    let sawTerms = false;
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        const sys = messages[0]!.content;
        sawTerms = sys.includes("爱丽丝");
        return { text: "<paragraph id=\"p0001\">第1章</paragraph>\n<paragraph id=\"p0002\">「你好。」爱丽丝说道。</paragraph>" };
      },
    };
    const r = await translateChapterToFile(ws, "ch001", llm as never, {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
    });
    expect(r.translation).toContain("爱丽丝");
    expect(sawTerms).toBe(true);
    // 落盘
    const tr = await readFile(join(dir, "translations", "ch001_zh.md"), "utf-8");
    expect(tr).toContain("你好");
  });

  /**
   * EX-08 / D4：原来这里有三条断言——「全书概览进静态前缀」「周围章节窗口进 user」
   * 「storyContext=false 时两者都不注入」。三者依赖的 `state/book-understanding.json`
   * 由阅读轮写，而阅读轮随译前提取链一起退役；更根本的是作者的判断：全书梗概对
   * 译文质量没有帮助，却要占掉每章不可压缩的输入预算。
   *
   * 改写为反向断言：**这些块一个都不许再出现**。删掉断言等于把「不再注入」变成
   * 无人看守的承诺，下一个人顺手加回去也没人拦。
   */
  it("不再注入全书概览 / 上下文章节概要 / 本章摘要（EX-08 退役）", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "source", "v01", "ch002.md"), "2", "utf-8");
    writeFileSync(join(dir, "source", "v01", "ch003.md"), "3", "utf-8");
    writeFileSync(
      join(dir, "source", "manifest.json"),
      JSON.stringify({
        book: "t",
        chapters: [
          { id: "ch001", title: "t1", volume: "v01" },
          { id: "ch002", title: "t2", volume: "v01" },
          { id: "ch003", title: "t3", volume: "v01" },
        ],
      })
    );
    // 即便工作区里残留着旧的阅读轮产物，也不得被读进 prompt
    writeFileSync(
      join(dir, "state", "book-understanding.json"),
      JSON.stringify({ overview: "全书：青春恋爱物语", chapterDigests: { ch001: "第一章摘要", ch002: "第二章摘要", ch003: "第三章摘要" } })
    );
    let user = "";
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages[0]!.content;
        user = messages[messages.length - 1]!.content;
        return { text: "<paragraph id=\"p0001\">译</paragraph>" };
      },
    };
    await translateChapterToFile(ws, "ch002", llm as never, {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
    });
    expect(system).not.toContain("【全书概览】");
    expect(user).not.toContain("【全书概览】");
    expect(user).not.toContain("【上下文章节概要】");
    expect(user).not.toContain("【本章摘要】");
    expect(user).not.toContain("第二章摘要");
  });


  it("无术语表 → 正常翻译（空表）", async () => {
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "terminology", "names.json"));
    const llm = { complete: async () => ({ text: "<paragraph id=\"p0001\">第1章</paragraph>\n<paragraph id=\"p0002\">译文。</paragraph>" }) };
    const r = await translateChapterToFile(ws, "ch001", llm as never, {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
    });
    expect(r.translation).toContain("译文。");
    expect(r.translation).toContain("第1章");
  });

  it("未知章节 → 抛错", async () => {
    const llm = { complete: async () => ({ text: "x" }) };
    await expect(
      translateChapterToFile(ws, "ch999", llm as never, {
        project: { name: "t", srcLang: "ja", tgtLang: "zh" },
        agents: {},
        translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
      })
    ).rejects.toThrow();
  });

  it("作者偏好注入：约束规则进入 system，翻译不阻断", async () => {
    const { saveAuthorPreferences } = await import("../src/author-preferences.ts");
    const compilerLlm = {
      complete: async () => JSON.stringify({
        rules: [{ id: "p1", scope: { kind: "book" }, kind: "constraint", rule: "称呼「アリス」固定使用「爱丽丝」", confidence: 0.99 }],
        unresolved: [],
        conflicts: [],
      }),
    };
    await saveAuthorPreferences(ws, "アリス 固定译成爱丽丝。", compilerLlm as never);
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages[0]!.content;
        return { text: "<paragraph id=\"p0001\">第1章</paragraph>\n<paragraph id=\"p0002\">「你好。」爱丽丝说道。</paragraph>" };
      },
    };
    await translateChapterToFile(ws, "ch001", llm as never, {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
    });
    expect(system).toContain("【作者偏好】");
    expect(system).toContain("固定使用「爱丽丝」");
  });
});

/** 两串的最长公共前缀（度量前缀缓存实际能覆盖多远） */
function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

describe("PL-11 前缀缓存：system 静态段在前、章节可变段在后", () => {
  beforeEach(async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "source", "v01", "ch002.md"), "「おはよう」ボブが言った。", "utf-8");
    writeFileSync(
      join(dir, "source", "manifest.json"),
      JSON.stringify({
        book: "t",
        chapters: [
          { id: "ch001", title: "第1章", volume: "v01" },
          { id: "ch002", title: "第2章", volume: "v01" },
        ],
      })
    );
    writeFileSync(
      join(dir, "terminology", "names.json"),
      JSON.stringify([
        { ja: "アリス", zh: "爱丽丝", type: "name" },
        { ja: "ボブ", zh: "鲍勃", type: "name" },
      ])
    );
    writeFileSync(
      join(dir, "state", "book-understanding.json"),
      JSON.stringify({ overview: "全书：青春恋爱物语", chapterDigests: { ch001: "打招呼", ch002: "早安" } })
    );
  });

  /**
   * EX-05：前缀边界从「静态段 | 术语子集」前移到「静态段 + 全表 | 章节可变段」。
   *
   * 原断言是「分歧点之后才是术语子集」——那描述的是逐章子集注入。追加序之后
   * 累积词表对同一本书的每一章都相同，理应**落在公共前缀之内**；分歧只应来自
   * 真正随章变化的东西（作者偏好、本章双关档案）。
   */
  it("同一本书两章的 system 逐字节相同（累积词表在公共前缀之内）", async () => {
    const systems: string[] = [];
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        systems.push(messages[0]!.content);
        const ids = [...messages[1]!.content.matchAll(/<paragraph id="([^"]+)"/g)].map((x) => x[1]!);
        return { text: ids.map((id) => `<paragraph id="${id}">译</paragraph>`).join("\n") };
      },
    };
    const config = {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced" as const, concurrency: 1, batchChars: 2000 },
    };
    await translateChapterToFile(ws, "ch001", llm as never, config);
    await translateChapterToFile(ws, "ch002", llm as never, config);
    expect(systems).toHaveLength(2);
    const prefix = commonPrefix(systems[0]!, systems[1]!);
    expect(prefix).toContain("你是轻小译的译官");
    expect(prefix).toContain("【翻译指南】");
    expect(prefix).toContain("【输出格式】");
    // 累积词表现在也在前缀里 —— 这正是追加序换来的缓存命中
    expect(prefix).toContain("爱丽丝");
    expect(prefix).toContain("鲍勃");
    expect(systems[1]).toBe(systems[0]);
  });

  /**
   * EX-05：原断言是 PL-05「本章零术语 → 注入空术语表，不回退全书术语」。
   * 逐章子集退役后不存在「本章零术语」这个状态——累积词表整表注入，与本章是否
   * 出现无关。这不是放宽，是换了一种拿一致性的方式：跨章统一译法靠全表在场，
   * 而不是靠每章猜哪几个词会用到。
   */
  it("累积词表整表注入，与本章是否出现无关", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "source", "v01", "ch002.md"), "誰もいない。", "utf-8");
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages[0]!.content;
        return { text: "<paragraph id=\"p0001\">没有人。</paragraph>" };
      },
    };
    await translateChapterToFile(ws, "ch002", llm as never, {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
    });
    expect(system).not.toContain("术语表:\n（无）");
    expect(system).toContain("爱丽丝");
    expect(system).toContain("鲍勃");
  });
});


describe("PL-16 双关档案按章过滤", () => {
  beforeEach(async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "terminology", "puns.json"),
      JSON.stringify([
        { ja: "こんにちは", zh: "你好", note: "本章出现" },
        { ja: "さようなら", zh: "再见", note: "别章出现" },
      ])
    );
  });

  it("只注入本章原文出现的双关条目", async () => {
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages[0]!.content;
        return { text: "<paragraph id=\"p0001\">第1章</paragraph>\n<paragraph id=\"p0002\">「你好。」爱丽丝说道。</paragraph>" };
      },
    };
    await translateChapterToFile(ws, "ch001", llm as never, {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
    });
    expect(system).toContain("【双关档案】");
    expect(system).toContain("こんにちは");
    expect(system).not.toContain("さようなら");
  });

  it("本章无双关 → 不注入双关段", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "terminology", "puns.json"),
      JSON.stringify([{ ja: "さようなら", zh: "再见", note: "别章出现" }])
    );
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages[0]!.content;
        return { text: "<paragraph id=\"p0001\">第1章</paragraph>\n<paragraph id=\"p0002\">「你好。」爱丽丝说道。</paragraph>" };
      },
    };
    await translateChapterToFile(ws, "ch001", llm as never, {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
    });
    expect(system).not.toContain("【双关档案】");
  });
});

describe("R0-1 引号风格下沉 L0 后处理", () => {
  const config = {
    project: { name: "t", srcLang: "ja", tgtLang: "zh" },
    agents: {},
    translation: { mode: "balanced" as const, concurrency: 1, batchChars: 2000 },
  };

  it("模型输出日式引号 + quoteStyle=zh → 落盘译文与返回值全是中文引号", async () => {
    const llm = {
      complete: async () => ({
        text:
          '<paragraph id="p0001">第1章</paragraph>\n' +
          '<paragraph id="p0002">「你好。」爱丽丝说道，翻开了『魔导书』。</paragraph>',
      }),
    };
    const r = await translateChapterToFile(ws, "ch001", llm as never, {
      ...config,
      translation: { ...config.translation, quoteStyle: "zh" as const },
    });
    expect(r.translation).toContain("“你好。”");
    expect(r.translation).toContain("‘魔导书’");
    expect(r.translation).not.toMatch(/[「」『』]/);
    const md = await readFile(join(dir, "translations", "ch001_zh.md"), "utf-8");
    expect(md).not.toMatch(/[「」『』]/);
    const paras = JSON.parse(await readFile(join(dir, "state", "paragraphs", "ch001.json"), "utf-8")) as {
      paragraphs: Array<{ translation: string }>;
    };
    expect(paras.paragraphs[1]!.translation).toContain("“你好。”");
  });

  it("quoteStyle=jp → 模型输出的中文引号被映射回日式", async () => {
    const llm = {
      complete: async () => ({
        text:
          '<paragraph id="p0001">第1章</paragraph>\n' +
          '<paragraph id="p0002">“你好。”爱丽丝说道。</paragraph>',
      }),
    };
    const r = await translateChapterToFile(ws, "ch001", llm as never, {
      ...config,
      translation: { ...config.translation, quoteStyle: "jp" as const },
    });
    expect(r.translation).toContain("「你好。」");
    expect(r.translation).not.toMatch(/[“”‘’]/);
  });

  it("prompt 不再承担引号约束（静态前缀无引号指令）", async () => {
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages[0]!.content;
        return { text: '<paragraph id="p0001">第1章</paragraph>\n<paragraph id="p0002">译文</paragraph>' };
      },
    };
    await translateChapterToFile(ws, "ch001", llm as never, {
      ...config,
      translation: { ...config.translation, quoteStyle: "zh" as const },
    });
    expect(system).not.toContain("引号");
    expect(system).toContain("你是轻小译的译官。翻译为中文。");
  });
});

describe("新术语收割（生产路径）", () => {
  it("译文里的【待审:原文】被收割、落盘，并排除已在档案里的词", async () => {
    const llm = {
      complete: async (_m: string, _messages: Array<{ role: string; content: string }>) => ({
        text:
          "<paragraph id=\"p0001\">第1章</paragraph>\n" +
          "<paragraph id=\"p0002\">「你好。」爱丽丝【待审:アリス】看向道具箱【待审:アイテムボックス】。</paragraph>",
      }),
    };
    const r = await translateChapterToFile(ws, "ch001", llm as never, {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
    });

    // アリス 已在 names.json 里，不该再进候选队列
    expect(r.pendingTerms.map((t) => t.ja)).toEqual(["アイテムボックス"]);
    const saved = JSON.parse(await readFile(join(dir, "state", "pending-terms.json"), "utf-8"));
    expect(saved.map((t: { ja: string }) => t.ja)).toEqual(["アイテムボックス"]);
  });

  // 被标记词故意用全汉字（収納箱）：R4-2 的泄漏收割会把残留的假名专名捡回来，
  // 若这里仍用片假名，就分不清「标记路径没生效」还是「泄漏路径接住了」。
  it("标记格式必须与消费方正则一致——圆括号写法收不到", async () => {
    const llm = {
      complete: async () => ({
        text:
          "<paragraph id=\"p0001\">第1章</paragraph>\n" +
          "<paragraph id=\"p0002\">道具箱（待审: 収納箱）</paragraph>",
      }),
    };
    const r = await translateChapterToFile(ws, "ch001", llm as never, {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
    });
    expect(r.pendingTerms).toEqual([]);
  });

  /**
   * EX-08 收尾：原断言是「提示词要求的标记格式与收割正则同源」。
   *
   * NEW_TERM_RULE（内联【待审:原文】标记）已退役——R4-2 实测模型写出 0 个，
   * 而 EX-04 的 ===TERMS=== 尾块做同一件事且实测有效。两条规则并存等于对同一件事
   * 下两道格式不同的指令。
   *
   * 改为反向断言 + 收割侧仍在：**规则可以退役，收割不能跟着退役**——
   * 历史译文里可能还残留标记，剥不掉就会当成术语漂移误报。
   */
  it("不再要求内联【待审:】标记，但历史标记仍收割得到（EX-08）", async () => {
    let sys = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        sys = messages[0]!.content;
        return { text: "<paragraph id=\"p0001\">第1章</paragraph>\n<paragraph id=\"p0002\">译文</paragraph>" };
      },
    };
    await translateChapterToFile(ws, "ch001", llm as never, {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
    });
    expect(sys).not.toContain("【待审:原文词】");
    // 术语登记接手了同一件事，但它的格式说明书是工具 schema，不在 prompt 里（KA-5）
    expect(sys).not.toContain("===TERMS===");
    // 收割侧不动：旧译文里的标记照样能被认出来
    expect(extractPendingTerms("这是雏菊【待审:ヒナギク】的花。", "ch001").map((t) => t.ja)).toEqual(["ヒナギク"]);
  });
});

describe("R1 字典体系（译前规整 / 译后字典 / 禁翻表）", () => {
  const config = {
    project: { name: "t", srcLang: "ja", tgtLang: "zh" },
    agents: {},
    translation: { mode: "balanced" as const, concurrency: 1, batchChars: 2000 },
  };

  it("R1-2 译前字典规整的是发出去的 wire，落盘源文不变", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "terminology", "pre-dict.json"),
      JSON.stringify([{ find: "こんにちは", replace: "おはよう" }])
    );
    let user = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        user = messages[messages.length - 1]!.content;
        return { text: '<paragraph id="p0001">第1章</paragraph>\n<paragraph id="p0002">「早上好。」爱丽丝说道。</paragraph>' };
      },
    };
    await translateChapterToFile(ws, "ch001", llm as never, config);
    expect(user).toContain("おはよう");
    expect(user).not.toContain("こんにちは");
    // 存储源文是门禁合并的依据，不能被规整污染
    const paras = JSON.parse(await readFile(join(dir, "state", "paragraphs", "ch001.json"), "utf-8")) as {
      paragraphs: Array<{ source: string }>;
    };
    expect(paras.paragraphs[1]!.source).toContain("こんにちは");
    expect(await readFile(join(dir, "source", "v01", "ch001.md"), "utf-8")).toContain("こんにちは");
  });

  it("R1-1 译后字典在引号映射之后作用于落盘译文", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "terminology", "post-dict.json"),
      JSON.stringify([{ find: "爱丽丝", replace: "艾莉丝" }])
    );
    const llm = {
      complete: async () => ({
        text: '<paragraph id="p0001">第1章</paragraph>\n<paragraph id="p0002">「你好。」爱丽丝说道。</paragraph>',
      }),
    };
    const r = await translateChapterToFile(ws, "ch001", llm as never, config);
    expect(r.translation).toContain("“你好。”");
    expect(r.translation).toContain("艾莉丝");
    expect(r.translation).not.toContain("爱丽丝");
    const md = await readFile(join(dir, "translations", "ch001_zh.md"), "utf-8");
    expect(md).toContain("艾莉丝");
  });

  it("R1-3 本章出现的禁翻词以恒等映射进术语注入，未出现的不注入", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "terminology", "no-translate.json"),
      JSON.stringify([{ ja: "アリス" }, { ja: "ボブ" }])
    );
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages[0]!.content;
        return { text: '<paragraph id="p0001">第1章</paragraph>\n<paragraph id="p0002">译文</paragraph>' };
      },
    };
    await translateChapterToFile(ws, "ch001", llm as never, config);
    expect(system).toContain("- アリス → アリス（禁译，原样保留）");
    expect(system).not.toContain("ボブ");
  });
});

describe("EX-05 累积词表追加序注入", () => {
  const base = {
    project: { name: "t", srcLang: "ja", tgtLang: "zh" },
    agents: {},
    translation: { mode: "balanced" as const, concurrency: 1, batchChars: 2000 },
  };

  beforeEach(async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "source", "v01", "ch002.md"), "「おはよう」ボブが言った。", "utf-8");
    writeFileSync(
      join(dir, "source", "manifest.json"),
      JSON.stringify({
        book: "t",
        chapters: [
          { id: "ch001", title: "第1章", volume: "v01" },
          { id: "ch002", title: "第2章", volume: "v01" },
        ],
      })
    );
    writeFileSync(
      join(dir, "terminology", "names.json"),
      JSON.stringify([
        { ja: "アリス", zh: "爱丽丝", type: "name" },
        { ja: "ボブ", zh: "鲍勃", type: "name" },
      ])
    );
  });

  const capture = async (chapterId: string, config: typeof base): Promise<{ system: string; user: string }> => {
    let system = "";
    let user = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages[0]!.content;
        user = messages[messages.length - 1]!.content;
        const ids = [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((x) => x[1]!);
        return { text: ids.map((id) => `<paragraph id="${id}">译</paragraph>`).join("\n") };
      },
    };
    await translateChapterToFile(ws, chapterId, llm as never, config as never);
    return { system, user };
  };

  /**
   * EX-05：注入形态只剩一种——**累积词表、发现顺序追加、永不重排**。
   *
   * 原来这里有三条断言，分别描述 subset（逐章子集）与 frozen（快照钉进静态前缀）
   * 两种模式。融合提取（EX-04）让术语表在翻译途中一直生长，两者的前提都不成立：
   * subset 的每章行集合都不同，前缀缓存章章落空；frozen 的「表不变」假设直接被推翻，
   * 于是每长几个词就要「重钉」一次，冻结的收益被重钉吃掉。
   *
   * 追加序同时解决两件事：跨章一致性（全表都在）与缓存命中（前缀只增不改）。
   */
  it("全表注入：本章不出现的术语也在，两章的 system 完全相同", async () => {
    const first = await capture("ch001", base);
    const second = await capture("ch002", base);
    expect(first.system).toContain("- アリス → 爱丽丝");
    expect(first.system).toContain("- ボブ → 鲍勃");
    expect(second.system).toBe(first.system);
    expect(first.system).not.toContain("术语表:\n（无）");
  });

  it("追加序：新词只往后追加，旧 system 整体仍是新 system 的字节级前缀", async () => {
    const before = await capture("ch001", base);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "terminology", "names.json"),
      JSON.stringify([
        { ja: "アリス", zh: "爱丽丝", type: "name" },
        { ja: "ボブ", zh: "鲍勃", type: "name" },
        { ja: "キャロル", zh: "卡萝", type: "name" },
      ])
    );
    const after = await capture("ch001", base);
    expect(after.system).toContain("- キャロル → 卡萝");
    expect(before.system).not.toContain("キャロル");
    // 这一条就是追加序的全部意义：缓存边界只前进不后退
    expect(after.system.startsWith(before.system)).toBe(true);
  });

  it("排序会毁掉前缀缓存——所以注入顺序必须逐字等于仓库档案序", async () => {
    const { writeFileSync } = await import("node:fs");
    // 故意用非字典序写入：アリス(a) → ボブ(b) → キャロル(k)，按 ja 排序会把キャロル排到中间
    writeFileSync(
      join(dir, "terminology", "names.json"),
      JSON.stringify([
        { ja: "ボブ", zh: "鲍勃", type: "name" },
        { ja: "アリス", zh: "爱丽丝", type: "name" },
      ])
    );
    const { system } = await capture("ch001", base);
    expect(system.indexOf("- ボブ → 鲍勃")).toBeLessThan(system.indexOf("- アリス → 爱丽丝"));
  });
});


describe("R2-2 人设合流", () => {
  const config = {
    project: { name: "t", srcLang: "ja", tgtLang: "zh" },
    agents: {},
    translation: { mode: "balanced" as const, concurrency: 1, batchChars: 2000 },
  };

  it("语气档案投影进人名注入行", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "terminology", "names.json"), JSON.stringify([{ ja: "アリス", zh: "爱丽丝", type: "name" }]));
    writeFileSync(
      join(dir, "terminology", "voice.json"),
      JSON.stringify([{ character: "アリス", selfRefJa: "私", selfRefZh: "我", politeStyle: "polite" }])
    );
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages[0]!.content;
        return { text: '<paragraph id="p0001">第1章</paragraph>\n<paragraph id="p0002">译文</paragraph>' };
      },
    };
    await translateChapterToFile(ws, "ch001", llm as never, config);
    expect(system).toContain("- アリス → 爱丽丝（敬体，自称：私→我）");
  });

  it("无语气档案 → 注入行退回原样（不因为空人设多出括号）", async () => {
    let system = "";
    const llm = {
      complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
        system = messages[0]!.content;
        return { text: '<paragraph id="p0001">第1章</paragraph>\n<paragraph id="p0002">译文</paragraph>' };
      },
    };
    await translateChapterToFile(ws, "ch001", llm as never, config);
    expect(system).toContain("- アリス → 爱丽丝");
    expect(system).not.toContain("爱丽丝（");
  });

});

// ===== 融合提取（工具通道）=====
describe("融合提取", () => {
  const config = {
    project: { name: "t", srcLang: "ja", tgtLang: "zh" },
    agents: {},
    translation: { mode: "balanced" as const, concurrency: 1, batchChars: 2000 },
  };

  it("工具登记的词进 newTerms，且一个字都不进译文", async () => {
    const llm = toolLlm({
      terms: [
        { ja: "アリス", zh: "爱丽丝", type: "person" },
        { ja: "こんにちは", zh: "你好", type: "other" },
      ],
      render: (id) => (id === "p0001" ? "第1章" : "「你好。」爱丽丝说道。"),
    });
    const r = await translateChapterToFile(ws, "ch001", llm as never, config);
    // アリス 已在 names.json 里 → 累积词表去重挡下；こんにちは 是本章新词
    expect(r.newTerms.map((t) => t.ja)).toEqual(["こんにちは"]);
    expect(r.translation).not.toContain("===TERMS===");
    expect(r.translation).not.toContain('"terms"');
    const onDisk = await readFile(join(dir, "translations", "ch001_zh.md"), "utf-8");
    expect(onDisk).not.toContain("===TERMS===");
  });

  it("原文里没有的登记词被补救层丢弃——模型说什么不算数", async () => {
    const llm = toolLlm({
      terms: [{ ja: "竜王バハムート", zh: "龙王巴哈姆特", type: "person" }],
      render: (id) => (id === "p0001" ? "第1章" : "「你好。」爱丽丝说道。"),
    });
    const r = await translateChapterToFile(ws, "ch001", llm as never, config);
    expect(r.newTerms).toEqual([]);
  });

  it("工具参数不可用时译文照常入盘（增量是附带品，不能连累主产物）", async () => {
    const llm = toolLlmWithRawArgs("坏数据" as never, (id) => (id === "p0001" ? "第1章" : "「你好。」爱丽丝说道。"));
    const r = await translateChapterToFile(ws, "ch001", llm as never, config);
    expect(r.translation).toContain("爱丽丝");
    expect(r.newTerms).toEqual([]);
    expect(existsSync(join(dir, "translations", "ch001_zh.md"))).toBe(true);
  });

  it("模型不调工具时按无新词走（提取缺席不是失败）", async () => {
    const llm = toolLlm({ skipTool: true, render: (id) => (id === "p0001" ? "第1章" : "「你好。」爱丽丝说道。") });
    const r = await translateChapterToFile(ws, "ch001", llm as never, config);
    expect(r.translation).toContain("爱丽丝");
    expect(r.newTerms).toEqual([]);
  });
});

describe("融合登记词落档（ADR-0008 登记即注入）", () => {
  it("带译法的登记词直写档案（provenance=model），不再进待办队列", async () => {
    const llm = toolLlm({
      terms: [{ ja: "こんにちは", zh: "你好", type: "other", note: "日常问候" }],
      render: (id) => (id === "p0001" ? "第1章" : "「你好。」爱丽丝说道。"),
    });
    const r = await translateChapterToFile(ws, "ch001", llm as never, {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced" as const, concurrency: 1, batchChars: 2000 },
    });
    expect(r.newTerms.map((t) => t.ja)).toEqual(["こんにちは"]);
    // 旧契约是进 pending-terms.json 等确认——12 章实测（evidence-1786585063380）证明
    // 那条路的结局是档案空转、注入块全程「（无）」。新契约：立即进档案、立即可注入。
    const { TerminologyRepository } = await import("@lightee/core/terminology-repository");
    const snapshot = await new TerminologyRepository(dir).readSnapshot();
    const row = snapshot.archives.terms.find((entry) => entry.ja === "こんにちは");
    expect(row).toMatchObject({ zh: "你好", provenance: "model" });
    // 待办队列不再收它：同一个词又在档案又在卡片，两处状态迟早打架
    expect(existsSync(join(dir, "state", "pending-terms.json"))).toBe(false);
  });

  it("双关仍走卡片闸门：策略（直译+注/换梗/保留）是作者裁量，不落档", async () => {
    // ja 必须逐字存在于章节原文、且不在术语档案里——否则先被补救层
    // （防幻觉子串校验 / 已知词去重）拦住，测的就不是双关路由而是那两道防线了。
    const llm = toolLlm({
      terms: [{ ja: "こんにちは", zh: "你好呀", type: "pun", note: "谐音梗" }],
      render: (id) => (id === "p0001" ? "第1章" : "「你好。」爱丽丝说道。"),
    });
    await translateChapterToFile(ws, "ch001", llm as never, {
      project: { name: "t", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced" as const, concurrency: 1, batchChars: 2000 },
    });
    const { TerminologyRepository } = await import("@lightee/core/terminology-repository");
    const snapshot = await new TerminologyRepository(dir).readSnapshot();
    expect(snapshot.archives.puns).toHaveLength(0);
    expect(snapshot.archives.terms.find((entry) => entry.ja === "こんにちは")).toBeUndefined();
    // 走的是待办队列 → 卡片
    const pending = JSON.parse(await readFile(join(dir, "state", "pending-terms.json"), "utf-8"));
    expect(pending).toEqual([expect.objectContaining({ ja: "こんにちは", zh: "你好呀", chapterId: "ch001" })]);
    const { promotePendingTerms } = await import("../src/pending-terms.ts");
    const promoted = await promotePendingTerms(ws);
    expect(promoted.added).toBe(1);
    const session = JSON.parse(await readFile(join(dir, "state", "confirm-session.json"), "utf-8"));
    expect(session.cards[0].candidates[0].zh).toBe("你好呀");
    // 译注内容一路走到卡片：这条链断掉的时候，档案里存的是一句
    // 「译者在 ch001 翻译本章时登记的新术语（pun）。」，下一章照着它往正文里印。
    expect(session.cards[0].note).toBe("谐音梗");
    // context 是原文里的首现片段，不是说明的备胎
    expect(session.cards[0].context).toContain("こんにちは");
  });
});

describe("buildChapterPunBlock（后续章节的译注注入）", () => {
  it("写了译注 → 要求译法之后紧跟（译注: 内容）", async () => {
    const { buildChapterPunBlock } = await import("../src/translate-one.ts");
    const block = buildChapterPunBlock(
      [{ ja: "灯ヒナ", zh: "小灯", note: "与「桧山灯」同音" }],
      "「灯ヒナって呼んで」",
    );
    expect(block).toContain("紧跟（译注: 与「桧山灯」同音）");
  });

  it("译注留空 → 只要求译法，不要求印一对空括号", async () => {
    const { buildChapterPunBlock } = await import("../src/translate-one.ts");
    const block = buildChapterPunBlock([{ ja: "灯ヒナ", zh: "小灯" }], "「灯ヒナって呼んで」");
    expect(block).toContain("（不加译注）");
    expect(block).not.toContain("（译注: ）");
  });

  it("本章原文里没有的梗不进注入块", async () => {
    const { buildChapterPunBlock } = await import("../src/translate-one.ts");
    expect(buildChapterPunBlock([{ ja: "灯ヒナ", zh: "小灯", note: "x" }], "今日はいい天気。")).toBe("");
  });
});
