/**
 * source-classify 测试：来源可信度分类。
 */
import { describe, it, expect } from "vitest";
import { classifySource } from "../src/source-classify.ts";

describe("source-classify", () => {
  it("官方域名/标题 → official", () => {
    expect(classifySource("https://kadokawa.jp/book/angel")).toBe("official");
    expect(classifySource("https://example.com/", "屋上之灯 官方中文版")).toBe("official");
  });

  it("社区/百科 → community", () => {
    expect(classifySource("https://zh.wikipedia.org/angel")).toBe("community");
    expect(classifySource("https://tieba.baidu.com/thread/1")).toBe("community");
    expect(classifySource("https://bbs.example.com/t")).toBe("community");
  });

  it("机翻站 → machine（降权）", () => {
    expect(classifySource("https://auto-novel.example/angel")).toBe("machine");
    expect(classifySource("https://example.com/", "某小说 AI翻译版")).toBe("machine");
  });

  it("无法判定 → unknown", () => {
    expect(classifySource("https://some-random-site.example/page")).toBe("unknown");
  });

  it("优先级：机翻 > 官方 > 社区（冲突时降权优先）", () => {
    // 机翻站标题带官方字样 → 机翻优先（防伪装）
    expect(classifySource("https://mtlnovel.example/angel", "官方中文版")).toBe("machine");
  });
});
