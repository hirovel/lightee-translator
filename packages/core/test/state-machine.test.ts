import { describe, expect, it } from "vitest";
import {
  advanceState,
  canTransition,
  createChapterStatus,
  shouldEscalateToStuck,
} from "../src/state-machine.js";

describe("状态机", () => {
  it("正常流转：imported → ready → translating → translated → reviewing → approved", () => {
    let s = createChapterStatus("ch001");
    expect(s.state).toBe("imported");

    s = advanceState(s, "ready");
    expect(s.state).toBe("ready");

    s = advanceState(s, "translating");
    expect(s.state).toBe("translating");
    expect(s.lastActivityAt).not.toBeNull();

    s = advanceState(s, "translated");
    expect(s.state).toBe("translated");
    expect(s.version).toBe(1);

    s = advanceState(s, "reviewing");
    expect(s.state).toBe("reviewing");

    s = advanceState(s, "approved");
    expect(s.state).toBe("approved");
  });

  it("非法转移被拒绝", () => {
    const s = createChapterStatus("ch001"); // imported
    expect(() => advanceState(s, "approved")).toThrow(/非法状态转移/);
    expect(() => advanceState(s, "reviewing")).toThrow(/非法状态转移/);
  });

  it("translated 后 version 递增", () => {
    let s = createChapterStatus("ch001");
    s = advanceState(s, "ready");
    s = advanceState(s, "translating");
    s = advanceState(s, "translated");
    expect(s.version).toBe(1);

    // 重新翻译（用户改译文触发）
    s = advanceState(s, "translating");
    s = advanceState(s, "translated");
    expect(s.version).toBe(2);
  });

  it("revising 递增 reviseCount", () => {
    let s = createChapterStatus("ch001");
    s = advanceState(s, "ready");
    s = advanceState(s, "translating");
    s = advanceState(s, "translated");
    s = advanceState(s, "reviewing");
    s = advanceState(s, "revising");
    expect(s.reviseCount).toBe(1);
  });

  it("熔断判定：修订≥1 次仍 high → stuck（RV-03：一轮修不净就交给作者）", () => {
    let s = createChapterStatus("ch001");
    s = { ...s, reviseCount: 1 };
    expect(shouldEscalateToStuck(s, 1)).toBe(true);
    expect(shouldEscalateToStuck(s, 0)).toBe(false);
    expect(shouldEscalateToStuck({ ...s, reviseCount: 0 }, 1)).toBe(false);
  });

  it("stuck 后用户介入可重新出发", () => {
    let s = createChapterStatus("ch001");
    s = { ...s, state: "stuck", reviseCount: 3, userModified: true };
    s = advanceState(s, "translating");
    expect(s.state).toBe("translating");
    expect(s.userModified).toBe(false);
    expect(s.recheckReason).toBeNull();
  });

  it("canTransition 查表正确", () => {
    expect(canTransition("imported", "ready")).toBe(true);
    expect(canTransition("imported", "translating")).toBe(false);
    expect(canTransition("translated", "reviewing")).toBe(true);
    expect(canTransition("reviewing", "revising")).toBe(true);
    expect(canTransition("reviewing", "stuck")).toBe(true); // 熔断升级
    expect(canTransition("approved", "translating")).toBe(true); // 用户改译文
  });
});
