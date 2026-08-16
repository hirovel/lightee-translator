/**
 * TR-06：prompt 三改的回归。
 *
 * 依据是真实跑批里读出来的思考内容（炸的 10 条 vs 正常 33 条）：
 *
 * | 思考中的行为        | 炸    | 正常 | 倍数 |
 * |--------------------|-------|------|------|
 * | 复述原文（假名）    | 1554  | 23   | 66×  |
 * | 自我推翻            | 6.0   | 0.3  | 20×  |
 * | 纠结输出格式        | 8.3   | 0.9  | 9×   |
 * | 纠结术语要不要登记  | 5.0   | 0.9  | 5.5× |
 *
 * 炸的那些把原文抄进思考、在里面完整译一遍、再推翻改写，然后才往外吐——
 * 同一份劳动做了两次，预算烧在第一遍上（实测思考 13447 字符 / 正文 174 字符）。
 *
 * 最有价值的一条断言是**样例必须能通过我们自己的解析器**：
 * 给模型看一个我们都解析不了的样例，比不给样例更糟。
 */
import { describe, expect, test } from "vitest";
import { buildTranslatorStaticPrefix, DEFAULT_GUIDE } from "../src/translate-one.ts";
import { gateTranslationOutput } from "../src/paragraph-gate.ts";
import { FUSED_EXAMPLE } from "@lightee/core/extract-fuse";
import { REGISTER_TERMS_TOOL } from "../src/register-terms.ts";

const PREFIX_BASE = { mode: "translate" as const, guide: DEFAULT_GUIDE, outputRule: "【输出格式】…", styleAnchor: "" };

describe("样例本身必须是合法产物", () => {
  test("样例能通过段落门禁——id/顺序/数量与样例原文一一对应", () => {
    const gate = gateTranslationOutput(FUSED_EXAMPLE.output, [...FUSED_EXAMPLE.ids]);
    expect(gate.errors).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  test("样例里没有术语尾块——格式说明书是工具 schema，不是散文（KA-5）", () => {
    expect(FUSED_EXAMPLE.output).not.toContain("===TERMS===");
    expect(FUSED_EXAMPLE.output).not.toContain('"terms"');
  });
});

describe("规则文本", () => {
  test("不再要求模型自己去重——那两条判据代码里已经做了（DroppedTerm.reason: known/duplicate）", () => {
    expect(REGISTER_TERMS_TOOL.description).not.toContain("重复登记");
  });

  test("prompt 里没有术语登记的格式指令：形状由 schema 保证（KA-5）", () => {
    const prefix = buildTranslatorStaticPrefix(PREFIX_BASE);
    expect(prefix).not.toContain("===TERMS===");
    expect(prefix).not.toContain("【术语登记】");
  });

  test("写明思考的禁区：不复述原文、不在思考里起草译文", () => {
    const prefix = buildTranslatorStaticPrefix(PREFIX_BASE);
    expect(prefix).toContain("不要在思考中");
    expect(prefix).toMatch(/复述|抄写|誊/);
  });

  test("样例进静态前缀——它对每一章都相同，才落得进前缀缓存边界（EX-05）", () => {
    const prefix = buildTranslatorStaticPrefix(PREFIX_BASE);
    expect(prefix).toContain(FUSED_EXAMPLE.output);
  });

  test("静态前缀对不同章节逐字相同：缓存边界是省钱的前提，实测命中 74%", () => {
    const a = buildTranslatorStaticPrefix(PREFIX_BASE);
    const b = buildTranslatorStaticPrefix({ ...PREFIX_BASE });
    expect(a).toBe(b);
  });
});
