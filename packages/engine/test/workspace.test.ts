import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVolume, createWorkspace, listVolumes } from "../src/workspace.js";
import { importTxtBook, splitChapters } from "../src/txt-import.js";

describe("工作区初始化", () => {
  it("创建完整目录结构", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qx-ws-"));
    const ws = await createWorkspace(dir, { name: "测试书", srcLang: "ja" });
    for (const sub of ["source", "terminology", "translations", "reviews", "state", "sessions", "output", "resources", ".agents"]) {
      expect(existsSync(join(dir, sub)), sub).toBe(true);
    }
    expect(existsSync(join(dir, "book.yaml"))).toBe(true);
    expect(ws.root).toBe(dir);
  });

  it("book.yaml 含元数据", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qx-ws-"));
    await createWorkspace(dir, { name: "测试书", srcLang: "ja", tgtLang: "zh" });
    const yaml = readFileSync(join(dir, "book.yaml"), "utf-8");
    expect(yaml).toContain("测试书");
    expect(yaml).toContain("ja");
  });

  it("重复初始化不报错（幂等）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qx-ws-"));
    await createWorkspace(dir, { name: "a" });
    await createWorkspace(dir, { name: "a" }); // 再次
    expect(existsSync(join(dir, "book.yaml"))).toBe(true);
  });

  it("addVolume 对 ID 幂等并支持首次插入位置", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qx-ws-volume-"));
    const ws = await createWorkspace(dir, { name: "a" });
    await addVolume(ws, "v01", "第一卷");
    await addVolume(ws, "v03", "第三卷");
    await addVolume(ws, "v02", "第二卷", { at: 1 });
    await addVolume(ws, "v02", "不应重复");
    expect(await listVolumes(ws)).toEqual([
      { id: "v01", label: "第一卷" },
      { id: "v02", label: "第二卷" },
      { id: "v03", label: "第三卷" },
    ]);
  });
});

describe("TXT 导入与分章", () => {
  it("按第X章/第X話 规则分章", () => {
    const text = "プロローグ\n\n开头内容。\n\n第1章\n\n第一章内容。\n\n第2話\n\n第二章内容。";
    const chapters = splitChapters(text);
    expect(chapters.length).toBeGreaterThanOrEqual(3);
    expect(chapters[0]!.title).toContain("プロローグ");
  });

  it("生成 manifest 与章节文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qx-txt-"));
    const ws = await createWorkspace(dir, { name: "t" });
    const srcPath = join(dir, "book.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(srcPath, "第1章\n\n内容一。\n\n第2章\n\n内容二。", "utf-8");

    const manifest = await importTxtBook(srcPath, ws);
    expect(manifest.chapters.length).toBe(2);
    expect(existsSync(join(dir, "source", "v01", "ch001.md"))).toBe(true);
    expect(existsSync(join(dir, "source", "manifest.json"))).toBe(true);
  });

  it("无章节标记时整本为单章（标记待人工确认）", () => {
    const chapters = splitChapters("普通文本没有章节标记。");
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.needsManualConfirm).toBe(true);
  });
});
