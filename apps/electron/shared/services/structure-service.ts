/**
 * 结构域服务（RH-11 / design/ipc-service-decomposition.md §2）。
 *
 * 归属：章节与卷的增 / 删 / 移 / 改名 / 回收站恢复，以及回收站索引本身。
 *
 * 写权威：`source/manifest.json`、`book.yaml` 的卷段、`state/trash/**`。
 * 所有多文件改动都在 `withWorkspaceFileTransaction` 内完成——中途崩溃必须能整体回滚，
 * 半个 manifest 配半个目录树是最难修的一类损坏（design/write-authority.md）。
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile, atomicWriteJson, exists, readJson, readText } from "../atomic-file.js";
import { errorFor, failure, success, type AnyResult } from "../ipc-result.js";
import type { IpcRequestMap } from "../ipc-contract.js";
import {
  addVolume,
  chapterFilePaths,
  ChapterStateStore,
  ensureVolumeDirs,
  mergeManifest,
  moveChapterFiles,
  nextChapterId,
  removeVolumeDirs,
  volumeLabel,
  withChapterWorkspaceLock,
  withWorkspaceFileTransaction,
  type ChapterWorkflowStatus,
} from "@lightee/engine";
import type { ServiceContext } from "./service-context.js";

interface TrashEntry {
  trashId: string;
  kind: "chapter" | "volume";
  deletedAt: number;
  volumeId: string;
  chapterId?: string;
  title: string;
  /** 删除前在 manifest.chapters 中的下标（restore 原位置放回） */
  order: number;
  /** 卷级：该卷在 book.yaml volumes 段下标 */
  volumeOrder?: number;
  chapterCount?: number;
}

interface TrashIndex {
  entries: TrashEntry[];
}

/** trash 保留期：7 天；启动时清理超期批次 */
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 软删除快照目录结构（meta.json + 各关联文件） */
interface VolumeTrashChapter {
  chapterId: string;
  manifestOrder: number;
  manifestEntry: { id: string; title?: string; volume?: string; [key: string]: unknown };
  chapterState: ChapterWorkflowStatus | null;
}

interface TrashMeta {
  kind: "chapter" | "volume";
  volumeId: string;
  chapterId?: string;
  title: string;
  order: number;
  volumeOrder?: number;
  deletedAt: number;
  chapterState?: ChapterWorkflowStatus | null;
  chapterIds?: string[];
  volumeChapters?: VolumeTrashChapter[];
}

export class StructureService {
  constructor(private readonly ctx: ServiceContext) {}

  // ===== 注入面转发（搬移过来的方法体保持零改动） =====
  private workspace(workspaceId: string) { return this.ctx.workspace(workspaceId); }
  private emit: ServiceContext["emit"] = (type, payload) => this.ctx.emit(type, payload);
  private workspaceInfo(root: string, openedAt?: number) { return this.ctx.workspaceInfo(root, openedAt); }
  private touchRegistry(info: Parameters<ServiceContext["touchRegistry"]>[0]) { return this.ctx.touchRegistry(info); }
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> { return this.ctx.enqueue(key, fn); }
  private trackWrite<T>(promise: Promise<T>): Promise<T> { return this.ctx.trackWrite(promise); }

  async renameVolume(request: IpcRequestMap["workspace.renameVolume"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const volume = workspace.info.volumes.find((candidate) => candidate.id === request.volumeId);
    if (!volume) return failure(errorFor("not_found", `Volume not found: ${request.volumeId}`));
    const key = `${workspace.root}:metadata`;
    return this.trackWrite(this.enqueue(key, () => withChapterWorkspaceLock(workspace.root, async () => {
      const path = join(workspace.root, "book.yaml");
      const book = await readText(path);
      const lines = book.split(/\r?\n/);
      let current: string | null = null;
      let changed = false;
      for (let index = 0; index < lines.length; index += 1) {
        const id = /^\s*-\s*id:\s*(\S+)\s*$/.exec(lines[index]!)?.[1];
        if (id) {
          current = id;
          continue;
        }
        if (current === request.volumeId && /^\s*label:\s*/.test(lines[index]!)) {
          const indent = lines[index]!.match(/^\s*/)?.[0] ?? "    ";
          lines[index] = `${indent}label: ${request.name.trim()}`;
          changed = true;
          break;
        }
      }
      if (!changed) return failure(errorFor("invalid_request", `Volume metadata is missing: ${request.volumeId}`));
      await atomicWriteFile(path, `${lines.join("\n").replace(/\n+$/, "")}\n`);
      const refreshed = await this.workspaceInfo(workspace.root, workspace.info.openedAt);
      workspace.info = refreshed;
      await this.touchRegistry(refreshed);
      return success(refreshed);
    })));
  }

  async renameChapter(request: IpcRequestMap["workspace.renameChapter"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const volume = workspace.info.volumes.find((candidate) => candidate.id === request.volumeId);
    if (!volume || !volume.chapters.some((chapter) => chapter.id === request.chapterId)) {
      return failure(errorFor("not_found", `Chapter not found: ${request.volumeId}/${request.chapterId}`));
    }
    const key = `${workspace.root}:metadata`;
    return this.trackWrite(this.enqueue(key, () => withChapterWorkspaceLock(workspace.root, async () => {
      const path = join(workspace.root, "source", "manifest.json");
      const manifest = await readJson<{ book?: string; sourceFormat?: string; chapters?: Array<{ id: string; title: string; volume?: string; [key: string]: unknown }> }>(path, {});
      const chapters = manifest.chapters ?? [];
      const target = chapters.find((chapter) => chapter.id === request.chapterId && (chapter.volume ?? "v01") === request.volumeId);
      if (!target) return failure(errorFor("invalid_request", `Chapter metadata is missing: ${request.volumeId}/${request.chapterId}`));
      const sourcePath = join(workspace.root, "source", request.volumeId, `${request.chapterId}.md`);
      await withWorkspaceFileTransaction(workspace.root, [path, sourcePath], async () => {
        target.title = request.title.trim();
        await atomicWriteJson(path, { ...manifest, chapters });
        if (await exists(sourcePath)) {
          const source = await readText(sourcePath);
          const replaced = source.replace(/^#\s+[^\n]+/m, `# ${request.title.trim()}`);
          await atomicWriteFile(sourcePath, replaced);
        }
      });
      const refreshed = await this.workspaceInfo(workspace.root, workspace.info.openedAt);
      workspace.info = refreshed;
      await this.touchRegistry(refreshed);
      return success(refreshed);
    })));
  }

  // ===== 软删除 trash 辅助 =====
  private trashIndexPath(root: string): string {
    return join(root, "state", "trash", "trash-index.json");
  }

  private trashDir(root: string, trashId: string): string {
    return join(root, "state", "trash", trashId);
  }

  private async readTrashIndex(root: string): Promise<TrashEntry[]> {
    const index = await readJson<TrashIndex | null>(this.trashIndexPath(root), null);
    return index?.entries ?? [];
  }

  private async writeTrashIndex(root: string, entries: TrashEntry[]): Promise<void> {
    await atomicWriteJson(this.trashIndexPath(root), { entries } satisfies TrashIndex);
  }

  private async addTrashEntry(root: string, entry: TrashEntry): Promise<void> {
    const entries = await this.readTrashIndex(root);
    entries.push(entry);
    await this.writeTrashIndex(root, entries);
  }

  private async removeTrashEntry(root: string, trashId: string): Promise<void> {
    const entries = await this.readTrashIndex(root);
    await this.writeTrashIndex(root, entries.filter((entry) => entry.trashId !== trashId));
  }

  private async findTrashEntry(root: string, trashId: string): Promise<TrashEntry | null> {
    const entries = await this.readTrashIndex(root);
    return entries.find((entry) => entry.trashId === trashId) ?? null;
  }

  /** 启动时清理超期 trash 批次（7 天） */
  async pruneExpiredTrash(root: string): Promise<void> {
    try {
      const entries = await this.readTrashIndex(root);
      const cutoff = Date.now() - TRASH_RETENTION_MS;
      const expired = entries.filter((entry) => entry.deletedAt < cutoff);
      if (expired.length === 0) return;
      for (const entry of expired) {
        await rm(this.trashDir(root, entry.trashId), { recursive: true, force: true }).catch(() => undefined);
      }
      await this.writeTrashIndex(root, entries.filter((entry) => entry.deletedAt >= cutoff));
    } catch {
      // trash 清理失败不阻塞启动
    }
  }

  // ===== chapter.create =====
  async createChapter(request: IpcRequestMap["chapter.create"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:metadata`;
    return this.trackWrite(this.enqueue(key, () => withChapterWorkspaceLock(workspace.root, async () => {
      const title = (request.title ?? "新章节").trim() || "新章节";
      const targetExists = workspace.info.volumes.some((candidate) => candidate.id === request.volumeId);
      const chapterId = await nextChapterId({ root: workspace.root }, request.volumeId);
      const sourcePath = join(workspace.root, "source", request.volumeId, `${chapterId}.md`);
      const manifestPath = join(workspace.root, "source", "manifest.json");
      const transactionPaths = [
        join(workspace.root, "book.yaml"), manifestPath, sourcePath,
        join(workspace.root, "state", "chapter_state.json"),
      ];
      if (!targetExists) transactionPaths.push(
        join(workspace.root, "source", request.volumeId),
        join(workspace.root, "translations", request.volumeId),
        join(workspace.root, "resources", request.volumeId),
      );
      await withWorkspaceFileTransaction(workspace.root, transactionPaths, async () => {
        if (!targetExists) await addVolume({ root: workspace.root }, request.volumeId, volumeLabel(request.volumeId));
        await ensureVolumeDirs({ root: workspace.root }, request.volumeId);
        const sourceText = request.source?.trim() ? request.source.trim() : `# ${title}\n`;
        await atomicWriteFile(sourcePath, sourceText);
        await mergeManifest({ root: workspace.root }, {
          book: workspace.info.name,
          chapters: [{ id: chapterId, title, charCount: 0, volume: request.volumeId }],
          sourceFormat: "md",
        }, { insertAfter: request.afterChapterId });
        await new ChapterStateStore(workspace.root).ensureChapter(chapterId);
      });
      const refreshed = await this.workspaceInfo(workspace.root, workspace.info.openedAt);
      workspace.info = refreshed;
      await this.touchRegistry(refreshed);
      this.emit("workspace.changed", { action: "structure", workspaceId: request.workspaceId, reason: "chapter-created" });
      return success({ status: "created" as const, workspaceId: request.workspaceId, volumeId: request.volumeId, chapterId, title });
    })));
  }

  // ===== chapter.delete（软删除）=====
  async deleteChapter(request: IpcRequestMap["chapter.delete"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:metadata`;
    return this.trackWrite(this.enqueue(key, () => withChapterWorkspaceLock(workspace.root, async () => {
      const manifestPath = join(workspace.root, "source", "manifest.json");
      const manifest = await readJson<{ chapters?: Array<{ id: string; title?: string; volume?: string }> }>(manifestPath, {});
      const chapters = manifest.chapters ?? [];
      const index = chapters.findIndex((chapter) => chapter.id === request.chapterId && (chapter.volume ?? "v01") === request.volumeId);
      if (index < 0) return failure(errorFor("not_found", `Chapter not found: ${request.volumeId}/${request.chapterId}`));
      const removed = chapters[index]!;
      const trashId = `tr-${randomUUID().slice(0, 8)}`;
      const trashPath = this.trashDir(workspace.root, trashId);
      const meta: TrashMeta = { kind: "chapter", volumeId: request.volumeId, chapterId: request.chapterId, title: removed.title ?? request.chapterId, order: index, deletedAt: Date.now() };
      const paths = chapterFilePaths({ root: workspace.root }, request.volumeId, request.chapterId);
      const stateStore = new ChapterStateStore(workspace.root);
      const chapterState = await stateStore.readChapter(request.chapterId);
      if (chapterState.state !== "imported" || chapterState.transitionCount > 0) {
        meta.chapterState = chapterState;
      }
      await withWorkspaceFileTransaction(workspace.root, [
        manifestPath,
        ...Object.values(paths),
        join(workspace.root, "state", "chapter_state.json"),
        this.trashIndexPath(workspace.root),
        trashPath,
      ], async () => {
        await mkdir(trashPath, { recursive: true });
        for (const key of ["src", "translation", "draft", "checkpoint", "correction"] as const) {
          const filePath = paths[key];
          if (await exists(filePath)) {
            await atomicWriteFile(join(trashPath, `${key}.data`), await readFile(filePath, "utf8"));
          }
        }
        await atomicWriteJson(join(trashPath, "meta.json"), meta);
        // 从 manifest 移除 + 物理删除
        chapters.splice(index, 1);
        await atomicWriteJson(manifestPath, { ...manifest, chapters });
        for (const key of ["src", "translation", "draft", "checkpoint", "correction"] as const) {
          if (await exists(paths[key])) await rm(paths[key], { force: true });
        }
        await stateStore.removeChapter(request.chapterId);
        await this.addTrashEntry(workspace.root, { trashId, kind: "chapter", deletedAt: meta.deletedAt, volumeId: request.volumeId, chapterId: request.chapterId, title: removed.title ?? request.chapterId, order: index });
      });
      const refreshed = await this.workspaceInfo(workspace.root, workspace.info.openedAt);
      workspace.info = refreshed;
      await this.touchRegistry(refreshed);
      this.emit("workspace.changed", { action: "structure", workspaceId: request.workspaceId, reason: "chapter-deleted" });
      return success({ status: "deleted" as const, workspaceId: request.workspaceId, volumeId: request.volumeId, chapterId: request.chapterId, title: removed.title ?? request.chapterId, trashId, deletedAt: meta.deletedAt });
    })));
  }

  // ===== chapter.restore =====
  async restoreChapter(request: IpcRequestMap["chapter.restore"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:metadata`;
    return this.trackWrite(this.enqueue(key, () => withChapterWorkspaceLock(workspace.root, async () => {
      const entry = await this.findTrashEntry(workspace.root, request.trashId);
      if (!entry || entry.kind !== "chapter" || !entry.chapterId) return failure(errorFor("not_found", `Trash entry not found: ${request.trashId}`));
      const chapterId = entry.chapterId;
      const trashPath = this.trashDir(workspace.root, request.trashId);
      const meta = await readJson<TrashMeta | null>(join(trashPath, "meta.json"), null);
      if (!meta) return failure(errorFor("not_found", `Trash meta not found: ${request.trashId}`));
      const manifestPath = join(workspace.root, "source", "manifest.json");
      const manifest = await readJson<{ chapters?: Array<{ id: string; title?: string; volume?: string }> }>(manifestPath, {});
      const chapters = manifest.chapters ?? [];
      if (chapters.some((chapter) => chapter.id === chapterId)) {
        return failure(errorFor("conflict", `Cannot restore ${chapterId}: chapter id already exists`, false, { chapterId }));
      }
      // 冲突检查通过后才允许写 live 文件。
      const paths = chapterFilePaths({ root: workspace.root }, entry.volumeId, chapterId);
      await withWorkspaceFileTransaction(workspace.root, [
        join(workspace.root, "book.yaml"),
        manifestPath,
        ...Object.values(paths),
        join(workspace.root, "state", "chapter_state.json"),
        this.trashIndexPath(workspace.root),
        trashPath,
      ], async () => {
        if (!workspace.info.volumes.some((volume) => volume.id === entry.volumeId)) {
          await addVolume({ root: workspace.root }, entry.volumeId, volumeLabel(entry.volumeId));
        }
        await ensureVolumeDirs({ root: workspace.root }, entry.volumeId);
        for (const key of ["src", "translation", "draft", "checkpoint", "correction"] as const) {
          const dataPath = join(trashPath, `${key}.data`);
          if (await exists(dataPath)) {
            await mkdir(dirname(paths[key]), { recursive: true });
            await atomicWriteFile(paths[key], await readFile(dataPath, "utf8"));
          }
        }
        const insertAt = Math.min(entry.order, chapters.length);
        chapters.splice(insertAt, 0, { id: chapterId, title: entry.title, volume: entry.volumeId });
        await atomicWriteJson(manifestPath, { ...manifest, chapters });
        if (meta.chapterState) {
          await new ChapterStateStore(workspace.root).restoreChapter(chapterId, meta.chapterState);
        } else {
          await new ChapterStateStore(workspace.root).ensureChapter(chapterId);
        }
        await this.removeTrashEntry(workspace.root, request.trashId);
        await rm(trashPath, { recursive: true, force: true });
      });
      const refreshed = await this.workspaceInfo(workspace.root, workspace.info.openedAt);
      workspace.info = refreshed;
      await this.touchRegistry(refreshed);
      this.emit("workspace.changed", { action: "structure", workspaceId: request.workspaceId, reason: "chapter-restored" });
      return success({ status: "restored" as const, workspaceId: request.workspaceId, volumeId: entry.volumeId, chapterId: entry.chapterId, title: entry.title, restoredAt: Date.now() });
    })));
  }

  // ===== chapter.move =====
  async moveChapter(request: IpcRequestMap["chapter.move"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:metadata`;
    return this.trackWrite(this.enqueue(key, () => withChapterWorkspaceLock(workspace.root, async () => {
      const manifestPath = join(workspace.root, "source", "manifest.json");
      const manifest = await readJson<{ chapters?: Array<{ id: string; title?: string; volume?: string }> }>(manifestPath, {});
      const chapters = manifest.chapters ?? [];
      const index = chapters.findIndex((chapter) => chapter.id === request.chapterId);
      if (index < 0) return failure(errorFor("not_found", `Chapter not found: ${request.chapterId}`));
      const moved = chapters[index]!;
      const fromVol = moved.volume ?? "v01";
      if (request.afterChapterId === request.chapterId) {
        return failure(errorFor("invalid_request", "A chapter cannot be positioned after itself"));
      }
      if (request.afterChapterId) {
        const anchor = chapters.find((chapter) => chapter.id === request.afterChapterId);
        if (!anchor) return failure(errorFor("not_found", `Anchor chapter not found: ${request.afterChapterId}`));
        if ((anchor.volume ?? "v01") !== request.targetVolumeId) {
          return failure(errorFor("invalid_request", `Anchor chapter ${request.afterChapterId} is not in ${request.targetVolumeId}`));
        }
      }
      const targetExists = workspace.info.volumes.some((volume) => volume.id === request.targetVolumeId);
      const fromPaths = chapterFilePaths({ root: workspace.root }, fromVol, request.chapterId);
      const toPaths = chapterFilePaths({ root: workspace.root }, request.targetVolumeId, request.chapterId);
      const transactionPaths = [join(workspace.root, "book.yaml"), manifestPath, fromPaths.src, toPaths.src];
      if (!targetExists) transactionPaths.push(
        join(workspace.root, "source", request.targetVolumeId),
        join(workspace.root, "translations", request.targetVolumeId),
        join(workspace.root, "resources", request.targetVolumeId),
      );
      await withWorkspaceFileTransaction(workspace.root, transactionPaths, async () => {
        if (!targetExists) await addVolume({ root: workspace.root }, request.targetVolumeId, volumeLabel(request.targetVolumeId));
        await ensureVolumeDirs({ root: workspace.root }, request.targetVolumeId);
        chapters.splice(index, 1);
        if (fromVol !== request.targetVolumeId) {
          await moveChapterFiles({ root: workspace.root }, fromVol, request.targetVolumeId, request.chapterId);
        }
        const targetIndexes = chapters
          .map((chapter, chapterIndex) => ({ chapter, chapterIndex }))
          .filter(({ chapter }) => (chapter.volume ?? "v01") === request.targetVolumeId);
        const insertAt = request.atStart
          ? (targetIndexes[0]?.chapterIndex ?? chapters.length)
          : request.afterChapterId
            ? chapters.findIndex((chapter) => chapter.id === request.afterChapterId) + 1
            : (targetIndexes.length > 0 ? targetIndexes[targetIndexes.length - 1]!.chapterIndex + 1 : chapters.length);
        moved.volume = request.targetVolumeId;
        chapters.splice(insertAt, 0, moved);
        await atomicWriteJson(manifestPath, { ...manifest, chapters });
      });
      const order = chapters.filter((chapter) => (chapter.volume ?? "v01") === request.targetVolumeId).map((chapter) => chapter.id);
      const refreshed = await this.workspaceInfo(workspace.root, workspace.info.openedAt);
      workspace.info = refreshed;
      await this.touchRegistry(refreshed);
      this.emit("workspace.changed", { action: "structure", workspaceId: request.workspaceId, reason: "chapter-moved" });
      return success({ status: "moved" as const, workspaceId: request.workspaceId, chapterId: request.chapterId, volumeId: request.targetVolumeId, afterChapterId: request.afterChapterId, order });
    })));
  }

  // ===== volume.delete =====
  async deleteVolume(request: IpcRequestMap["volume.delete"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:metadata`;
    return this.trackWrite(this.enqueue(key, () => withChapterWorkspaceLock(workspace.root, async () => {
      const volume = workspace.info.volumes.find((candidate) => candidate.id === request.volumeId);
      if (!volume) return failure(errorFor("not_found", `Volume not found: ${request.volumeId}`));
      const chapterIds = volume.chapters.map((chapter) => chapter.id);
      const manifestPath = join(workspace.root, "source", "manifest.json");
      const manifest = await readJson<{ chapters?: Array<{ id: string; title?: string; volume?: string; [key: string]: unknown }> }>(manifestPath, {});
      const chapters = manifest.chapters ?? [];
      const stateStore = new ChapterStateStore(workspace.root);
      const volumeChapters: VolumeTrashChapter[] = await Promise.all(chapters
        .map((chapter, manifestOrder) => ({ chapter, manifestOrder }))
        .filter(({ chapter }) => (chapter.volume ?? "v01") === request.volumeId)
        .map(async ({ chapter, manifestOrder }) => ({
          chapterId: chapter.id,
          manifestOrder,
          manifestEntry: { ...chapter },
          chapterState: await stateStore.readChapter(chapter.id),
        })));
      const trashId = `tr-${randomUUID().slice(0, 8)}`;
      const trashPath = this.trashDir(workspace.root, trashId);
      const volumeOrder = workspace.info.volumes.findIndex((candidate) => candidate.id === request.volumeId);
      const meta: TrashMeta = { kind: "volume", volumeId: request.volumeId, title: volume.label, order: volumeOrder, volumeOrder, deletedAt: Date.now(), chapterIds, volumeChapters };
      const transactionPaths = [
        join(workspace.root, "book.yaml"), manifestPath,
        join(workspace.root, "state", "chapter_state.json"), this.trashIndexPath(workspace.root), trashPath,
        join(workspace.root, "source", request.volumeId),
        join(workspace.root, "translations", request.volumeId),
        join(workspace.root, "resources", request.volumeId),
      ];
      for (const chapterId of chapterIds) transactionPaths.push(...Object.values(chapterFilePaths({ root: workspace.root }, request.volumeId, chapterId)));
      await withWorkspaceFileTransaction(workspace.root, transactionPaths, async () => {
      await mkdir(trashPath, { recursive: true });
      // 快照各章节文件
      for (const chapterId of chapterIds) {
        const paths = chapterFilePaths({ root: workspace.root }, request.volumeId, chapterId);
        for (const fileKey of ["src", "translation", "draft", "checkpoint", "correction"] as const) {
          if (await exists(paths[fileKey])) {
            const content = await readFile(paths[fileKey], "utf8");
            await atomicWriteFile(join(trashPath, `${chapterId}.${fileKey}.data`), content);
          }
        }
      }
      await atomicWriteJson(join(trashPath, "meta.json"), meta);
      // 移除 manifest 条目 + 目录 + workflow
      const remaining = chapters.filter((chapter) => (chapter.volume ?? "v01") !== request.volumeId);
      await atomicWriteJson(manifestPath, { ...manifest, chapters: remaining });
      await removeVolumeDirs({ root: workspace.root }, request.volumeId);
      for (const chapterId of chapterIds) await stateStore.removeChapter(chapterId);
      // book.yaml 移除卷条目
      const bookPath = join(workspace.root, "book.yaml");
      const book = await readText(bookPath);
      const bookLines = book.split(/\r?\n/);
      let current: string | null = null;
      const filtered: string[] = [];
      for (const line of bookLines) {
        const id = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)?.[1];
        if (id) { current = id; if (current === request.volumeId) continue; }
        if (current !== request.volumeId) filtered.push(line);
        if (current === request.volumeId && /^\s*label:/.test(line)) continue;
      }
      await atomicWriteFile(bookPath, `${filtered.join("\n").replace(/\n+$/, "")}\n`);
      await this.addTrashEntry(workspace.root, { trashId, kind: "volume", deletedAt: meta.deletedAt, volumeId: request.volumeId, title: volume.label, order: meta.order, volumeOrder: meta.volumeOrder, chapterCount: chapterIds.length });
      });
      const refreshed = await this.workspaceInfo(workspace.root, workspace.info.openedAt);
      workspace.info = refreshed;
      await this.touchRegistry(refreshed);
      this.emit("workspace.changed", { action: "structure", workspaceId: request.workspaceId, reason: "volume-deleted" });
      return success({ status: "deleted" as const, workspaceId: request.workspaceId, volumeId: request.volumeId, trashId, chapterCount: chapterIds.length, deletedAt: meta.deletedAt });
    })));
  }

  // ===== volume.restore =====
  async restoreVolume(request: IpcRequestMap["volume.restore"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:metadata`;
    return this.trackWrite(this.enqueue(key, () => withChapterWorkspaceLock(workspace.root, async () => {
      const entry = await this.findTrashEntry(workspace.root, request.trashId);
      if (!entry || entry.kind !== "volume") return failure(errorFor("not_found", `Trash entry not found: ${request.trashId}`));
      const trashPath = this.trashDir(workspace.root, request.trashId);
      const meta = await readJson<TrashMeta | null>(join(trashPath, "meta.json"), null);
      if (!meta) return failure(errorFor("not_found", `Trash meta not found: ${request.trashId}`));
      // 恢复前完整验证，禁止覆盖删除后新建的同 ID 章节。
      const manifestPath = join(workspace.root, "source", "manifest.json");
      const manifest = await readJson<{ chapters?: Array<{ id: string; title?: string; volume?: string; [key: string]: unknown }> }>(manifestPath, {});
      const chapters = manifest.chapters ?? [];
      const snapshots = meta.volumeChapters ?? (meta.chapterIds ?? []).map((chapterId, index) => ({
        chapterId,
        manifestOrder: meta.order + index,
        manifestEntry: { id: chapterId, title: chapterId, volume: entry.volumeId },
        chapterState: null,
      }));
      const chapterIds = snapshots.map((snapshot) => snapshot.chapterId);
      const conflicts = chapterIds.filter((chapterId) => chapters.some((chapter) => chapter.id === chapterId));
      if (conflicts.length > 0) return failure(errorFor("conflict", `Cannot restore volume: chapter ids already exist (${conflicts.join(", ")})`, false, { chapterIds: conflicts }));
      const transactionPaths = [
        join(workspace.root, "book.yaml"), manifestPath,
        join(workspace.root, "state", "chapter_state.json"), this.trashIndexPath(workspace.root), trashPath,
        join(workspace.root, "source", entry.volumeId),
        join(workspace.root, "translations", entry.volumeId),
        join(workspace.root, "resources", entry.volumeId),
      ];
      for (const chapterId of chapterIds) transactionPaths.push(...Object.values(chapterFilePaths({ root: workspace.root }, entry.volumeId, chapterId)));
      await withWorkspaceFileTransaction(workspace.root, transactionPaths, async () => {
      await addVolume(
        { root: workspace.root },
        entry.volumeId,
        meta.title || volumeLabel(entry.volumeId),
        { at: meta.volumeOrder ?? meta.order },
      );
      await ensureVolumeDirs({ root: workspace.root }, entry.volumeId);
      // 恢复各章节文件、manifest 元数据和 workflow。
      const stateStore = new ChapterStateStore(workspace.root);
      for (const snapshot of snapshots) {
        const chapterId = snapshot.chapterId;
        const paths = chapterFilePaths({ root: workspace.root }, entry.volumeId, chapterId);
        for (const fileKey of ["src", "translation", "draft", "checkpoint", "correction"] as const) {
          const dataPath = join(trashPath, `${chapterId}.${fileKey}.data`);
          if (await exists(dataPath)) {
            await mkdir(dirname(paths[fileKey]), { recursive: true });
            await atomicWriteFile(paths[fileKey], await readFile(dataPath, "utf8"));
          }
        }
        const insertAt = Math.min(snapshot.manifestOrder, chapters.length);
        chapters.splice(insertAt, 0, { ...snapshot.manifestEntry, id: chapterId, volume: entry.volumeId });
        if (snapshot.chapterState) await stateStore.restoreChapter(chapterId, snapshot.chapterState);
        else await stateStore.ensureChapter(chapterId);
      }
      await atomicWriteJson(manifestPath, { ...manifest, chapters });
      await this.removeTrashEntry(workspace.root, request.trashId);
      await rm(trashPath, { recursive: true, force: true });
      });
      const refreshed = await this.workspaceInfo(workspace.root, workspace.info.openedAt);
      workspace.info = refreshed;
      await this.touchRegistry(refreshed);
      this.emit("workspace.changed", { action: "structure", workspaceId: request.workspaceId, reason: "volume-restored" });
      return success({ status: "restored" as const, workspaceId: request.workspaceId, volumeId: entry.volumeId, chapterCount: chapterIds.length, restoredAt: Date.now() });
    })));
  }
}
