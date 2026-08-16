import { describe, expect, it } from "vitest";
import { checkEditorMount, type PanelSurface } from "./editor-invariant.js";

/**
 * RH-12 / renderer-dom-ownership.md §3：`bi` tab 激活 ∧ 有当前章节 ⟹
 * 存活编辑器会话 ∨ 显式空态/加载中/错误界面。**空白 `#bpanel` 不是合法状态。**
 */
const EMPTY_SHELL: PanelSurface = { hasEditorHost: true, hasExplicitSurface: false };
const MOUNTED: PanelSurface = { hasEditorHost: true, hasExplicitSurface: false };
const BLANK: PanelSurface = { hasEditorHost: false, hasExplicitSurface: false };
const EXPLICIT: PanelSurface = { hasEditorHost: false, hasExplicitSurface: true };
const OTHER_PANEL: PanelSurface = { hasEditorHost: false, hasExplicitSurface: false };

describe("editor mount invariant", () => {
  it("DEF-01 的原始形态：bi + 有章节 + 会话已销毁 + 空壳 host 仍在 → 违反", () => {
    const verdict = checkEditorMount({ tab: "bi", hasChapter: true, hasLiveSession: false, surface: EMPTY_SHELL });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("空壳");
  });

  it("面板被整体清空（连空壳都没有）→ 违反", () => {
    const verdict = checkEditorMount({ tab: "bi", hasChapter: true, hasLiveSession: false, surface: BLANK });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("显式空态");
  });

  it("会话存活且宿主在面板内 → 合法", () => {
    expect(checkEditorMount({ tab: "bi", hasChapter: true, hasLiveSession: true, surface: MOUNTED }).ok).toBe(true);
  });

  it("会话自称存活但宿主已被覆盖 → 违反（输入会写进一个看不见的编辑器）", () => {
    const verdict = checkEditorMount({ tab: "bi", hasChapter: true, hasLiveSession: true, surface: OTHER_PANEL });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("已被覆盖");
  });

  it("显式空态/加载中/错误界面是合法终态（无会话也不算违反）", () => {
    expect(checkEditorMount({ tab: "bi", hasChapter: true, hasLiveSession: false, surface: EXPLICIT }).ok).toBe(true);
  });

  it.each(["terms", "review", "agent"])("非 bi tab（%s）不适用本不变式", (tab) => {
    expect(checkEditorMount({ tab, hasChapter: true, hasLiveSession: false, surface: BLANK }).ok).toBe(true);
  });

  it("没有当前章节时不适用（空工作区引导由另一条路径负责）", () => {
    expect(checkEditorMount({ tab: "bi", hasChapter: false, hasLiveSession: false, surface: BLANK }).ok).toBe(true);
  });

  it("面板尚未挂载时不适用——工作台外壳还没渲染出来", () => {
    expect(checkEditorMount({ tab: "bi", hasChapter: true, hasLiveSession: false, surface: null }).ok).toBe(true);
  });
});
