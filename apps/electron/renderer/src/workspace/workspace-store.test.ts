import { describe, expect, it } from "vitest";
import { MemoryWorkspaceAdapter } from "./workspace-store";

describe("MemoryWorkspaceAdapter", () => {
  it("lists workspaces most recently opened first", async () => {
    const adapter = new MemoryWorkspaceAdapter();
    const workspaces = await adapter.list();
    expect(workspaces.map((workspace) => workspace.id)).toEqual(["ws-b001", "ws-b002", "ws-b003"]);
    await adapter.open("C:/books/tensei");
    const reordered = await adapter.list();
    expect(reordered[0]!.id).toBe("ws-b002");
  });

  it("opens an unknown path as a new workspace with a stable id", async () => {
    const adapter = new MemoryWorkspaceAdapter();
    const outcome = await adapter.open("C:/books/brand-new");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.workspace.name).toBe("brand-new");
    expect(outcome.workspace.volumes).toHaveLength(1);
    expect((await adapter.list()).length).toBe(4);
  });

  it("validates create and rejects duplicate paths", async () => {
    const adapter = new MemoryWorkspaceAdapter();
    expect((await adapter.create({ path: "", name: "x" })).ok).toBe(false);
    expect((await adapter.create({ path: "C:/x", name: "" })).ok).toBe(false);
    expect((await adapter.create({ path: "C:/books/amane", name: "重复" })).ok).toBe(false);
    const created = await adapter.create({ path: "C:/books/new", name: "新书", srcLang: "ja", tgtLang: "zh" });
    expect(created.ok).toBe(true);
  });

  it("persists volume and chapter renames", async () => {
    const adapter = new MemoryWorkspaceAdapter();
    expect(await adapter.renameVolume("ws-b001", "v01", "序章卷")).toBe(true);
    expect(await adapter.renameChapter("ws-b001", "v01", "ch002", "初遇")).toBe(true);
    const workspaces = await adapter.list();
    const book = workspaces.find((workspace) => workspace.id === "ws-b001")!;
    expect(book.volumes[0]!.name).toBe("序章卷");
    expect(book.volumes[0]!.chapters[1]!.title).toBe("初遇");
    expect(await adapter.renameVolume("ws-b001", "v99", "不存在")).toBe(false);
  });

  it("stores and returns the resume session", async () => {
    const adapter = new MemoryWorkspaceAdapter();
    expect((await adapter.session())?.chapterId).toBe("ch002");
    await adapter.setSession({ workspaceId: "ws-b003", chapterId: "ch001", savedAt: 123 });
    expect(await adapter.session()).toEqual({ workspaceId: "ws-b003", chapterId: "ch001", savedAt: 123 });
    await adapter.setSession(null);
    expect(await adapter.session()).toBeNull();
  });

  it("returns the injected picked directory", async () => {
    const adapter = new MemoryWorkspaceAdapter();
    expect(await adapter.pickDirectory()).toBeNull();
    adapter.nextPickedPath = "C:/books/picked";
    expect(await adapter.pickDirectory()).toBe("C:/books/picked");
  });
});
