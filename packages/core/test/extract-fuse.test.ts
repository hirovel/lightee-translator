/**
 * 融合提取的补救层（L0）：「模型说什么不算数，原文说了才算」。
 *
 * 判据来自 EX-03 实测：直读提取查全 82%、噪声 0、幻觉 0，但**单次不可靠**
 * （一次调用烧 8189 输出只回 1 个词）。
 *
 * KA-5 之后词项只有一条入口——`register_terms` 工具参数，服务商已按 schema
 * 交付结构。`===TERMS===` 尾块的运输层（哨兵、JSON 打捞、截断救援）随之删除，
 * 那些测试跟着走；**判定规则本身没有变**，下面这些就是它的红线。
 */
import { describe, expect, it } from "vitest";
import { describeDropped, validateTermObjects } from "../src/extract-fuse.js";

const SOURCE = "「レミィ、星の乙女が学園に来た」\nウィリアルドは静かに言った。";

describe("补救层（L0）", () => {
  it("原文里不存在的词一律丢弃并计数——模型说什么不算数，原文说了才算", () => {
    const result = validateTermObjects([
      { ja: "星の乙女", zh: "星之少女", type: "world" },
      { ja: "竜王アルバトロス", zh: "龙王信天翁", type: "person" },
    ], { source: SOURCE });
    expect(result.terms.map((t) => t.ja)).toEqual(["星の乙女"]);
    expect(result.dropped).toEqual([{ ja: "竜王アルバトロス", reason: "not_in_source" }]);
  });

  it("已知词不重复入列（累积词表逐章增长，不是逐章重报）", () => {
    const result = validateTermObjects([
      { ja: "星の乙女", zh: "星之少女", type: "world" },
      { ja: "ウィリアルド", zh: "威利亚德", type: "person" },
    ], { source: SOURCE, known: new Set(["星の乙女"]) });
    expect(result.terms.map((t) => t.ja)).toEqual(["ウィリアルド"]);
    expect(result.dropped).toEqual([{ ja: "星の乙女", reason: "known" }]);
  });

  it("同一批里的重复只保留一条", () => {
    const result = validateTermObjects([
      { ja: "星の乙女", zh: "星之少女", type: "world" },
      { ja: "星の乙女", zh: "星之乙女", type: "world" },
    ], { source: SOURCE });
    expect(result.terms).toHaveLength(1);
    expect(result.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
  });

  it("缺 zh 或 ja 过长的条目丢弃——预填一个坏译法比留空更糟", () => {
    const result = validateTermObjects([
      { ja: "星の乙女", zh: "", type: "world" },
      { ja: "ウィリアルドは静かに言った。ウィリアルドは静かに言った。ウィリアルドは静かに言った", zh: "长", type: "other" },
    ], { source: SOURCE });
    expect(result.terms).toEqual([]);
    // 顺序即判定顺序：ja 过长在取 zh 之前判掉，所以两条各自命中自己的原因
    expect(result.dropped.map((d) => d.reason).sort()).toEqual(["no_zh", "too_long"]);
  });

  it("空数组是有效答案，不是失败（本章确实没有新词）", () => {
    const result = validateTermObjects([], { source: SOURCE });
    expect(result.terms).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("幻觉判定排在去重之前——既是幻觉又重复的词要报「幻觉」", () => {
    const result = validateTermObjects([
      { ja: "竜王アルバトロス", zh: "龙王信天翁", type: "person" },
      { ja: "竜王アルバトロス", zh: "龙王信天翁", type: "person" },
    ], { source: SOURCE });
    expect(result.dropped.map((d) => d.reason)).toEqual(["not_in_source", "not_in_source"]);
  });

  it("type 不在枚举里退到 other，不因此丢词", () => {
    const result = validateTermObjects([
      { ja: "星の乙女", zh: "星之少女", type: "道具" },
    ], { source: SOURCE });
    expect(result.terms).toEqual([{ ja: "星の乙女", zh: "星之少女", type: "other" }]);
  });
});

describe("丢弃告警", () => {
  it("真的丢过幻觉词才报警——不能反过来制造假警报", () => {
    expect(describeDropped([], "ch001")).toBeUndefined();
    expect(describeDropped([{ ja: "星の乙女", reason: "known" }], "ch001")).toBeUndefined();
    const warning = describeDropped([{ ja: "竜王", reason: "not_in_source" }], "ch001");
    expect(warning).toContain("竜王");
    expect(warning).toContain("ch001");
  });
});
