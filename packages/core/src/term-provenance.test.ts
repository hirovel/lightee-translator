import { describe, expect, it } from "vitest";
import { termProvenance, withProvenance, type TermProvenance } from "./term-provenance.js";

describe("termProvenance", () => {
  it("缺省 = author：存量档案全是作者确认过的，不能把它们降级成暂定", () => {
    expect(termProvenance({ ja: "旧词", zh: "旧译" })).toBe("author");
  });

  it("model 原样读出", () => {
    expect(termProvenance({ ja: "新词", zh: "新译", provenance: "model" })).toBe("model");
  });

  it("author 原样读出", () => {
    expect(termProvenance({ ja: "词", provenance: "author" })).toBe("author");
  });

  it("认不出的值当 author：宁可少标暂定，不可把作者定稿标成暂定", () => {
    expect(termProvenance({ ja: "词", provenance: "llm" })).toBe("author");
    expect(termProvenance({ ja: "词", provenance: 1 })).toBe("author");
  });

  it("与旧闸门语义正交：pending/status 不影响 provenance 的判读", () => {
    // pending 是「不生效等确认」（ADR-0008 已废的闸门）；provenance 是「已生效未终审」。
    // 两者读的是不同的字段，谁也不该从谁推导。
    expect(termProvenance({ ja: "词", pending: true, status: "pending_review" })).toBe("author");
    expect(termProvenance({ ja: "词", pending: true, provenance: "model" })).toBe("model");
  });
});

describe("withProvenance", () => {
  it("盖章不丢字段", () => {
    const entry = { ja: "星の乙女", zh: "星之圣女", type: "title", note: "备注" };
    const stamped = withProvenance(entry, "model");
    expect(stamped).toEqual({ ...entry, provenance: "model" });
    // 原对象不被改：仓库的 clone 纪律
    expect((entry as Record<string, unknown>).provenance).toBeUndefined();
  });

  it("重复盖章幂等", () => {
    const once = withProvenance({ ja: "a" }, "author");
    expect(withProvenance(once, "author")).toEqual(once);
  });

  it("终审翻面：model → author", () => {
    const provisional = withProvenance({ ja: "a", zh: "甲" }, "model");
    const finalized = withProvenance(provisional, "author");
    expect(termProvenance(finalized)).toBe("author" satisfies TermProvenance);
  });
});
