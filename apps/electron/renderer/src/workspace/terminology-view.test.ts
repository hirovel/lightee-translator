import { describe, expect, it } from "vitest";
import { termBadgeView, termListEmptyText } from "./terminology-view.js";

/**
 * 术语状态是**三态**：未提取 / 待确认 N 项 / 已确认。
 *
 * 徽标此前只有两态（`pending > 0 ? N : "✓"`），于是「从未提取过」——待确认自然是 0——
 * 被显示成了 ✓。用户看到对勾、旁边却写着「未开始」，正是这个压缩造成的。
 * 「没有待确认项」不等于「已完成」，零值有两种截然不同的含义。
 */
describe("术语徽标三态", () => {
  it("从未提取 → 不是 ✓", () => {
    const view = termBadgeView("not-extracted", 0);
    expect(view.text).not.toBe("✓");
    expect(view.tone).toBe("idle");
    expect(view.title).toContain("尚未");
  });

  it("有待确认项 → 显示数量并告警", () => {
    const view = termBadgeView("pending", 5);
    expect(view.text).toBe("5");
    expect(view.tone).toBe("warn");
  });

  it("已确认 → 才是 ✓", () => {
    const view = termBadgeView("confirmed", 0);
    expect(view.text).toBe("✓");
    expect(view.tone).toBe("ok");
  });

  it("状态为 pending 但计数为 0 → 仍不算完成（会话尚未产出卡片）", () => {
    expect(termBadgeView("pending", 0).tone).not.toBe("ok");
  });

  it("提取进行中 → 单独一态，不冒充完成", () => {
    const view = termBadgeView("extracting", 0);
    expect(view.tone).toBe("busy");
    expect(view.text).not.toBe("✓");
  });
});

describe("侧栏术语表空态", () => {
  it("三种空的原因给三种说明——空列表不该只是一片空白", () => {
    const texts = new Set([
      termListEmptyText("not-extracted"),
      termListEmptyText("extracting"),
      termListEmptyText("confirmed"),
    ]);
    expect(texts.size).toBe(3);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
  });

  it("未提取时说清楚下一步动作，且指的是真实存在的那个动作", () => {
    const text = termListEmptyText("not-extracted");
    expect(text).toContain("翻译");
    // EX-07 之后「扫描术语」这个动作已经不存在了。指着一个没有的按钮让人去点，
    // 比不解释更糟——用户会找那个按钮，找不到就以为是自己的问题。
    expect(text).not.toContain("扫描");
  });
});
