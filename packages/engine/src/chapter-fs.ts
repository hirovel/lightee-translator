/**
 * 章节文件系统操作（配合 chapter.create/delete/move 与软删除 trash）。
 * 纯文件操作，不依赖 LLM；错误由调用方映射为 IPC 错误码。
 */
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Workspace } from "./workspace.js";

export interface ChapterCatalogEntry {
  id: string;
  title?: string;
  volume?: string;
  [key: string]: unknown;
}

const CHAPTER_ID_PATTERN = /^ch\d{3,}$/;
const VOLUME_ID_PATTERN = /^v\d{2,}$/;

export function assertChapterId(value: string): void {
  if (!CHAPTER_ID_PATTERN.test(value)) throw new Error(`source/manifest.json contains an invalid chapter id: ${value}`);
}

export function assertVolumeId(value: string): void {
  if (!VOLUME_ID_PATTERN.test(value)) throw new Error(`source/manifest.json contains an invalid volume id: ${value}`);
}

export interface ChapterCatalog {
  book?: string;
  entries: ChapterCatalogEntry[];
  byId: Map<string, ChapterCatalogEntry>;
}

export async function readChapterCatalog(ws: Workspace): Promise<ChapterCatalog> {
  const manifestPath = join(ws.root, "source", "manifest.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("source/manifest.json is missing or invalid");
  }
  const manifest = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as { book?: unknown; chapters?: unknown }
    : undefined;
  const chapters = manifest?.chapters;
  if (!Array.isArray(chapters)) throw new Error("source/manifest.json chapters must be an array");
  const entries: ChapterCatalogEntry[] = [];
  const byId = new Map<string, ChapterCatalogEntry>();
  for (const value of chapters) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("source/manifest.json contains an invalid chapter");
    const entry = value as ChapterCatalogEntry;
    if (typeof entry.id !== "string" || !entry.id.trim()) throw new Error("source/manifest.json contains a chapter without an id");
    assertChapterId(entry.id);
    if (entry.volume !== undefined && typeof entry.volume !== "string") throw new Error(`source/manifest.json contains an invalid volume id: ${String(entry.volume)}`);
    assertVolumeId(entry.volume ?? "v01");
    if (byId.has(entry.id)) throw new Error(`重复章节 ID ${entry.id}`);
    entries.push(entry);
    byId.set(entry.id, entry);
  }
  return {
    book: typeof manifest?.book === "string" && manifest.book.trim() ? manifest.book : undefined,
    entries,
    byId,
  };
}

export function requireChapter(catalog: ChapterCatalog, chapterId: string): ChapterCatalogEntry {
  const entry = catalog.byId.get(chapterId);
  if (!entry) throw new Error(`Unknown chapter ${chapterId}`);
  return entry;
}

/**
 * 暂存译文的路径。**这一条约定此前在 7 处各手写了一遍**（engine 5 处、Electron 2 处），
 * 而写它的只有 `paragraph-gate`——读的那几处全靠注释互相声称「与某某同款」。
 *
 * 它之所以到处出现：章节 approved 之前译文只存在于这里，`translations/` 是空的
 * （`beginPromotion` 只在转 approved 时才写）。任何要读「此刻的译文」的地方都得回退到它。
 * 只接 root 而不接 Workspace：调用方有的只拿着一个根路径。
 */
export function stagingTranslationPath(root: string, chapterId: string): string {
  return join(root, "state", "staging", `${chapterId}_zh.md`);
}

export function chapterPaths(ws: Workspace, entry: Pick<ChapterCatalogEntry, "id" | "volume">) {
  assertChapterId(entry.id);
  const volumeId = typeof entry.volume === "string" && entry.volume ? entry.volume : "v01";
  assertVolumeId(volumeId);
  return {
    source: join(ws.root, "source", volumeId, `${entry.id}.md`),
    translation: join(ws.root, "translations", `${entry.id}_zh.md`),
    staging: stagingTranslationPath(ws.root, entry.id),
    draft: join(ws.root, "state", "drafts", `${entry.id}.json`),
    checkpoint: join(ws.root, "state", "checkpoints", `${entry.id}.json`),
    correction: join(ws.root, "state", "source-corrections", `${entry.id}.json`),
    paragraphs: join(ws.root, "state", "paragraphs", `${entry.id}.json`),
  };
}

export async function resolveChapter(ws: Workspace, chapterId: string) {
  const catalog = await readChapterCatalog(ws);
  const entry = requireChapter(catalog, chapterId);
  return { catalog, entry, paths: chapterPaths(ws, entry) };
}

export function assertUniqueChapterIds(chapters: ReadonlyArray<{ id: string; volume?: string }>): void {
  const owners = new Map<string, string>();
  for (const chapter of chapters) {
    const volume = chapter.volume ?? "v01";
    const previousVolume = owners.get(chapter.id);
    if (previousVolume) throw new Error(`Duplicate chapter id ${chapter.id}: ${previousVolume} and ${volume}`);
    owners.set(chapter.id, volume);
  }
}

/**
 * 分配工作区全局唯一章节 ID。卷只是章节归属，不参与身份；所有创建和导入入口必须使用此函数。
 * 同时扫描 manifest 与 source 树，避免文件暂缺或软删除后的历史 ID 被静默复用。
 */
export async function allocateChapterIds(ws: Workspace, count: number): Promise<string[]> {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid chapter id allocation count: ${count}`);
  const used = new Set<string>();
  const manifestPath = join(ws.root, "source", "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { chapters?: Array<{ id?: unknown }> };
      for (const chapter of manifest.chapters ?? []) if (typeof chapter.id === "string") used.add(chapter.id);
    } catch {
      throw new Error("Cannot allocate chapter ids: source/manifest.json is invalid");
    }
  }
  const trashIndexPath = join(ws.root, "state", "trash", "trash-index.json");
  if (existsSync(trashIndexPath)) {
    try {
      const trash = JSON.parse(await readFile(trashIndexPath, "utf8")) as {
        entries?: Array<{ chapterId?: unknown; chapterIds?: unknown }>;
      };
      for (const entry of trash.entries ?? []) {
        if (typeof entry.chapterId === "string") used.add(entry.chapterId);
        if (Array.isArray(entry.chapterIds)) {
          for (const chapterId of entry.chapterIds) if (typeof chapterId === "string") used.add(chapterId);
        }
      }
    } catch {
      throw new Error("Cannot allocate chapter ids: state/trash/trash-index.json is invalid");
    }
  }
  const sourceRoot = join(ws.root, "source");
  if (existsSync(sourceRoot)) {
    for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of await readdir(join(sourceRoot, entry.name))) {
        const match = /^(ch\d+)\.md$/.exec(name);
        if (match) used.add(match[1]!);
      }
    }
  }
  let next = 1;
  for (const id of used) {
    const match = /^ch(\d+)$/.exec(id);
    if (match) next = Math.max(next, Number.parseInt(match[1]!, 10) + 1);
  }
  const ids: string[] = [];
  while (ids.length < count) {
    const id = `ch${String(next).padStart(3, "0")}`;
    next += 1;
    if (used.has(id)) continue;
    used.add(id);
    ids.push(id);
  }
  return ids;
}

export async function nextChapterId(ws: Workspace, _volumeId?: string): Promise<string> {
  return (await allocateChapterIds(ws, 1))[0]!;
}

/** 结构操作使用的兼容路径集合；译文是工作区级 canonical 文件，不随卷移动。 */
export function chapterFilePaths(ws: Workspace, volumeId: string, chapterId: string) {
  const paths = chapterPaths(ws, { id: chapterId, volume: volumeId });
  return { src: paths.source, translation: paths.translation, draft: paths.draft, checkpoint: paths.checkpoint, correction: paths.correction };
}

/** 跨卷只移动源文件；译文和派生状态按全局 chapterId 存储，不属于卷目录。 */
export async function moveChapterFiles(ws: Workspace, fromVol: string, toVol: string, chapterId: string): Promise<void> {
  const from = chapterFilePaths(ws, fromVol, chapterId);
  const to = chapterFilePaths(ws, toVol, chapterId);
  if (existsSync(from.src)) {
    await mkdir(join(ws.root, "source", toVol), { recursive: true });
    await rename(from.src, to.src);
  }
}

/** 删除卷目录（source/translations/resources 下） */
export async function removeVolumeDirs(ws: Workspace, volumeId: string): Promise<{ removed: boolean }> {
  let removed = false;
  for (const base of ["source", "translations", "resources"]) {
    const dir = join(ws.root, base, volumeId);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
      removed = true;
    }
  }
  return { removed };
}
