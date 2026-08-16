import { describe, expect, it } from "vitest";
import { acceptsAgentEvent, acceptsChapterEvent, acceptsWorkspaceEvent } from "./workbench-event-scope";

const current = { workspaceId: "B", chapterId: "ch001" };

describe("workbench event scope", () => {
  it("rejects progress from another workspace even when chapter ids match", () => {
    expect(acceptsChapterEvent(current, { workspaceId: "A", chapterId: "ch001" })).toBe(false);
  });

  it("rejects progress from another chapter in the active workspace", () => {
    expect(acceptsChapterEvent(current, { workspaceId: "B", chapterId: "ch002" })).toBe(false);
  });

  it("accepts matching workspace and chapter events", () => {
    expect(acceptsWorkspaceEvent(current, { workspaceId: "B" })).toBe(true);
    expect(acceptsChapterEvent(current, { workspaceId: "B", chapterId: "ch001" })).toBe(true);
  });

  it("keeps global configuration Agent events visible but scopes workflow events", () => {
    expect(acceptsAgentEvent(current, { operation: "configuration" })).toBe(true);
    expect(acceptsAgentEvent(current, { workspaceId: "A", operation: "terminology" })).toBe(false);
    expect(acceptsAgentEvent(current, { workspaceId: "B", chapterId: "ch002", operation: "translate" })).toBe(false);
    expect(acceptsAgentEvent(current, { workspaceId: "B", chapterId: "ch001", operation: "review" })).toBe(true);
  });
});
