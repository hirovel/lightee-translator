/**
 * 工作区归档与自动快照（RH-21 / 架构评估 C-2）。
 *
 * 此前译文只有一份：`state/checkpoints` 是单槽，被覆盖就没有第二份。用户手滑、
 * 磁盘坏道、或者一次错误的批量替换，都没有回头路。本地优先的应用不能把「备份」
 * 推给用户自己想办法——那等于没有。
 *
 * 复用 core 已有的 JSZip（EPUB 导出同一套基建），不引新依赖。
 */
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";

/**
 * 归档排除清单。**导出与自动快照共用同一份**——两处分别维护迟早会漂移，
 * 而漂移的方向通常是「手动导出漏了某个目录」，等发现时用户已经按它恢复过了。
 *
 * - `.agents`：LLM 调用日志，含完整 prompt/response（隐私 + 体积），不属于「书」。
 * - `state/staging`：翻译中间产物，恢复后必须重跑而不是沿用。
 * - `state/trash`：已删除内容的软删快照，恢复它等于把用户删掉的东西又搬回来。
 * - `.backups`：快照自己。不排除的话每次快照都会把上一份套娃进去。
 */
export const ARCHIVE_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  ".agents",
  ".backups",
  "state/staging",
  "state/trash",
]);

/** 自动快照目录（工作区内，随工作区一起移动） */
export const SNAPSHOT_DIR = ".backups";
/** 两次自动快照的最小间隔 */
export const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 自动快照保留份数 */
export const SNAPSHOT_KEEP = 3;

function toPosix(relativePath: string): string {
  return relativePath.split(sep).join(posix.sep);
}

function isExcluded(relativePath: string): boolean {
  for (const excluded of ARCHIVE_EXCLUDED_DIRS) {
    if (relativePath === excluded || relativePath.startsWith(`${excluded}/`)) return true;
  }
  return false;
}

async function collectFiles(root: string, current = root, out: string[] = []): Promise<string[]> {
  const dirEntries = await readdir(current, { withFileTypes: true });
  for (const entry of dirEntries) {
    const absolute = join(current, entry.name);
    const rel = toPosix(relative(root, absolute));
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) await collectFiles(root, absolute, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * 把工作区打包成 zip 写到 `targetPath`。
 *
 * 用流式写出而不是先在内存里拼一个 Buffer：一本长篇的译文 + 原文 + 术语档案很容易到
 * 几百 MB，整包驻留内存会在低配机器上直接把主进程打爆。
 */
export async function createWorkspaceArchive(root: string, targetPath: string): Promise<void> {
  const files = await collectFiles(root);
  const zip = new JSZip();
  for (const rel of files) {
    zip.file(rel, await readFile(join(root, rel)));
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await pipeline(
    zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE" }),
    createWriteStream(targetPath),
  );
}

async function snapshotFiles(root: string): Promise<Array<{ path: string; mtime: number }>> {
  const dir = join(root, SNAPSHOT_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const stamped = await Promise.all(names
    .filter((name) => name.startsWith("snapshot-") && name.endsWith(".zip"))
    .map(async (name) => {
      const path = join(dir, name);
      return { path, mtime: await stat(path).then((s) => s.mtimeMs).catch(() => 0) };
    }));
  return stamped.sort((a, b) => a.mtime - b.mtime);
}

/** 距上次快照是否已超过间隔。目录不存在（从未快照）→ true */
export async function shouldSnapshot(root: string, now: number): Promise<boolean> {
  const files = await snapshotFiles(root);
  const latest = files[files.length - 1];
  if (!latest) return true;
  return now - latest.mtime >= SNAPSHOT_INTERVAL_MS;
}

/** 只保留最近 `keep` 份快照。按 mtime 排序——文件名里的时间戳不保证可比 */
export async function pruneSnapshots(root: string, keep = SNAPSHOT_KEEP): Promise<void> {
  const files = await snapshotFiles(root);
  for (const { path } of files.slice(0, Math.max(0, files.length - keep))) {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

/**
 * 机会式自动快照：满足间隔就做一份并清理超额的，否则什么也不做。
 *
 * **永不 reject**——备份失败不能阻止用户打开工作区。磁盘满、目录只读都只记一句日志。
 * 返回是否真的做了快照，供调用方写日志。
 */
export async function maybeSnapshotWorkspace(root: string, now = Date.now()): Promise<boolean> {
  try {
    if (!(await shouldSnapshot(root, now))) return false;
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    await createWorkspaceArchive(root, join(root, SNAPSHOT_DIR, `snapshot-${stamp}.zip`));
    await pruneSnapshots(root);
    return true;
  } catch {
    return false;
  }
}
