import { describe, expect, it } from "vitest";
import { contextForChapter, WorkbenchContextStore } from "./workbench-context";
import { MemoryWorkspaceAdapter } from "./workspace-store";

describe("WorkbenchContext", () => {
  it("derives one workspace-volume-chapter context", async () => {
    const workspace = (await new MemoryWorkspaceAdapter().list())[0]!;
    expect(contextForChapter(workspace, "ch002")).toEqual({
      workspaceId: "ws-b001",
      workspaceName: "雨中的天使",
      chapterId: "ch002",
      chapterTitle: "公园的相遇",
      volumeId: "v01",
      volumeName: "第一卷",
      srcLang: "ja",
      tgtLang: "zh",
    });
    expect(contextForChapter(workspace, "missing")).toBeNull();
  });

  it("publishes immutable context snapshots and supports unsubscribe", () => {
    const store = new WorkbenchContextStore();
    const seen: Array<string | null> = [];
    const unsubscribe = store.subscribe((context) => seen.push(context?.chapterId ?? null));
    const context = {
      workspaceId: "ws-1",
      workspaceName: "书",
      chapterId: "ch001",
      chapterTitle: "第一章",
      volumeId: "v01",
      volumeName: "第一卷",
      srcLang: "ja",
      tgtLang: "zh",
    };
    store.set(context);
    context.chapterTitle = "被修改的外部对象";
    expect(store.get()?.chapterTitle).toBe("第一章");
    unsubscribe();
    store.set(null);
    expect(seen).toEqual(["ch001"]);
  });
});
