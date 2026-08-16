import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportChapter, exportProgress, stripMarkdown } from "../src/export-one.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stripMarkdown（TXT 导出净化）", () => {
  test("标题/引用/列表标记去除，文本保留", () => {
    expect(stripMarkdown("# 第一章 邻居天使")).toBe("第一章 邻居天使");
    expect(stripMarkdown("### 深层的标题")).toBe("深层的标题");
    expect(stripMarkdown("> 引用内容")).toBe("引用内容");
    expect(stripMarkdown("- 列表项")).toBe("列表项");
    expect(stripMarkdown("1. 编号项")).toBe("编号项");
    expect(stripMarkdown("* 星号项")).toBe("星号项");
  });

  test("粗体/斜体/行内代码保留内容", () => {
    expect(stripMarkdown("他**很强**")).toBe("他很强");
    expect(stripMarkdown("她*笑了笑*")).toBe("她笑了笑");
    expect(stripMarkdown("用 `代码` 表示")).toBe("用 代码 表示");
    expect(stripMarkdown("__双下划线__ 和 _单下划线_")).toBe("双下划线 和 单下划线");
  });

  test("分隔线行去除", () => {
    expect(stripMarkdown("---")).toBe("");
    expect(stripMarkdown("***")).toBe("");
    expect(stripMarkdown("___")).toBe("");
  });

  test("连续空行合并", () => {
    expect(stripMarkdown("第一行\n\n\n\n第二行")).toBe("第一行\n\n第二行");
  });

  test("无标记文本原样保留（含中文引号）", () => {
    const src = "「你在干什么啊」她歪着头问道。";
    expect(stripMarkdown(src)).toBe(src);
  });

  test("完整段落样例", () => {
    const md = `# 第 3 章 放学后

桧山**灯**看着窗外。

> 内心独白

- 要点一
- 要点二

---

「走吧。」`;
    const out = stripMarkdown(md);
    expect(out).not.toContain("#");
    expect(out).not.toContain("**");
    expect(out).toContain("桧山灯看着窗外。");
    expect(out).toContain("内心独白");
    expect(out).toContain("要点一");
    expect(out).toContain("「走吧。」");
  });
});

describe("strict export", () => {
  test("使用 canonical 译文并忽略孤儿文件的进度", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-export-"));
    roots.push(root);
    await mkdir(join(root, "source", "v02"), { recursive: true });
    await mkdir(join(root, "translations"), { recursive: true });
    await writeFile(join(root, "source", "manifest.json"), JSON.stringify({ book: "测试", chapters: [{ id: "ch003", title: "三", volume: "v02" }] }));
    await writeFile(join(root, "source", "v02", "ch003.md"), "原文");
    await writeFile(join(root, "translations", "ch003_zh.md"), "译文");
    await writeFile(join(root, "translations", "ch999_zh.md"), "孤儿");
    expect(await exportProgress({ root })).toEqual({ total: 1, done: 1 });
    const output = await exportChapter({ root }, "ch003", "md");
    expect(await readFile(output.outPath, "utf8")).toContain("译文");
  });

  test("缺少译文时失败且不创建空章节输出", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-export-missing-"));
    roots.push(root);
    await mkdir(join(root, "source", "v01"), { recursive: true });
    await writeFile(join(root, "source", "manifest.json"), JSON.stringify({ book: "测试", chapters: [{ id: "ch001", title: "一", volume: "v01" }] }));
    await writeFile(join(root, "source", "v01", "ch001.md"), "原文");
    await expect(exportChapter({ root }, "ch001", "txt")).rejects.toThrow("Missing translation for chapter ch001");
    await expect(readFile(join(root, "output", "测试_ch001.txt"), "utf8")).rejects.toThrow();
  });
});
