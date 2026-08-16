/**
 * 真实 EPUB 导入回归。
 *
 * 断言的是**任何 EPUB 都该成立的结构不变量**，不是某一本书的具体事实——
 * 上一版把书名、章数、sha256 全写死，换一本书就只能 skip，于是这条链路
 * 长期没有真实文件覆盖（标题重复 46/46 章的缺陷就是这么漏过去的）。
 *
 * 设置 LIGHTEE_EPUB_JA 指向任意日文 EPUB 即可运行；未设置时显式 skip。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace } from "../src/workspace.ts";
import { importEpubFile } from "../src/import-pipeline.ts";

const fixture = process.env.LIGHTEE_EPUB_JA;

describe("真实 EPUB 导入", () => {
  if (!fixture) {
    it.skip("设置 LIGHTEE_EPUB_JA 指向任意 EPUB 后运行", () => {});
    return;
  }

  it("导入后每章结构完好，且标题不重复", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-epub-real-"));
    try {
      const ws = await createWorkspace(root, { name: "真实 EPUB" });
      const manifest = await importEpubFile(fixture, ws);

      expect(manifest.sourceFormat).toBe("epub");
      expect(manifest.chapters.length).toBeGreaterThan(0);
      expect(manifest.book?.trim()).toBeTruthy();

      let emptyish = 0;
      for (const meta of manifest.chapters) {
        const text = await readFile(join(root, "source", meta.volume ?? "", `${meta.id}.md`), "utf-8");
        const lines = text.split("\n").filter((line) => line.trim());
        // 首行是章节标题；第二行不得是同一个标题（EPUB 正文首段常常就是标题本身）
        expect(lines[0]).toBe(`# ${meta.title}`);
        expect(lines[1]).not.toBe(lines[0]);
        // 解析失败的常见形态：对象被 toString 成 [object Object]
        expect(text).not.toContain("[object Object]");
        if (text.trim().length < 50) emptyish += 1;
      }
      // 允许少量封面/版权页，但不该整本都是空壳
      expect(emptyish).toBeLessThan(manifest.chapters.length / 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
