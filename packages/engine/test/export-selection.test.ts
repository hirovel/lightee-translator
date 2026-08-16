/**
 * 导出范围可以是「作者勾选的这几章」，双语对照可以是纯文本。
 *
 * 从前导出只有两个范围：当前章节、全书。想给朋友寄第三卷、想只导已经定稿的那十章，
 * 都只能整本导出再自己删——范围写在界面上是两个按钮，作者脑子里的范围却是一份名单。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { exportChapter } from "../src/export-one.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** ch001/ch002 有译文（ch002 在暂存稿），ch003 完全没译 */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lightee-export-sel-"));
  roots.push(root);
  await mkdir(join(root, "source", "v01"), { recursive: true });
  await mkdir(join(root, "translations"), { recursive: true });
  await mkdir(join(root, "state", "staging"), { recursive: true });
  await writeFile(join(root, "source", "manifest.json"), JSON.stringify({
    book: "测试",
    chapters: [
      { id: "ch001", title: "一", volume: "v01" },
      { id: "ch002", title: "二", volume: "v01" },
      { id: "ch003", title: "三", volume: "v01" },
    ],
  }));
  for (const id of ["ch001", "ch002", "ch003"]) await writeFile(join(root, "source", "v01", `${id}.md`), `原文${id}`);
  await writeFile(join(root, "translations", "ch001_zh.md"), "第一章译文");
  await writeFile(join(root, "state", "staging", "ch002_zh.md"), "第二章暂存稿");
  return root;
}

describe("按章节名单导出", () => {
  it("勾选的几章导成一份，缺译文的那章跳过而不是整次失败", async () => {
    const root = await workspace();
    const result = await exportChapter({ root }, ["ch001", "ch003"], "md");
    expect(result.exported).toEqual(["ch001"]);
    expect(result.skipped).toEqual(["ch003"]);
    const text = await readFile(result.outPath, "utf8");
    expect(text).toContain("第一章译文");
    expect(text).not.toContain("原文ch003");
  });

  it("产物按目录顺序排，不按勾选顺序——勾选顺序不是阅读顺序", async () => {
    const root = await workspace();
    const result = await exportChapter({ root }, ["ch002", "ch001"], "md");
    expect(result.exported).toEqual(["ch001", "ch002"]);
    const text = await readFile(result.outPath, "utf8");
    expect(text.indexOf("第一章译文")).toBeLessThan(text.indexOf("第二章暂存稿"));
  });

  it("文件名说清导了几章，不冒用某一章的编号", async () => {
    const root = await workspace();
    const many = await exportChapter({ root }, ["ch001", "ch002"], "txt");
    expect(basename(many.outPath)).toBe("测试_选2章.txt");
    // 只勾一章 = 单章导出，文件名仍是那一章
    const one = await exportChapter({ root }, ["ch001"], "txt");
    expect(basename(one.outPath)).toBe("测试_ch001.txt");
  });

  it("只勾一章且它没有译文时报错——作者点的就是它", async () => {
    const root = await workspace();
    await expect(exportChapter({ root }, ["ch003"], "md")).rejects.toThrow(/Missing translation/);
  });

  it("名单里有不存在的章节 id 时整次作废，不静默少导", async () => {
    const root = await workspace();
    await expect(exportChapter({ root }, ["ch001", "ch404"], "md")).rejects.toThrow(/Unknown chapter ch404/);
  });
});

describe("导出位置与文件名由作者决定", () => {
  it("指定目录：写到那里，目录不存在就建出来", async () => {
    const root = await workspace();
    const outDir = join(root, "..", `lightee-out-${basename(root)}`);
    roots.push(outDir);
    const result = await exportChapter({ root }, "all", "md", { outDir });
    expect(dirname(result.outPath)).toBe(resolve(outDir));
    expect(await readFile(result.outPath, "utf8")).toContain("第一章译文");
  });

  it("指定文件名：产物就叫这个名字，不再拼「书名_范围」", async () => {
    const root = await workspace();
    const result = await exportChapter({ root }, "all", "txt", { fileName: "给朋友的稿子" });
    expect(basename(result.outPath)).toBe("给朋友的稿子.txt");
  });

  it("作者顺手打上的扩展名不会变成双扩展名", async () => {
    const root = await workspace();
    const md = await exportChapter({ root }, "all", "md", { fileName: "稿子.md" });
    expect(basename(md.outPath)).toBe("稿子.md");
    const txt = await exportChapter({ root }, "all", "txt", { fileName: "稿子.TXT" });
    expect(basename(txt.outPath)).toBe("稿子.txt");
  });

  it("文件名里的路径分隔符一律净化——文件名带路径等于绕过「导出到哪个目录」", async () => {
    const root = await workspace();
    const outDir = join(root, "out");
    const result = await exportChapter({ root }, "all", "txt", { outDir, fileName: "..\\..\\逃出去/坏文件" });
    // 落点必须仍在选定目录内
    expect(dirname(result.outPath)).toBe(resolve(outDir));
    expect(basename(result.outPath)).not.toContain("/");
    expect(basename(result.outPath)).not.toContain("\\");
  });

  it("文件名净化后是空的就当没填，回落默认命名——不能产出一个叫「.txt」的文件", async () => {
    const root = await workspace();
    const result = await exportChapter({ root }, "all", "txt", { fileName: '  ///:*?"  ' });
    expect(basename(result.outPath)).toBe("测试_全卷.txt");
  });

  it("书名里的空格与连字符原样保留——净化不该顺手改了作者的书名", async () => {
    const root = await workspace();
    const manifest = join(root, "source", "manifest.json");
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as { book: string };
    parsed.book = "Re:从零开始 - 第一部";
    await writeFile(manifest, JSON.stringify(parsed));
    const result = await exportChapter({ root }, "all", "txt");
    // 冒号非法 → 下划线；空格与连字符不动
    expect(basename(result.outPath)).toBe("Re_从零开始 - 第一部_全卷.txt");
  });

  it("双语对照同样认作者填的名字，不再往后面塞「_双语」", async () => {
    const root = await workspace();
    await mkdir(join(root, "state", "paragraphs"), { recursive: true });
    await writeFile(join(root, "state", "paragraphs", "ch001.json"), JSON.stringify({
      revision: 1, chapterId: "ch001",
      paragraphs: [{ id: "p0001", type: "text", source: "原文", translation: "译文" }],
    }));
    const result = await exportChapter({ root }, "ch001", "md-bilingual", { fileName: "对照本" });
    expect(basename(result.outPath)).toBe("对照本.md");
  });
});

describe("双语对照 · 纯文本", () => {
  async function withParagraphs(): Promise<string> {
    const root = await workspace();
    await mkdir(join(root, "state", "paragraphs"), { recursive: true });
    await writeFile(join(root, "state", "paragraphs", "ch001.json"), JSON.stringify({
      revision: 1, chapterId: "ch001",
      paragraphs: [
        { id: "p0001", type: "text", source: "日本語の原文", translation: "中文的译文" },
        { id: "p0002", type: "text", source: "訳のない段落", translation: "" },
      ],
    }));
    return root;
  }

  it("txt-bilingual 出的是 .txt，原文译文逐段相邻且不带 Markdown 引用符", async () => {
    const root = await withParagraphs();
    const result = await exportChapter({ root }, "ch001", "txt-bilingual");
    expect(basename(result.outPath)).toBe("测试_ch001_双语.txt");
    const text = await readFile(result.outPath, "utf8");
    expect(text).toContain("日本語の原文\n中文的译文");
    expect(text).not.toContain("> ");
    expect(text).not.toContain("# ");
    // 没有译文的段落只出原文，绝不留空占位
    expect(text).toContain("訳のない段落");
  });

  it("epub 双语与 md 双语走同一名单逻辑，多选时同样跳过没有段落数据的章", async () => {
    const root = await withParagraphs();
    const result = await exportChapter({ root }, ["ch001", "ch002"], "epub-bilingual");
    expect(result.exported).toEqual(["ch001"]);
    expect(result.skipped).toEqual(["ch002"]);
    expect(basename(result.outPath)).toBe("测试_选2章_双语.epub");
  });
});
