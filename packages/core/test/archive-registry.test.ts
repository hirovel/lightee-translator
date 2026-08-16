/**
 * archive-registry 测试：声明式档案注册表。
 */
import { describe, it, expect } from "vitest";
import { ARCHIVES, archiveEntryToPrompt, checkArchiveAdherence } from "../src/archive-registry.ts";

describe("archive-registry", () => {
  it("已登记 5 类档案（含 puns）", () => {
    expect(Object.keys(ARCHIVES).sort()).toEqual(["names", "onomatopoeia", "puns", "terms", "voice"]);
  });

  it("puns 档案：confirm 卡 + 注入格式", () => {
    const pun = ARCHIVES["puns"]!;
    expect(pun.cardKind).toBe("confirm");
    const line = archiveEntryToPrompt("puns", {
      ja: "あかり",
      zh: "小灯",
      note: "「灯（あかり）」与「明かり」同音",
    });
    expect(line).toContain("あかり");
    expect(line).toContain("小灯");
    expect(line).toContain("译注");
  });

  it("puns 档案：译注留空 → 注入行不摆占位文本", () => {
    const line = archiveEntryToPrompt("puns", { ja: "あかり", zh: "小灯" });
    expect(line).toContain("不加译注");
    // 从前留空会印出「译注「（作者确认的处理方案）」」——一句冒充作者决定的占位文本
    expect(line).not.toContain("（作者确认的处理方案）");
  });

  it("puns 档案：写了译注才查译注（译法所在段缺译注 → false）", () => {
    const entry = { ja: "あかり", zh: "小灯", note: "与「明かり」同音" };
    expect(checkArchiveAdherence("puns", "「以后你可以叫我小灯哦。」（译注: 与「明かり」同音）", entry)).toBe(true);
    expect(checkArchiveAdherence("puns", "「以后你可以叫我小灯哦。」", entry)).toBe(false);
  });

  it("puns 档案：译注留空 = 只要求译法统一（界面上一直这么承诺）", () => {
    const entry = { ja: "あかり", zh: "小灯" };
    expect(checkArchiveAdherence("puns", "「以后你可以叫我小灯哦。」", entry)).toBe(true);
    expect(checkArchiveAdherence("puns", "「以后你可以叫我小雏哦。」", entry)).toBe(false);
  });

  it("puns 档案：别处的译注不算数——判据是译法所在的那一段", () => {
    const entry = { ja: "あかり", zh: "小灯", note: "与「明かり」同音" };
    const elsewhere = [
      "他望着窗外的银杏。（译注: 此处指校门口那棵）",
      "「以后你可以叫我小灯哦。」",
    ].join("\n");
    // 从前判据是「整章任何位置出现过（译注:」，上面这段会被判成通过——
    // 绿灯给的是一个它根本没看过的位置。
    expect(checkArchiveAdherence("puns", elsewhere, entry)).toBe(false);
  });

  it("terms 档案：select 卡 + 存在性检查（已有逻辑复用）", () => {
    const terms = ARCHIVES["terms"]!;
    expect(terms.cardKind).toBe("select");
    const ok = checkArchiveAdherence("terms", "黑炎燃烧起来。", { ja: "黒炎", zh: "黑炎" });
    expect(ok).toBe(true);
  });
});
