/** chapter-fs 测试：章节编号 / 跨卷移动文件 / 删卷目录 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace, addVolume, type Workspace } from "../src/workspace.ts";
import { allocateChapterIds, nextChapterId, chapterFilePaths, moveChapterFiles, readChapterCatalog, resolveChapter, removeVolumeDirs } from "../src/chapter-fs.ts";

let dir: string;
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lightee-chfs-"));
  ws = await createWorkspace(dir, { name: "章FS测试" });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("chapter-fs", () => {
  it("allocateChapterIds 使用工作区全局 ID，不复用其它卷或 manifest 中的编号", async () => {
    await mkdir(join(ws.root, "source", "v01"), { recursive: true });
    await writeFile(join(ws.root, "source", "v01", "ch001.md"), "# A");
    await writeFile(join(ws.root, "source", "manifest.json"), JSON.stringify({ chapters: [{ id: "ch004", volume: "v02" }] }));
    expect(await allocateChapterIds(ws, 2)).toEqual(["ch005", "ch006"]);
  });

  it("nextChapterId 按工作区最大 chXXX + 1 顺延", async () => {
    await mkdir(join(dir, "source", "v01"), { recursive: true });
    expect(await nextChapterId(ws, "v01")).toBe("ch001");
    await writeFile(join(dir, "source", "v01", "ch001.md"), "# A", "utf-8");
    await writeFile(join(dir, "source", "v01", "ch003.md"), "# C", "utf-8");
    expect(await nextChapterId(ws, "v01")).toBe("ch004");
  });

  it("chapterFilePaths 返回各关联文件路径", async () => {
    const paths = chapterFilePaths(ws, "v01", "ch001");
    expect(paths.src.endsWith(join("source", "v01", "ch001.md"))).toBe(true);
    expect(paths.translation.endsWith(join("translations", "ch001_zh.md"))).toBe(true);
    expect(paths.draft.endsWith(join("state", "drafts", "ch001.json"))).toBe(true);
    expect(paths.checkpoint.endsWith(join("state", "checkpoints", "ch001.json"))).toBe(true);
    expect(paths.correction.endsWith(join("state", "source-corrections", "ch001.json"))).toBe(true);
  });

  it("moveChapterFiles 跨卷只移动源文件，canonical 译文路径保持不变", async () => {
    await addVolume(ws, "v01", "第一卷");
    await addVolume(ws, "v02", "第二卷");
    const from = chapterFilePaths(ws, "v01", "ch001");
    await mkdir(join(dir, "source", "v01"), { recursive: true });
    await writeFile(from.src, "# 原", "utf-8");
    await writeFile(from.translation, "译", "utf-8");
    await moveChapterFiles(ws, "v01", "v02", "ch001");
    expect(existsSync(from.src)).toBe(false);
    expect(await readFile(from.translation, "utf-8")).toBe("译");
    const to = chapterFilePaths(ws, "v02", "ch001");
    expect(await readFile(to.src, "utf-8")).toBe("# 原");
    expect(to.translation).toBe(from.translation);
  });

  it("catalog 拒绝路径穿越、非法卷和大小写碰撞 ID", async () => {
    await mkdir(join(dir, "source"), { recursive: true });
    const manifestPath = join(dir, "source", "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ chapters: [{ id: "../../outside", volume: "v01" }] }));
    await expect(readChapterCatalog(ws)).rejects.toThrow("invalid chapter id");
    await writeFile(manifestPath, JSON.stringify({ chapters: [{ id: "ch001", volume: "../outside" }] }));
    await expect(readChapterCatalog(ws)).rejects.toThrow("invalid volume id");
    await writeFile(manifestPath, JSON.stringify({ chapters: [
      { id: "ch001", volume: "v01" },
      { id: "CH001", volume: "v02" },
    ] }));
    await expect(readChapterCatalog(ws)).rejects.toThrow("invalid chapter id");
  });

  it("catalog 严格解析章节归属和 canonical paths", async () => {
    await mkdir(join(dir, "source", "v02"), { recursive: true });
    await writeFile(join(dir, "source", "v02", "ch003.md"), "# C", "utf-8");
    await writeFile(join(dir, "source", "manifest.json"), JSON.stringify({ chapters: [{ id: "ch003", title: "C", volume: "v02" }] }));
    const catalog = await readChapterCatalog(ws);
    expect(catalog.byId.get("ch003")?.volume).toBe("v02");
    const resolved = await resolveChapter(ws, "ch003");
    expect(resolved.paths.source.endsWith(join("source", "v02", "ch003.md"))).toBe(true);
    expect(resolved.paths.translation.endsWith(join("translations", "ch003_zh.md"))).toBe(true);
    await expect(resolveChapter(ws, "ch999")).rejects.toThrow("Unknown chapter ch999");
  });

  it("removeVolumeDirs 删除卷的 source/translations/resources 目录", async () => {
    await mkdir(join(dir, "source", "v01"), { recursive: true });
    await mkdir(join(dir, "translations", "v01"), { recursive: true });
    await mkdir(join(dir, "resources", "v01"), { recursive: true });
    await writeFile(join(dir, "source", "v01", "ch001.md"), "# A", "utf-8");
    const result = await removeVolumeDirs(ws, "v01");
    expect(result.removed).toBe(true);
    expect(existsSync(join(dir, "source", "v01"))).toBe(false);
    expect(existsSync(join(dir, "translations", "v01"))).toBe(false);
    expect(existsSync(join(dir, "resources", "v01"))).toBe(false);
    // 不存在的卷返回 removed:false
    expect((await removeVolumeDirs(ws, "v99")).removed).toBe(false);
    // 卷目录删除不影响工作区级 manifest
    expect(await readdir(join(dir, "source"))).toEqual(["manifest.json"]);
  });
});
