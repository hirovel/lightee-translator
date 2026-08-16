/**
 * RV-07 导出永远可导，构成如实披露。
 *
 * 用户定调：作者想导出不应受到任何阻碍——拿不到书的唯一原因只能是那部分真的还没译。
 * 从前译文躺在 state/staging 的章节（翻完未定稿）导出引擎读不到，一句「Missing translation」
 * 就让整本导不出来；那道「导不出」是人为的。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportChapter } from "../src/export-one.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** ch001 定稿 / ch002 只有暂存稿 / ch003 完全没译 */
async function mixedWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lightee-rv07-"));
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
  await writeFile(join(root, "translations", "ch001_zh.md"), "已定稿的译文");
  await writeFile(join(root, "state", "staging", "ch002_zh.md"), "还没定稿的暂存稿");
  return root;
}

describe("RV-07 导出构成", () => {
  it("单章导出读得到暂存稿（翻完未定稿不该导不出）", async () => {
    const root = await mixedWorkspace();
    const result = await exportChapter({ root }, "ch002", "md");
    expect(result.exported).toEqual(["ch002"]);
    expect(result.fromStaging).toEqual(["ch002"]);
    expect(await readFile(result.outPath, "utf8")).toContain("还没定稿的暂存稿");
  });

  it("整书导出：含有译文的章节，跳过没译的，构成如实报出", async () => {
    const root = await mixedWorkspace();
    const result = await exportChapter({ root }, "all", "md");
    expect(result.exported).toEqual(["ch001", "ch002"]);
    expect(result.fromStaging).toEqual(["ch002"]);
    expect(result.skipped).toEqual(["ch003"]);
    const text = await readFile(result.outPath, "utf8");
    expect(text).toContain("已定稿的译文");
    expect(text).toContain("还没定稿的暂存稿");
    // 未译章节跳过，绝不用原文占位——中日混排的书流出去是第一类事故
    expect(text).not.toContain("原文ch003");
    expect(text).not.toContain("# 三");
  });

  it("epub 整书导出同样跳过没译的章节", async () => {
    const root = await mixedWorkspace();
    const result = await exportChapter({ root }, "all", "epub");
    expect(result.exported).toEqual(["ch001", "ch002"]);
    expect(result.skipped).toEqual(["ch003"]);
  });

  it("单章导出真没有译文时仍然报错（用户点的就是它）", async () => {
    const root = await mixedWorkspace();
    await expect(exportChapter({ root }, "ch003", "md")).rejects.toThrow(/Missing translation/);
  });

  it("一章译文都没有时整书导出报错，而不是产出一本空书", async () => {
    const root = await mixedWorkspace();
    await rm(join(root, "translations", "ch001_zh.md"));
    await rm(join(root, "state", "staging", "ch002_zh.md"));
    await expect(exportChapter({ root }, "all", "md")).rejects.toThrow(/没有任何章节有译文/);
  });

  it("双语整书导出跳过没有段落数据的章节", async () => {
    const root = await mixedWorkspace();
    await mkdir(join(root, "state", "paragraphs"), { recursive: true });
    await writeFile(join(root, "state", "paragraphs", "ch001.json"), JSON.stringify({
      revision: 1, chapterId: "ch001",
      paragraphs: [{ id: "p0001", type: "text", source: "原文一", translation: "译文一" }],
    }));
    const result = await exportChapter({ root }, "all", "md-bilingual");
    expect(result.exported).toEqual(["ch001"]);
    expect(result.skipped).toEqual(["ch002", "ch003"]);
  });
});
