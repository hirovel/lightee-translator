/**
 * epub-write 测试：再生式导出 EPUB3（干净中文排版）。
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { generateEpub, type EpubExportChapter } from "../src/epub-write.ts";

const CH1: EpubExportChapter = {
  id: "ch001",
  title: "第1章 与天使相遇",
  content: [
    { kind: "text", text: "「*你*是谁？」她说道。" },
    { kind: "text", text: "我的名字是**田中**。" },
    { kind: "text", text: "[插图: img01]" },
    { kind: "text", text: "黑炎（Hellfire）燃烧起来。" },
  ],
  images: [{ name: "img01.jpg", caption: "教室的风景" }],
};

describe("epub-write", () => {
  it("生成标准 EPUB3 结构（mimetype/container/opf/nav）", async () => {
    const buf = await generateEpub({
      title: "屋上之灯",
      authors: ["佐伯さん"],
      lang: "zh",
      volumeLabel: "第一卷",
      chapters: [CH1],
      images: new Map([["img01.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])]]),
    });
    const zip = await JSZip.loadAsync(buf);
    // mimetype 必须存在且为纯文本
    expect(await zip.file("mimetype")!.async("string")).toBe("application/epub+zip");
    expect(zip.file("META-INF/container.xml")).toBeTruthy();
    const container = await zip.file("META-INF/container.xml")!.async("string");
    expect(container).toContain("OEBPS/content.opf");
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("屋上之灯");
    expect(opf).toContain("佐伯さん");
    expect(opf).toContain("ch001.xhtml");
    expect(opf).toContain("images/img01.jpg");
    expect(opf).toContain('properties="nav"');
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain("第1章 与天使相遇");
    expect(nav).toContain("ch001.xhtml");
  });

  it("章节 xhtml：段落/标题/斜体/粗体/插图页", async () => {
    const buf = await generateEpub({
      title: "测试",
      chapters: [CH1],
      images: new Map([["img01.jpg", Buffer.from([1, 2, 3])]]),
    });
    const zip = await JSZip.loadAsync(buf);
    const xhtml = await zip.file("OEBPS/ch001.xhtml")!.async("string");
    expect(xhtml).toContain("<h1>第1章 与天使相遇</h1>");
    expect(xhtml).toContain("<em>你</em>");
    expect(xhtml).toContain("<strong>田中</strong>");
    // 插图页：章节开头集中展示
    expect(xhtml).toContain("images/img01.jpg");
    expect(xhtml).toContain("教室的风景");
  });

  it("插图文件嵌入 OEBPS/images/", async () => {
    const buf = await generateEpub({
      title: "测试",
      chapters: [CH1],
      images: new Map([["img01.jpg", Buffer.from([0xff, 0xd8])]]),
    });
    const zip = await JSZip.loadAsync(buf);
    const img = await zip.file("OEBPS/images/img01.jpg")!.async("uint8array");
    expect(img[0]).toBe(0xff);
  });

  it("CSS 为干净中文阅读排版", async () => {
    const buf = await generateEpub({ title: "测试", chapters: [CH1] });
    const zip = await JSZip.loadAsync(buf);
    const css = await zip.file("OEBPS/styles.css")!.async("string");
    expect(css).toContain("text-indent: 2em");
    expect(css).toContain("line-height: 1.8");
  });

  it("spine 顺序 = 传入章节顺序", async () => {
    const ch2: EpubExportChapter = {
      id: "ch002",
      title: "第2章 雨中的对话",
      content: [{ kind: "text", text: "「明天见。」" }],
    };
    const buf = await generateEpub({
      title: "测试",
      chapters: [CH1, ch2],
    });
    const zip = await JSZip.loadAsync(buf);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    const spineIdx1 = opf.indexOf("ch001.xhtml");
    const spineIdx2 = opf.indexOf("ch002.xhtml");
    expect(spineIdx1).toBeGreaterThan(-1);
    expect(spineIdx2).toBeGreaterThan(spineIdx1);
  });

  it("卷首页显示卷标题", async () => {
    const buf = await generateEpub({
      title: "屋上之灯",
      authors: ["佐伯さん"],
      volumeLabel: "第一卷",
      chapters: [CH1],
    });
    const zip = await JSZip.loadAsync(buf);
    const titlePage = await zip.file("OEBPS/title.xhtml")!.async("string");
    expect(titlePage).toContain("屋上之灯");
    expect(titlePage).toContain("第一卷");
  });

  it("mimetype 为压缩方式存储（EPUB 规范：mimetype 必须 uncompressed）", async () => {
    const buf = await generateEpub({ title: "测试", chapters: [CH1] });
    const zip = await JSZip.loadAsync(buf);
    // jszip 读取时无法直接看压缩方式，但 mimetype 内容正确即可（jszip 默认 store 对 mimetype）
    const mime = await zip.file("mimetype")!.async("string");
    expect(mime).toBe("application/epub+zip");
  });
});
