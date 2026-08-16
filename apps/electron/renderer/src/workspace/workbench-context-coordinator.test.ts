import { describe, expect, it } from "vitest";
import { WorkbenchContextCoordinator } from "./workbench-context-coordinator";

describe("WorkbenchContextCoordinator", () => {
  it("starts on the dashboard and returns defensive snapshots", () => {
    const coordinator = new WorkbenchContextCoordinator();
    const snapshot = coordinator.current();
    expect(snapshot).toEqual({ generation: 0, workspaceId: null, chapterId: null, tab: null });
    snapshot.workspaceId = "mutated";
    expect(coordinator.current().workspaceId).toBeNull();
  });

  it("invalidates every previous token when the visible context changes", () => {
    const coordinator = new WorkbenchContextCoordinator();
    coordinator.transition({ workspaceId: "A", chapterId: "ch001", tab: "bi" });
    const workspace = coordinator.capture("workspace");
    const chapter = coordinator.capture("chapter");
    const tab = coordinator.capture("tab");

    coordinator.transition({ workspaceId: "A", chapterId: "ch001", tab: "terms" });

    expect(coordinator.accepts(workspace)).toBe(false);
    expect(coordinator.accepts(chapter)).toBe(false);
    expect(coordinator.accepts(tab)).toBe(false);
    expect(coordinator.current().generation).toBe(2);
  });

  // 这一组守的是一次真实事故：侧栏术语表点开永远是空的，而且不报任何错。
  // 挂载序列是「发起术语查询 → 打开上次编辑的章节」，后者推进代次；查询回来时
  // accepts() 已经作废了 token，函数在写 DOM 之前就 return 了。真实应用里那块骨架
  // 是空的（演示词条只在独立打开设计稿时才有），于是空白就一直留在那儿。
  describe("acceptsLane：工作区级效果不该被章节导航连坐", () => {
    it("章节换了、代次前进了，工作区级的那次渲染仍然有效", () => {
      const coordinator = new WorkbenchContextCoordinator();
      coordinator.transition({ workspaceId: "A", chapterId: null, tab: null });
      const token = coordinator.capture("workspace", "side-terms");

      coordinator.transition({ workspaceId: "A", chapterId: "ch001", tab: "bi" });

      expect(coordinator.accepts(token)).toBe(false);      // 旧判据：连坐作废
      expect(coordinator.acceptsLane(token)).toBe(true);   // 新判据：与章节无关
    });

    it("换了工作区就必须作废——A 的术语绝不能画进 B 的侧栏", () => {
      const coordinator = new WorkbenchContextCoordinator();
      coordinator.transition({ workspaceId: "A", chapterId: null, tab: null });
      const token = coordinator.capture("workspace", "side-terms");

      coordinator.transition({ workspaceId: "B", chapterId: null, tab: null });

      expect(coordinator.acceptsLane(token)).toBe(false);
    });

    it("同一泳道后发起的那次让先发起的作废——慢的不许覆盖快的", () => {
      const coordinator = new WorkbenchContextCoordinator();
      coordinator.transition({ workspaceId: "A", chapterId: null, tab: null });
      const first = coordinator.capture("workspace", "side-terms");
      const second = coordinator.capture("workspace", "side-terms");

      expect(coordinator.acceptsLane(first)).toBe(false);
      expect(coordinator.acceptsLane(second)).toBe(true);
    });

    it("别的泳道推进不影响本泳道", () => {
      const coordinator = new WorkbenchContextCoordinator();
      coordinator.transition({ workspaceId: "A", chapterId: null, tab: null });
      const terms = coordinator.capture("workspace", "side-terms");
      coordinator.capture("workspace", "side-foot");

      expect(coordinator.acceptsLane(terms)).toBe(true);
    });
  });

  it("distinguishes two workspaces that both contain ch001", () => {
    const coordinator = new WorkbenchContextCoordinator();
    coordinator.transition({ workspaceId: "A", chapterId: "ch001", tab: "bi" });
    const token = coordinator.capture("chapter");

    coordinator.transition({ workspaceId: "B", chapterId: "ch001", tab: "bi" });

    expect(coordinator.accepts(token)).toBe(false);
  });

  it("accepts only tokens captured from the current scope", () => {
    const coordinator = new WorkbenchContextCoordinator();
    coordinator.transition({ workspaceId: "A", chapterId: "ch002", tab: "review" });

    expect(coordinator.accepts(coordinator.capture("workspace"))).toBe(true);
    expect(coordinator.accepts(coordinator.capture("chapter"))).toBe(true);
    expect(coordinator.accepts(coordinator.capture("tab"))).toBe(true);
  });

  it("invalidates workspace tokens on chapter transitions by generation", () => {
    const coordinator = new WorkbenchContextCoordinator();
    coordinator.transition({ workspaceId: "A", chapterId: "ch001", tab: "bi" });
    const token = coordinator.capture("workspace");
    coordinator.transition({ workspaceId: "A", chapterId: "ch002", tab: "bi" });
    expect(coordinator.accepts(token)).toBe(false);
  });

  it("accepts only the latest workspace navigation", () => {
    const coordinator = new WorkbenchContextCoordinator();
    const first = coordinator.beginNavigation();
    const second = coordinator.beginNavigation();
    expect(coordinator.acceptsNavigation(first)).toBe(false);
    expect(coordinator.acceptsNavigation(second)).toBe(true);
  });

  it("accepts only the latest request in one projection lane", () => {
    const coordinator = new WorkbenchContextCoordinator();
    coordinator.transition({ workspaceId: "A", chapterId: "ch001", tab: "terms" });
    const firstBadge = coordinator.capture("workspace", "term-badge");
    const header = coordinator.capture("workspace", "header");
    const secondBadge = coordinator.capture("workspace", "term-badge");

    expect(coordinator.accepts(firstBadge)).toBe(false);
    expect(coordinator.accepts(secondBadge)).toBe(true);
    expect(coordinator.accepts(header)).toBe(true);
  });
});
