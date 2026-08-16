/**
 * 卷支持测试：book.yaml volumes + source/vXX/ 目录 + 自动递增 + 追加 + 卷标题识别。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace, listVolumes, type Workspace } from "../src/workspace.ts";
import { importTxtBook } from "../src/txt-import.ts";

let dir: string;
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lightee-vol-"));
  ws = await createWorkspace(dir, { name: "测试之书" });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const TXT = `第1章 出会い

「こんにちは」

第2章 約束

「また明日」
`;

describe("workspace 卷支持", () => {
  it("初始无卷", async () => {
    expect(await listVolumes(ws)).toEqual([]);
  });

  it("首次导入自动 v01，book.yaml 记录 volumes", async () => {
    const manifest = await importTxtBook(join(dir, "book.txt"), ws, { sourceText: TXT });
    expect(manifest.chapters[0]!.volume).toBe("v01");
    const vols = await listVolumes(ws);
    expect(vols).toEqual([{ id: "v01", label: "第一卷" }]);
    // 章节落盘在 source/v01/
    const files = await readdir(join(ws.root, "source", "v01"));
    expect(files).toContain("ch001.md");
    expect(files).toContain("ch002.md");
  });

  it("再次导入自动 v02（递增）", async () => {
    await importTxtBook(join(dir, "b1.txt"), ws, { sourceText: TXT });
    const m2 = await importTxtBook(join(dir, "b2.txt"), ws, { sourceText: `第3章 別れ\n\nさようなら` });
    expect(m2.chapters.filter((c) => c.volume === "v02")).toHaveLength(1);
    expect(m2.chapters.find((c) => c.volume === "v02")!.id).toBe("ch003");
    const vols = await listVolumes(ws);
    expect(vols.map((v) => v.id)).toEqual(["v01", "v02"]);
  });

  it("文本首行「第2巻」→ 自动识别 v02", async () => {
    const m = await importTxtBook(join(dir, "b.txt"), ws, {
      sourceText: `第2巻 始まりの日\n\n第1章 再会\n\nこんにちは`,
    });
    expect(m.chapters[0]!.volume).toBe("v02");
  });

  it("指定 volumeId=v01 追加（ch 编号顺延）", async () => {
    await importTxtBook(join(dir, "b1.txt"), ws, { sourceText: TXT });
    const m = await importTxtBook(join(dir, "b2.txt"), ws, {
      sourceText: `第3章 別れ\n\nさようなら`,
      volumeId: "v01",
    });
    expect(m.chapters.map((c) => c.id)).toEqual(["ch001", "ch002", "ch003"]);
    expect(m.chapters.every((c) => c.volume === "v01")).toBe(true);
  });

  it("manifest 合并：两卷章节都在", async () => {
    await importTxtBook(join(dir, "b1.txt"), ws, { sourceText: TXT });
    await importTxtBook(join(dir, "b2.txt"), ws, { sourceText: `第1章 新章\n\n本文` });
    const manifest = JSON.parse(await readFile(join(ws.root, "source", "manifest.json"), "utf-8"));
    expect(manifest.chapters.length).toBe(3);
    expect(manifest.chapters.map((c: { volume: string }) => c.volume)).toEqual([
      "v01",
      "v01",
      "v02",
    ]);
  });

  it("chapter id 在工作区全局唯一（新卷继续递增）", async () => {
    await importTxtBook(join(dir, "b1.txt"), ws, { sourceText: TXT });
    const m2 = await importTxtBook(join(dir, "b2.txt"), ws, { sourceText: `第1章 新章\n\n本文` });
    expect(m2.chapters.map((c) => c.id)).toEqual(["ch001", "ch002", "ch003"]);
    expect(new Set(m2.chapters.map((c) => c.id)).size).toBe(m2.chapters.length);
  });
});
