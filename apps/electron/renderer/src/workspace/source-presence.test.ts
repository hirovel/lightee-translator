import { describe, expect, it } from "vitest";
import { hasAuthorVisibleSource, hasBodyLine } from "./source-presence.js";

/** RH-05 / M-8：空原文引导的判定不得把真实正文误判为空 */
describe("hasAuthorVisibleSource", () => {
  it("单字符正文段是真实原文（M-8：原 length > 1 判据会误判为空）", () => {
    expect(hasAuthorVisibleSource([{ source: "# 第1章" }, { source: "…" }])).toBe(true);
    expect(hasAuthorVisibleSource([{ source: "─" }])).toBe(true);
  });

  it("仅标题 / 仅空白 → 无原文", () => {
    expect(hasAuthorVisibleSource([{ source: "# 第1章 空章节" }])).toBe(false);
    expect(hasAuthorVisibleSource([{ source: "#无空格标题" }])).toBe(false);
    expect(hasAuthorVisibleSource([{ source: "   \n\n  " }])).toBe(false);
    expect(hasAuthorVisibleSource([])).toBe(false);
  });

  it("标题与正文同段（单换行不分段）仍算有原文", () => {
    expect(hasBodyLine("# 第1章 标题\n本文がある。")).toBe(true);
    expect(hasBodyLine("# 第1章 标题\n")).toBe(false);
  });
});
