import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IPC_EVENT_NAMES, validateEnvelope } from "./ipc-contract.js";

describe("IPC contract validation", () => {
  it("keeps the secure preload event allowlist aligned with the shared contract", () => {
    const preload = readFileSync(resolve("preload.js"), "utf8");
    const block = /const EVENT_NAMES = new Set\(\[([\s\S]*?)\]\);/.exec(preload)?.[1] ?? "";
    const allowed = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(allowed)).toEqual(new Set(IPC_EVENT_NAMES));
  });

  it("accepts a valid draft save envelope", () => {
    const result = validateEnvelope({
      version: 1,
      requestId: "request-1",
      command: "chapter.saveDraft",
      payload: {
        workspaceId: "workspace-1",
        chapterId: "ch001",
        baseRevision: 0,
        paragraphs: [{ id: "p001", source: "原文", translation: "译文" }],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects path traversal-shaped ids and stale-shaped revisions", () => {
    const result = validateEnvelope({
      version: 1,
      requestId: "request-1",
      command: "chapter.saveDraft",
      payload: {
        workspaceId: "../outside",
        chapterId: "ch001",
        baseRevision: -1,
        paragraphs: [],
      },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a file picker request", () => {
    const result = validateEnvelope({
      version: 1,
      requestId: "request-pick-file",
      command: "dialog.pickFile",
      payload: { title: "选择小说" },
    });
    expect(result).toMatchObject({ ok: true, value: { command: "dialog.pickFile", payload: { title: "选择小说" } } });
  });

  it("accepts pasted text import and rejects empty text", () => {
    const empty = validateEnvelope({
      version: 1,
      requestId: "request-import-empty",
      command: "import.text",
      payload: { workspaceId: "ws-1", text: " " },
    });
    expect(empty).toMatchObject({ ok: false, error: { message: "text must be a non-empty string" } });

    const valid = validateEnvelope({
      version: 1,
      requestId: "request-import-text",
      command: "import.text",
      payload: { workspaceId: "ws-1", text: "第1章\n\n本文" },
    });
    expect(valid).toMatchObject({ ok: true, value: { command: "import.text", payload: { workspaceId: "ws-1", text: "第1章\n\n本文" } } });
  });

  // CHK-02：reviewRules.* 的校验用例随命令族一起删除。原块里混着一条与规则无关的
  // 断言（workspace.create 的空 name），留在这里。
  it("rejects an empty workspace name", () => {
    expect(validateEnvelope({
      version: 1,
      requestId: "request-2b",
      command: "workspace.create",
      payload: { path: "C:/workspace", name: "" },
    })).toMatchObject({ ok: false, error: { message: "name must be a non-empty string" } });
  });
});
