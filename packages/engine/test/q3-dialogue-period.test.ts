/**
 * 译后字典的正则规则机制（L0）。
 *
 * 历史：这里原本测的是两条**内置播种**的对话标点规则（句末补句号 / 「吗」补问号）。
 * 那两条已于 2026-08-13 按作者裁定撤销播种——它们是从一本书的实测语料里总结出来的
 * 写作偏好，不是中文排印通则，不该替所有作者做主，何况它会直接改写译文。
 *
 * 规则没了，**机制还在**：作者可以在译后字典里自己写同样形状的规则。
 * 因此本文件改测机制本身，夹具就用当年那两条规则的写法——它们仍是这类规则的典型样例。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace } from "../src/workspace.ts";
import { applyPostTransforms } from "../src/post-transform.ts";
import { SEEDED_POST_DICT_RULES } from "../src/seed-rules.ts";
import type { DictRule } from "../src/dictionary.ts";

/** 作者自定：整段引语句末无标点 → 补句号 */
const PERIOD_RULE: DictRule = {
  find: "^(“[^”\\n\\r]*[^”。！？!?…～—，、：；\\n\\r])”(?=\\r?$)",
  replace: "$1。”",
  type: "regex",
  enabled: true,
};
/** 作者自定：「吗」结尾 → 补问号。顺序必须排在句号规则之前 */
const QUESTION_RULE: DictRule = {
  find: "^(“[^”\\n\\r]*吗)”(?=\\r?$)",
  replace: "$1？”",
  type: "regex",
  enabled: true,
};
const RULES: DictRule[] = [QUESTION_RULE, PERIOD_RULE];
const run = (text: string): string => applyPostTransforms(text, { quoteStyle: "zh", postDict: RULES });

describe("译后字典：正则规则的执行机制", () => {
  it("命中即替换（$1 捕获原样带回）", () => {
    expect(run("“喂我”")).toBe("“喂我。”");
    expect(run("“唔嗯，好好吃，辽君”")).toBe("“唔嗯，好好吃，辽君。”");
  });

  it("字符类排除项不被命中 → 已有句末标点的原样不动", () => {
    for (const text of ["“好好吃呢，辽君。”", "“真的吗？”", "“住手！”", "“那个……”", "“等一下——”", "“嗯～”"]) {
      expect(run(text)).toBe(text);
    }
  });

  it("行锚点生效：引语后接叙述不算整行命中", () => {
    expect(run("“我知道了”她轻声说。")).toBe("“我知道了”她轻声说。");
    expect(run("她说：“我知道了”")).toBe("她说：“我知道了”");
  });

  it("空匹配不产生改动", () => {
    expect(run("“”")).toBe("“”");
  });

  it("多行文本逐行判定", () => {
    expect(run("“第一句”\n“第二句。”")).toBe("“第一句。”\n“第二句。”");
  });

  it("CRLF 行尾不被前瞻吃掉", () => {
    expect(run("“第一句”\r\n“第二句”")).toBe("“第一句。”\r\n“第二句。”");
  });

  it("幂等：连跑两次结果不变", () => {
    const once = run("“喂我”\n“再来一口”");
    expect(run(once)).toBe(once);
  });

  it("enabled:false 的规则不执行（停用开关是真的）", () => {
    const disabled = [{ ...PERIOD_RULE, enabled: false }];
    expect(applyPostTransforms("“喂我”", { quoteStyle: "zh", postDict: disabled })).toBe("“喂我”");
  });

  it("次序即优先级：问号规则排在前面，「吗」不会被补成句号", () => {
    expect(run("“桧山灯你不是有健全的双手吗”")).toBe("“桧山灯你不是有健全的双手吗？”");
    const once = run("“真的吗”\n“喂我”");
    expect(once).toBe("“真的吗？”\n“喂我。”");
    expect(run(once)).toBe(once);
  });

  it("管线次序：先引号映射再走字典，日式引号原文同样被覆盖", () => {
    expect(run("「喂我」")).toBe("“喂我。”");
  });
});

describe("新建工作区播种", () => {
  it("译后字典建成空表——软件不预先替作者写任何改写译文的规则", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lightee-seed-"));
    try {
      await createWorkspace(dir, { name: "播种测试" });
      const rows = JSON.parse(await readFile(join(dir, "terminology", "post-dict.json"), "utf8")) as unknown[];
      expect(rows).toEqual([]);
      expect(SEEDED_POST_DICT_RULES).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("已有译后字典的工作区不被覆盖（重复 createWorkspace 不重复播种）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lightee-seed-"));
    try {
      await createWorkspace(dir, { name: "播种测试" });
      // 作者自己写了一条规则；再次打开工作区不该把它冲掉
      const path = join(dir, "terminology", "post-dict.json");
      const mine = [{ id: "mine-1", find: "甲", replace: "乙", type: "literal", enabled: true, status: "confirmed" }];
      await (await import("node:fs/promises")).writeFile(path, `${JSON.stringify(mine, null, 2)}\n`, "utf8");
      await createWorkspace(dir, { name: "播种测试" });
      const rows = JSON.parse(await readFile(path, "utf8")) as Array<{ id: string }>;
      expect(rows.map((row) => row.id)).toEqual(["mine-1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
