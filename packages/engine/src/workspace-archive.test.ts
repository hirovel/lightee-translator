import { mkdtemp, mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { ARCHIVE_EXCLUDED_DIRS, createWorkspaceArchive, pruneSnapshots, shouldSnapshot } from "./workspace-archive.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lightee-archive-"));
  await mkdir(join(root, "source", "v01"), { recursive: true });
  await mkdir(join(root, "translations"), { recursive: true });
  await mkdir(join(root, "terminology"), { recursive: true });
  await mkdir(join(root, "state", "staging"), { recursive: true });
  await mkdir(join(root, "state", "trash", "t1"), { recursive: true });
  await mkdir(join(root, ".agents"), { recursive: true });
  await mkdir(join(root, ".backups"), { recursive: true });
  await writeFile(join(root, "book.yaml"), "name: 备份测试\nschemaVersion: 1\n", "utf8");
  await writeFile(join(root, "source", "v01", "ch001.md"), "テスト本文", "utf8");
  await writeFile(join(root, "translations", "ch001.md"), "测试正文", "utf8");
  await writeFile(join(root, "terminology", "terms.json"), '{"entries":[]}', "utf8");
  await writeFile(join(root, "state", "chapter_state.json"), "{}", "utf8");
  await writeFile(join(root, "state", "staging", "ch001_zh.md"), "半成品", "utf8");
  await writeFile(join(root, "state", "trash", "t1", "meta.json"), "{}", "utf8");
  await writeFile(join(root, ".agents", "log.jsonl"), "{}", "utf8");
  // 故意不用 snapshot-*.zip 命名：这份只用来验证 .backups 被排除在归档之外，
  // 若命名成快照会污染下面的节流/保留用例（它们要从「一份快照都没有」起算）。
  await writeFile(join(root, ".backups", "legacy.zip"), "PK", "utf8");
  return root;
}

async function entries(zipPath: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  return Object.keys(zip.files).filter((name) => !zip.files[name]!.dir).sort();
}

describe("工作区归档（RH-21 / C-2）", () => {
  it("打包用户数据，排除 .agents / state/staging / trash / .backups", async () => {
    const root = await fixture();
    const target = join(await mkdtemp(join(tmpdir(), "lightee-out-")), "archive.zip");
    await createWorkspaceArchive(root, target);
    const names = await entries(target);
    expect(names).toContain("book.yaml");
    expect(names).toContain("source/v01/ch001.md");
    expect(names).toContain("translations/ch001.md");
    expect(names).toContain("terminology/terms.json");
    expect(names).toContain("state/chapter_state.json");
    // 排除项：中间产物与运行痕迹不属于「用户的书」
    expect(names.some((name) => name.startsWith(".agents/"))).toBe(false);
    expect(names.some((name) => name.startsWith("state/staging/"))).toBe(false);
    expect(names.some((name) => name.startsWith("state/trash/"))).toBe(false);
    expect(names.some((name) => name.startsWith(".backups/"))).toBe(false);
  });

  it("解包后内容逐字节一致——归档不是「大概能还原」", async () => {
    const root = await fixture();
    const target = join(await mkdtemp(join(tmpdir(), "lightee-out-")), "archive.zip");
    await createWorkspaceArchive(root, target);
    const zip = await JSZip.loadAsync(await readFile(target));
    expect(await zip.file("source/v01/ch001.md")!.async("string")).toBe("テスト本文");
    expect(await zip.file("translations/ch001.md")!.async("string")).toBe("测试正文");
    expect(await zip.file("book.yaml")!.async("string")).toBe("name: 备份测试\nschemaVersion: 1\n");
  });

  it("排除清单是导出与自动快照共用的同一份", () => {
    expect([...ARCHIVE_EXCLUDED_DIRS].sort()).toEqual([".agents", ".backups", "state/staging", "state/trash"]);
  });
});

describe("自动快照节流与保留", () => {
  it("从未快照过 → 应该快照", async () => {
    expect(await shouldSnapshot(await fixture(), Date.now())).toBe(true);
  });

  it("距上次快照不足 24h → 跳过", async () => {
    const root = await fixture();
    const now = Date.parse("2026-08-10T12:00:00Z");
    const recent = join(root, ".backups", "snapshot-1.zip");
    await writeFile(recent, "PK", "utf8");
    await utimes(recent, new Date(now - 3 * 3600_000), new Date(now - 3 * 3600_000));
    expect(await shouldSnapshot(root, now)).toBe(false);
  });

  it("距上次快照超过 24h → 应该快照", async () => {
    const root = await fixture();
    const now = Date.parse("2026-08-10T12:00:00Z");
    const stale = join(root, ".backups", "snapshot-1.zip");
    await writeFile(stale, "PK", "utf8");
    await utimes(stale, new Date(now - 30 * 3600_000), new Date(now - 30 * 3600_000));
    expect(await shouldSnapshot(root, now)).toBe(true);
  });

  it("只保留最近 3 份快照，删掉的是最旧的", async () => {
    const root = await fixture();
    const dir = join(root, ".backups");
    for (let i = 1; i <= 5; i += 1) {
      const path = join(dir, `snapshot-${i}.zip`);
      await writeFile(path, "PK", "utf8");
      await utimes(path, new Date(1_000_000 + i * 10_000), new Date(1_000_000 + i * 10_000));
    }
    await pruneSnapshots(root, 3);
    const left = (await readdir(dir)).filter((name) => name.startsWith("snapshot-")).sort();
    expect(left).toEqual(["snapshot-3.zip", "snapshot-4.zip", "snapshot-5.zip"]);
  });

  it("快照目录不存在时 shouldSnapshot 不抛异常", async () => {
    const root = await mkdtemp(join(tmpdir(), "lightee-empty-"));
    await expect(shouldSnapshot(root, Date.now())).resolves.toBe(true);
  });

  it("归档写到 .backups 内部时不会把自己打进去", async () => {
    const root = await fixture();
    const target = join(root, ".backups", "snapshot-self.zip");
    await createWorkspaceArchive(root, target);
    expect((await stat(target)).size).toBeGreaterThan(0);
    expect((await entries(target)).some((name) => name.startsWith(".backups/"))).toBe(false);
  });
});
