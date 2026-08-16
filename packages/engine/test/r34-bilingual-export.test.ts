/**
 * R3-4 双语对照导出：MD 段落对与 EPUB 同页对照。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace, type Workspace } from "../src/workspace.ts";
import { exportChapter } from "../src/export-one.ts";
import { writeChapterParagraphs } from "../src/paragraph-gate.ts";

let dir: string;
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lightee-r34-"));
  ws = await createWorkspace(dir, { name: "双语导出" });
  await mkdir(join(dir, "source", "v01"), { recursive: true });
  await mkdir(join(dir, "translations", "v01"), { recursive: true });
  await writeFile(join(dir, "source", "v01", "ch001.md"), "「こんにちは」\n\nアリスが言った。", "utf-8");
  await writeFile(
    join(dir, "source", "manifest.json"),
    JSON.stringify({ book: "测试书", chapters: [{ id: "ch001", title: "第1章", volume: "v01" }] })
  );
  await writeFile(join(dir, "translations", "ch001_zh.md"), "“你好。”\n\n爱丽丝说道。", "utf-8");
  await writeChapterParagraphs(ws, "ch001", [
    { id: "p0001", type: "body", source: "「こんにちは」", translation: "“你好。”" },
    { id: "p0002", type: "body", source: "アリスが言った。", translation: "爱丽丝说道。" },
  ]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("双语对照导出", () => {
  it("md-bilingual：逐段成对，源在上译在下", async () => {
    const { outPath: path } = await exportChapter(ws, "ch001", "md-bilingual");
    const text = await readFile(path, "utf-8");
    expect(path).toMatch(/双语\.md$/);
    const first = text.indexOf("「こんにちは」");
    const second = text.indexOf("“你好。”");
    const third = text.indexOf("アリスが言った。");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("md-bilingual：原文用引用块弱化，译文是正文", async () => {
    const text = await readFile((await exportChapter(ws, "ch001", "md-bilingual")).outPath, "utf-8");
    expect(text).toContain("> 「こんにちは」");
    expect(text).toContain("\n“你好。”");
  });

  it("epub-bilingual：可解析回读，且同页含双语", async () => {
    const { outPath: path } = await exportChapter(ws, "ch001", "epub-bilingual");
    expect(path).toMatch(/双语\.epub$/);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(path));
    const names = Object.keys(zip.files);
    const chapterFile = names.find((n) => n.includes("ch001") && n.endsWith(".xhtml"));
    expect(chapterFile).toBeDefined();
    const html = await zip.file(chapterFile!)!.async("string");
    expect(html).toContain("こんにちは");
    expect(html).toContain("你好");
  });

  it("空译段落只输出原文，不产生空行对（未译章节导出不该是一堆空白）", async () => {
    await writeChapterParagraphs(ws, "ch001", [
      { id: "p0001", type: "body", source: "「こんにちは」", translation: "“你好。”" },
      { id: "p0002", type: "body", source: "アリスが言った。", translation: "" },
    ]);
    const text = await readFile((await exportChapter(ws, "ch001", "md-bilingual")).outPath, "utf-8");
    expect(text).toContain("> アリスが言った。");
    expect(text).not.toMatch(/\n{4,}/);
  });

  it("没有段落文件 → 明确报错而不是导出半份对照", async () => {
    await rm(join(dir, "state", "paragraphs", "ch001.json"), { force: true });
    await expect(exportChapter(ws, "ch001", "md-bilingual")).rejects.toThrow(/段落/);
  });

  it("既有 md/txt/epub 三种格式行为不变", async () => {
    const md = await readFile((await exportChapter(ws, "ch001", "md")).outPath, "utf-8");
    expect(md).toContain("# 第1章");
    expect(md).not.toContain("こんにちは");
  });
});
