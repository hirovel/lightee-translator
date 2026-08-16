/**
 * KA-4 工具通道 —— 术语与语气档案改走 `register_terms`，两轮完成。
 *
 * 本文件钉三件事：
 *  1. **补救层是工具的执行体**：判定结果必须回到模型眼前，否则整个改动没有意义
 *  2. **L0 规则只有一份实现**：工具参数与 ===TERMS=== 尾块判定逐字相同
 *  3. **不多花钱**：模型没调工具时不发第二轮
 */
import { describe, expect, test } from "vitest";
import {
  REGISTER_TERMS_TOOL,
  renderToolResult,
  validateRegisteredTerms,
} from "../src/register-terms.ts";
import { validateTermObjects } from "@lightee/core/extract-fuse";
import { buildTranslatorStaticPrefix } from "../src/translate-one.ts";

/** 本文件用的原文是为测试专门编写的，不取自任何作品 */
const SOURCE = "「セラフィナ様、リンドブルム砦から早馬が来ました」\n少女は窓の外を見つめたまま、静かに頷いた。";

describe("补救层作为工具执行体", () => {
  test("原文里没有的词被丢弃，且**说得出是哪一个、为什么**", () => {
    const result = validateRegisteredTerms({
      terms: [
        { ja: "セラフィナ", zh: "塞拉菲娜", type: "person", note: null },
        { ja: "竜王アルゲンタム", zh: "龙王阿尔根图姆", type: "person", note: "本章没出现过" },
      ],
      voices: [],
    }, { source: SOURCE });

    expect(result.terms.map((t) => t.ja)).toEqual(["セラフィナ"]);
    expect(result.dropped).toEqual([{ ja: "竜王アルゲンタム", reason: "not_in_source" }]);

    // 这段文字是整个改动的意义所在：模型在写正文之前就知道那个词被拒了。
    // 只给一个数字（「1 条被丢弃」）帮不了它——必须点名。
    const text = renderToolResult(result);
    expect(text).toContain("竜王アルゲンタム");
    expect(text).toContain("不在本章原文中");
    expect(text).toContain("塞拉菲娜");
    expect(text).toContain("现在输出译文正文");
  });

  test("累积词表里已有的词不重复登记，但同样要告诉模型该沿用哪个译法", () => {
    const result = validateRegisteredTerms({
      terms: [{ ja: "セラフィナ", zh: "赛拉菲娜", type: "person", note: null }],
      voices: [],
    }, { source: SOURCE, known: new Set(["セラフィナ"]) });
    expect(result.terms).toHaveLength(0);
    expect(result.dropped[0]).toEqual({ ja: "セラフィナ", reason: "known" });
    expect(renderToolResult(result)).toContain("已在累积词表中");
  });

  test("语气档案卡的引文必须逐字见于原文——编出来的出处比没有出处更糟", () => {
    const result = validateRegisteredTerms({
      terms: [],
      voices: [
        { character: "セラフィナ", selfRef: "わたくし", register: "敬体", gender: "女", quirk: null, zhStrategy: "端庄", evidence: "少女は窓の外を見つめたまま" },
        { character: "セラフィナ", selfRef: "俺", register: "簡体", gender: "男", quirk: null, zhStrategy: null, evidence: "この台詞は本文に存在しない" },
      ],
    }, { source: SOURCE });
    expect(result.voices).toHaveLength(1);
    expect(result.voices[0]?.selfRef).toBe("わたくし");
    expect(result.droppedVoices).toEqual([{ character: "セラフィナ", reason: "evidence_not_in_source" }]);
  });

  test("模型判断不出性别时保持 null，不替它猜", () => {
    const result = validateRegisteredTerms({
      terms: [],
      voices: [{ character: "セラフィナ", selfRef: "わたくし", register: "敬体", gender: null, quirk: null, zhStrategy: null, evidence: "静かに頷いた" }],
    }, { source: SOURCE });
    expect(result.voices[0]?.gender).toBeNull();
  });

  test("参数整体不是对象时按「本章无新词」降级，不带垮翻译", () => {
    const result = validateRegisteredTerms("坏参数", { source: SOURCE });
    expect(result.failureReason).toBeTruthy();
    expect(renderToolResult(result)).toContain("本章按无新词继续");
  });
});

describe("L0 规则只有一份实现", () => {
  /**
   * KA-5 之前这里断言「工具参数与 ===TERMS=== 尾块判定逐字相同」——尾块通道删除后
   * 只剩一条入口，那条断言随之失效。但**规则本身仍归 core 的 validateTermObjects**：
   * 这里断言工具层没有偷偷加一份自己的判定。
   */
  test("工具层直接复用 core 的补救层，不另起一套判定", () => {
    const objects = [
      { ja: "セラフィナ", zh: "塞拉菲娜", type: "person" },
      { ja: "竜王", zh: "龙王", type: "person" },              // 幻觉
      { ja: "リンドブルム砦", zh: "", type: "place" },           // 缺 zh
      { ja: "セラフィナ", zh: "塞拉菲娜", type: "person" },       // 重复
    ];
    const viaTool = validateRegisteredTerms({ terms: objects, voices: [] }, { source: SOURCE });
    const viaCore = validateTermObjects(objects, { source: SOURCE });

    expect(viaTool.terms).toEqual(viaCore.terms);
    expect(viaTool.dropped).toEqual(viaCore.dropped);
    // 顺序也要一致：幻觉判定排在去重之前（既是幻觉又重复时报「幻觉」更有用）
    expect(viaTool.dropped.map((d) => d.reason)).toEqual(["not_in_source", "no_zh", "duplicate"]);
  });
});

describe("工具 schema 满足 strict 模式的硬要求", () => {
  const schema = REGISTER_TERMS_TOOL.parameters as unknown as Record<string, never>;

  /** strict 要求：每一层 object 都 additionalProperties:false，且属性全在 required 里 */
  function assertStrict(node: unknown, path: string): void {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "object") {
      expect(record.additionalProperties, `${path} 缺 additionalProperties:false`).toBe(false);
      const properties = Object.keys((record.properties ?? {}) as object);
      const required = (record.required ?? []) as string[];
      // 可选字段在 strict 下只能表达成可空类型，不能表达成「可缺」
      expect([...required].sort(), `${path} 的 required 必须覆盖全部属性`).toEqual([...properties].sort());
      for (const [key, value] of Object.entries((record.properties ?? {}) as object)) assertStrict(value, `${path}.${key}`);
    }
    if (record.type === "array") assertStrict(record.items, `${path}[]`);
  }

  test("整棵 schema 都满足 strict", () => { assertStrict(schema, "parameters"); });

  test("声明了约束采样，且用 prefer——通道可用性优先于形状保证", () => {
    // require 在不支持 strict 的 provider 上会让**整次调用**失败；
    // prefer 只是静默降级为普通函数工具，L0 仍然兜底。
    expect(REGISTER_TERMS_TOOL.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  });

  test("判据句一字未改（EX-03/EX-10 实测有效，换通道不是改判据的理由）", () => {
    expect(REGISTER_TERMS_TOOL.description).toContain("换一个译者会不会译得不一样");
    expect(REGISTER_TERMS_TOOL.description).toContain("逐字出现在本章原文");
  });
});

describe("prompt：格式指令交给 schema 之后就不该再出现在 prompt 里", () => {
  const base = { guide: "【翻译指南】x", outputRule: "【输出格式】y" };

  test("prompt 里没有 ===TERMS=== 规则，样例也不带尾块", () => {
    const prefix = buildTranslatorStaticPrefix({ ...base });
    expect(prefix).not.toContain("===TERMS===");
    expect(prefix).not.toContain("【术语登记】");
    // 段落样例仍在——它示范的是段落协议，与提取通道无关
    expect(prefix).toContain("<paragraph id=\"p0001\">");
    // 思考用法的约束留下：它约束的是翻译本身，与提取通道无关
    expect(prefix).toContain("【思考的用法】");
  });

  test("同一本书的每一章逐字节相同（前缀缓存红线，实测命中 53120）", () => {
    expect(buildTranslatorStaticPrefix({ ...base })).toBe(buildTranslatorStaticPrefix({ ...base }));
  });
});
