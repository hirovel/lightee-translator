/**
 * import-pipeline 测试：EPUB 文件导入 / 分步导入 / 文件分发。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { createWorkspace, type Workspace } from "../src/workspace.ts";
import { importFile, importEpubFile, beginStep, finishStep } from "../src/import-pipeline.ts";

let dir: string;
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lightee-imp-"));
  ws = await createWorkspace(dir, { name: "导入测试" });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 构造最小 EPUB（含插图/ruby/斜体/两章） */
async function makeEpub(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );
  zip.file(
    "OEBPS/ch1.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>
      <h1>第1話 出会い</h1>
      <p>「<em>あなた</em>は誰？」</p>
      <p><img src="images/p001.jpg" alt="教室"/>黒炎が燃える。</p>
      <p><ruby>黒炎<rt>ヘルファイア</rt></ruby>は世界を包んだ。</p>
    </body></html>`
  );
  zip.file(
    "OEBPS/ch2.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>
      <h1>第2話 約束</h1><p>「また明日」</p>
    </body></html>`
  );
  zip.file("OEBPS/images/p001.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  zip.file(
    "OEBPS/content.opf",
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>テストの書</dc:title><dc:creator>著者A</dc:creator>
    <dc:identifier id="uid">t1</dc:identifier><dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/p001.jpg" media-type="image/jpeg"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol>
      <li><a href="ch1.xhtml">第1話 出会い</a></li>
      <li><a href="ch2.xhtml">第2話 約束</a></li>
    </ol></nav></body></html>`
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("import-pipeline", () => {
  it("EPUB 导入：章节落盘 + 标记保留 + 插图资源 + manifest", async () => {
    const epubPath = join(dir, "book.epub");
    await importWrite(epubPath, await makeEpub());

    const manifest = await importEpubFile(epubPath, ws);
    expect(manifest.chapters.length).toBe(2);
    expect(manifest.chapters[0]!.volume).toBe("v01");

    // 原文含标记（斜体 / 双重阅读注音 / 插图）
    const src = await readFile(join(ws.root, "source", "v01", "ch001.md"), "utf-8");
    expect(src).toContain("*あなた*");
    expect(src).toContain("黒炎(ヘルファイア)");
    expect(src).toContain("[插图: img01]");
    expect(src).toContain("# 第1話 出会い");

    // 插图资源落盘
    const img = await readFile(join(ws.root, "resources", "v01", "img01.jpg"));
    expect(img[0]).toBe(0xff);
  });

  it("EPUB 导入后再次导入自动 v02", async () => {
    const epubPath = join(dir, "book.epub");
    await importWrite(epubPath, await makeEpub());
    await importEpubFile(epubPath, ws);
    const m2 = await importEpubFile(epubPath, ws);
    expect(m2.chapters.filter((c) => c.volume === "v02")).toHaveLength(2);
  });

  it("importFile 按扩展名分发（epub/txt）", async () => {
    const epubPath = join(dir, "book.epub");
    await importWrite(epubPath, await makeEpub());
    const m1 = await importFile(epubPath, ws);
    expect(m1.sourceFormat).toBe("epub");

    const txtPath = join(dir, "book.txt");
    await importWrite(txtPath, "第1章 出会い\n\nこんにちは");
    const m2 = await importFile(txtPath, ws);
    expect(m2.sourceFormat).toBe("txt");
    expect(m2.chapters.filter((c) => c.volume === "v02")).toHaveLength(1);
  });

  it("不支持格式报错", async () => {
    const badPath = join(dir, "book.docx");
    await importWrite(badPath, "x");
    await expect(importFile(badPath, ws)).rejects.toThrow("不支持的格式");
  });

  it("分步导入：beginStep → finishStep 落盘 + 卷自动递增", async () => {
    const s1 = await beginStep(ws);
    expect(s1.volumeId).toBe("v01");
    s1.chapters.push({ title: "第1章 出会い", content: "こんにちは" });
    const m1 = await finishStep(ws, s1);
    expect(m1.chapters).toHaveLength(1);

    const s2 = await beginStep(ws);
    expect(s2.volumeId).toBe("v02");
    s2.chapters.push({ title: "第1章 再会", content: "おかえり" });
    const m2 = await finishStep(ws, s2);
    expect(m2.chapters.filter((c) => c.volume === "v02")).toHaveLength(1);

    const files = await readdir(join(ws.root, "source", "v02"));
    expect(files).toContain("ch002.md");
  });

  it("分步导入追加到已有卷（显式 volumeId）", async () => {
    const s1 = await beginStep(ws);
    s1.chapters.push({ title: "第1章 A", content: "a" });
    await finishStep(ws, s1);
    const s2 = await beginStep(ws, { volumeId: "v01" });
    s2.chapters.push({ title: "第2章 B", content: "b" });
    const m = await finishStep(ws, s2);
    expect(m.chapters.filter((c) => c.volume === "v01")).toHaveLength(2);
    expect(m.chapters.find((c) => c.title === "第2章 B")!.id).toBe("ch002");
  });
});

async function importWrite(path: string, content: string | Buffer): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

describe("previewImport（dry-run 分章预览，不落盘）", () => {
  it("txt 预览：分章结果 + 字数 + 未识别标记", async () => {
    const { previewImport } = await import("../src/import-pipeline.ts");
    const p = join(dir, "preview.txt");
    await importWrite(p, "第1章 出会い\n\nこんにちは\n\n第2章 約束\n\nまた明日");
    const manifestPath = join(dir, "source", "manifest.json");
    const beforeManifest = await readFile(manifestPath, "utf8");
    const preview = await previewImport(p);
    expect(preview.chapters).toHaveLength(2);
    expect(preview.chapters[0]!.title).toBe("第1章 出会い");
    expect(preview.chapters[0]!.charCount).toBeGreaterThan(0);
    // dry-run 不修改既有空 manifest
    expect(await readFile(manifestPath, "utf8")).toBe(beforeManifest);
  });

  it("无章节标记 → 未识别提示", async () => {
    const { previewImport } = await import("../src/import-pipeline.ts");
    const p = join(dir, "plain.txt");
    await importWrite(p, "普通文本没有任何章节标记。");
    const preview = await previewImport(p);
    expect(preview.chapters).toHaveLength(1);
    expect(preview.chapters[0]!.needsManualConfirm).toBe(true);
  });

  it("epub 预览：章节标题 + 卷提示", async () => {
    const { previewImport } = await import("../src/import-pipeline.ts");
    const p = join(dir, "book.epub");
    await importWrite(p, await makeEpub());
    const preview = await previewImport(p);
    expect(preview.chapters.length).toBe(2);
    expect(preview.chapters[0]!.title).toBe("第1話 出会い");
  });

  it("不支持格式报错", async () => {
    const { previewImport } = await import("../src/import-pipeline.ts");
    const p = join(dir, "x.docx");
    await importWrite(p, "x");
    await expect(previewImport(p)).rejects.toThrow();
  });

  it("mergeManifest insertAfter 把新章节插到指定章节之后", async () => {
    const { mergeManifest } = await import("../src/txt-import.ts");
    // 初始两章
    await mergeManifest(ws, { book: "书", chapters: [
      { id: "ch001", title: "A", charCount: 1, volume: "v01" },
      { id: "ch002", title: "B", charCount: 1, volume: "v01" },
    ], sourceFormat: "txt" });
    // 在 ch001 之后插入 ch009
    const merged = await mergeManifest(ws, { book: "书", chapters: [
      { id: "ch009", title: "插入", charCount: 1, volume: "v01" },
    ], sourceFormat: "txt" }, { insertAfter: "ch001" });
    expect(merged.chapters.map((chapter) => chapter.id)).toEqual(["ch001", "ch009", "ch002"]);
    // 未命中 insertAfter 时退化为追加
    const appended = await mergeManifest(ws, { book: "书", chapters: [
      { id: "ch010", title: "追加", charCount: 1, volume: "v01" },
    ], sourceFormat: "txt" }, { insertAfter: "not-exist" });
    expect(appended.chapters.map((chapter) => chapter.id)).toEqual(["ch001", "ch009", "ch002", "ch010"]);
    const manifest = JSON.parse(await readFile(join(dir, "source", "manifest.json"), "utf-8"));
    expect(manifest.chapters.map((chapter: { id: string }) => chapter.id)).toEqual(["ch001", "ch009", "ch002", "ch010"]);
  });
});
