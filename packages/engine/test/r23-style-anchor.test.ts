/**
 * R2-3 风格锚定 v1：作者提供的目标语参考文本进静态前缀。
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_GUIDE,
  STYLE_ANCHOR_MAX_TOKENS,
  buildStyleAnchor,
  buildTranslatorStaticPrefix,
} from "../src/translate-one.ts";

const PREFIX_BASE = { guide: DEFAULT_GUIDE, outputRule: "【输出格式】x" };

describe("buildStyleAnchor", () => {
  it("正常长度原样保留，标注未截断", () => {
    const anchor = buildStyleAnchor("夜色沉下来，风把窗帘吹得鼓起。");
    expect(anchor.truncated).toBe(false);
    expect(anchor.text).toBe("夜色沉下来，风把窗帘吹得鼓起。");
  });

  it("超限按段落边界截断并标注", () => {
    const paragraph = "这是一段用来占位的中文示例文本，长度足够撑到上限之外。";
    const long = Array.from({ length: 400 }, () => paragraph).join("\n\n");
    const anchor = buildStyleAnchor(long);
    expect(anchor.truncated).toBe(true);
    expect(anchor.tokens).toBeLessThanOrEqual(STYLE_ANCHOR_MAX_TOKENS);
    // 段落边界截断：不会切在句子中间
    expect(anchor.text.endsWith(paragraph)).toBe(true);
  });

  it("单段就超限时硬切（否则整段丢失，等于锚定没生效）", () => {
    const anchor = buildStyleAnchor("字".repeat(20000));
    expect(anchor.truncated).toBe(true);
    expect(anchor.tokens).toBeLessThanOrEqual(STYLE_ANCHOR_MAX_TOKENS);
    expect(anchor.text.length).toBeGreaterThan(0);
  });

  it("空白输入 → 无锚", () => {
    expect(buildStyleAnchor("   \n\n ").text).toBe("");
    expect(buildStyleAnchor(undefined).text).toBe("");
  });
});

describe("静态前缀里的风格参照", () => {
  it("有锚时插在翻译指南之后、输出格式之前（EX-08：新术语规则已退役）", () => {
    const prefix = buildTranslatorStaticPrefix({ ...PREFIX_BASE, styleAnchor: "夜色沉下来。" });
    expect(prefix).toContain("【风格参照】");
    expect(prefix).toContain("夜色沉下来。");
    expect(prefix.indexOf("【翻译指南】")).toBeLessThan(prefix.indexOf("【风格参照】"));
    expect(prefix.indexOf("【风格参照】")).toBeLessThan(prefix.indexOf("【输出格式】"));
  });

  it("参照文本被明确标注为「不得抄用内容」", () => {
    const prefix = buildTranslatorStaticPrefix({ ...PREFIX_BASE, styleAnchor: "夜色沉下来。" });
    expect(prefix).toContain("不得抄用其内容");
  });

  it("无锚时前缀与不带该字段时逐字节相同（缓存不白失效）", () => {
    const without = buildTranslatorStaticPrefix(PREFIX_BASE);
    expect(buildTranslatorStaticPrefix({ ...PREFIX_BASE, styleAnchor: "" })).toBe(without);
    expect(buildTranslatorStaticPrefix({ ...PREFIX_BASE, styleAnchor: "  \n " })).toBe(without);
  });
});
