import { describe, expect, it } from "vitest";
import { liveWritingPosition, type LiveProgressInput } from "./live-progress.js";

const base: LiveProgressInput = { paragraphId: "p0119", total: 125, state: "translating", running: true };

describe("liveWritingPosition", () => {
  it("把段落 id 换算成 第 N/总 段", () => {
    expect(liveWritingPosition(base)).toEqual({
      position: 119,
      total: 125,
      percent: 95,
      value: "119/125",
      detail: "正在写第 119 段 · 落盘后才计入已译",
    });
  });

  it("首段就有位置——不必等第二段才显示", () => {
    expect(liveWritingPosition({ ...base, paragraphId: "p0001" })?.position).toBe(1);
  });

  it("没有正文流时不给数字：宁可不显示，也不显示一个编出来的进度", () => {
    expect(liveWritingPosition({ ...base, paragraphId: "" })).toBeNull();
  });

  // 这条断言原先写的是「running=false → 返回 null」。演示台回放后发现那样会让这一格
  // 从 0 冲到 120 再掉回 0——看起来像坏了。流停了但还没落盘，是一个**真实存在的中间态**，
  // 该说清楚而不是抹掉。
  it("流停了但还没落盘 → 说「已写完 · 正在落盘」，不掉回 0", () => {
    expect(liveWritingPosition({ ...base, running: false })).toEqual({
      position: 119,
      total: 125,
      percent: 95,
      value: "119/125",
      detail: "已写完 119 段 · 正在落盘",
    });
  });

  it("从没流过正文（没有段号）→ 仍然返回 null，不无中生有", () => {
    expect(liveWritingPosition({ ...base, running: false, paragraphId: "" })).toBeNull();
  });

  it("总段数未知（0）→ 不给百分比也不给分母", () => {
    expect(liveWritingPosition({ ...base, total: 0 })).toBeNull();
  });

  it("已定稿的章节不显示活动位置", () => {
    expect(liveWritingPosition({ ...base, state: "approved" })).toBeNull();
  });

  it("段号超出总数 → 夹紧到总数，不显示 130/125 这种自相矛盾的数", () => {
    const result = liveWritingPosition({ ...base, paragraphId: "p0130" });
    expect(result?.position).toBe(125);
    expect(result?.percent).toBe(100);
  });

  it("认不出的段号 → 当作没有位置，不猜", () => {
    expect(liveWritingPosition({ ...base, paragraphId: "第三段" })).toBeNull();
    expect(liveWritingPosition({ ...base, paragraphId: "p" })).toBeNull();
    expect(liveWritingPosition({ ...base, paragraphId: "p0000" })).toBeNull();
  });

  it("百分比取整，且不会因为四舍五入在写完前就显示 100%", () => {
    // 124/125 = 99.2% → 99，不能进位成 100：那会让人以为写完了
    expect(liveWritingPosition({ ...base, paragraphId: "p0124" })?.percent).toBe(99);
    expect(liveWritingPosition({ ...base, paragraphId: "p0125" })?.percent).toBe(100);
  });
});

describe("位次优先于 id 编号（段落 id 是身份，不是序号）", () => {
  it("作者在中间插过段：id 是 p0126、位置在第 2 → 显示 2 而不是 126", () => {
    const live = liveWritingPosition({
      paragraphId: "p0126",
      index: 2,
      total: 125,
      state: "translating",
      running: true,
    });
    expect(live?.position).toBe(2);
  });

  it("查不到位次时退回解析 id（一次成型的章节上这仍是对的）", () => {
    const live = liveWritingPosition({
      paragraphId: "p0045",
      total: 125,
      state: "translating",
      running: true,
    });
    expect(live?.position).toBe(45);
  });
});
