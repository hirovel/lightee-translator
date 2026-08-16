/**
 * import-pipeline：统一导入入口（文件 / 文本 / 分步导入）。
 *
 * 分发表（见 docs/lightee-wiki.md 导入章节）:
 *   /import <路径>   .epub → epub 管线 · .txt/.md → txt 管线（自动分章→预览确认）
 *   /import step    分步导入（"导入一卷"心智：粘贴→章节名→循环→汇总确认）
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "./workspace.ts";
import { addVolume, ensureVolumeDirs, nextVolumeId, volumeLabel } from "./workspace.ts";
import { allocateChapterIds } from "./chapter-fs.ts";
import { importTxtBook, mergeManifest, splitChapters, type BookManifest, type ChapterMeta } from "./txt-import.ts";
import { parseEpub, detectVolumeTitle } from "@lightee/core/epub-parse";

// ===== 统一入口 =====
export async function importFile(path: string, ws: Workspace, opts: { volumeId?: string } = {}): Promise<BookManifest> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "epub") {
    return importEpubFile(path, ws, opts);
  }
  if (ext === "txt" || ext === "md") {
    return importTxtBook(path, ws, opts);
  }
  throw new Error(`不支持的格式 .${ext}（支持 .epub/.txt/.md）`);
}

// ===== EPUB 导入 =====
export async function importEpubFile(path: string, ws: Workspace, opts: { volumeId?: string } = {}): Promise<BookManifest> {
  const data = await readFile(path);
  const parsed = await parseEpub(data);

  // EV-01：EPUB 自带分卷（parseEpub 标出 ≥2 个分节）且用户没显式指定目标卷 → 按原书分卷落盘。
  // 显式指定 = 用户的选择，照旧整本并入该卷。
  // 分组按**分节序号**而非标题——kakuyomu 连载书的「幕間」会出现多次，按名字归并会打乱原书结构。
  const volumeGroups = epubVolumeGroups(parsed.chapters);
  const chapterVolumeIds: string[] = [];
  if (!opts.volumeId && volumeGroups.length >= 2) {
    // 卷 id：从卷标题识别（第N巻→vNN）优先；认不出或本次已占用则顺延下一卷。
    // 识别出的 id 撞上工作区既有卷时不另起新卷——与整本导入按书名识别落入既有卷的语义一致（重导合并）。
    const idByKey = new Map<number, string>();
    const usedIds = new Set<string>();
    for (const group of volumeGroups) {
      let id = detectVolumeTitle(group.title);
      if (!id || usedIds.has(id)) id = await nextVolumeId(ws);
      usedIds.add(id);
      idByKey.set(group.key, id);
      // label 用原书卷标题——这正是「保留原书分卷」的可见形态；vNN 的通用中文名只在识别失败时兜底
      await addVolume(ws, id, group.title.trim() || volumeLabel(id));
      await ensureVolumeDirs(ws, id);
    }
    for (const ch of parsed.chapters) chapterVolumeIds.push(idByKey.get(ch.volumeIndex!)!);
  } else {
    // 卷决定：显式 > 书名卷标题识别 > 自动下一卷
    let volumeId = opts.volumeId;
    if (!volumeId) {
      const detected = detectVolumeTitle(parsed.title);
      volumeId = detected ?? (await nextVolumeId(ws));
    }
    await addVolume(ws, volumeId, volumeLabel(volumeId));
    await ensureVolumeDirs(ws, volumeId);
    for (let i = 0; i < parsed.chapters.length; i++) chapterVolumeIds.push(volumeId);
  }

  const chapterIds = await allocateChapterIds(ws, parsed.chapters.length);
  const metas: ChapterMeta[] = [];

  for (let i = 0; i < parsed.chapters.length; i++) {
    const ch = parsed.chapters[i]!;
    const id = chapterIds[i]!;
    const volumeId = chapterVolumeIds[i]!;
    // 原文 md：标题 + 段落（带格式标记与 [插图:] 标记）。
    //
    // 多数 EPUB 的章节正文首段就是章节标题本身（parseEpub 会把它读成 heading 段），
    // 而这里又要在最前面补一行 `# 标题`——不去重的话每一章都会有两行同样的标题。
    // 实测「悪役令嬢の中の人」46/46 章全中，翻译时这一行还会被翻两遍。
    const dedupedParagraphs = ch.paragraphs[0]?.kind === "heading" && ch.paragraphs[0].text.trim() === ch.title.trim()
      ? ch.paragraphs.slice(1)
      : ch.paragraphs;
    const body = dedupedParagraphs
      .map((p) => (p.kind === "heading" ? `# ${p.text}` : p.text))
      .join("\n\n");
    const content = `# ${ch.title}\n\n${body}\n`;
    await importWrite(join(ws.root, "source", volumeId, `${id}.md`), content);

    // 插图落盘 resources/{volumeId}/
    for (const img of ch.images) {
      const buf = parsed.images.get(img.name);
      if (buf) {
        await importWrite(join(ws.root, "resources", volumeId, img.name), buf);
      }
    }

    metas.push({
      id,
      title: ch.title,
      charCount: body.length,
      volume: volumeId,
    });
  }

  const manifest = await mergeManifest(ws, {
    book: parsed.title,
    chapters: metas,
    sourceFormat: "epub",
  });
  return manifest;
}

/**
 * 分节表（出现顺序）。key = parseEpub 的分节序号，title 可重复（同名分节各自独立）。
 * 任一章缺分节标注 → 视为无分卷（parseEpub 保证全有或全无，这里只是防御）。
 */
function epubVolumeGroups(chapters: Array<{ volumeTitle?: string; volumeIndex?: number }>): Array<{ key: number; title: string }> {
  const groups: Array<{ key: number; title: string }> = [];
  for (const ch of chapters) {
    if (ch.volumeIndex === undefined || ch.volumeTitle === undefined) return [];
    if (!groups.some((g) => g.key === ch.volumeIndex)) groups.push({ key: ch.volumeIndex, title: ch.volumeTitle });
  }
  return groups;
}

// ===== 导入预览（dry-run，不落盘——E1 分章预览确认）=====
export interface ImportPreview {
  ext: string;
  chapters: Array<{ title: string; charCount: number; needsManualConfirm?: boolean; volume?: string; volumeIndex?: number }>;
  /** 卷提示（文本首行第N巻） */
  volumeHint?: string;
  /**
   * EPUB 自带分卷（EV-01）：≥2 个分节才出现；确认对话框据此画分组。
   * 章节的 volumeIndex 对齐本数组下标——标题可重复（幕間×N），只有下标能把分节对上。
   */
  volumes?: Array<{ title: string; chapters: number }>;
}

export async function previewImport(path: string): Promise<ImportPreview> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "epub") {
    const data = await readFile(path);
    const parsed = await parseEpub(data);
    const groups = epubVolumeGroups(parsed.chapters);
    const positionByKey = new Map(groups.map((g, position) => [g.key, position]));
    return {
      ext,
      chapters: parsed.chapters.map((c) => ({
        title: c.title,
        charCount: c.paragraphs.reduce((s, p) => s + p.text.length, 0),
        ...(groups.length >= 2 && c.volumeIndex !== undefined
          ? { volume: c.volumeTitle, volumeIndex: positionByKey.get(c.volumeIndex) }
          : {}),
      })),
      ...(groups.length >= 2
        ? { volumes: groups.map((g) => ({ title: g.title, chapters: parsed.chapters.filter((c) => c.volumeIndex === g.key).length })) }
        : {}),
    };
  }
  if (ext === "txt" || ext === "md") {
    const raw = await readFile(path, "utf-8");
    const chapters = splitChapters(raw);
    return {
      ext,
      chapters: chapters.map((c) => ({
        title: c.title,
        charCount: c.content.length,
        needsManualConfirm: c.needsManualConfirm,
      })),
      volumeHint: detectVolumeTitle(raw) ?? undefined,
    };
  }
  throw new Error(`不支持的格式 .${ext}（支持 .epub/.txt/.md）`);
}

// ===== 分步导入（/import step 数据操作）=====
export interface StepChapter {
  title: string;
  content: string;
}

export interface StepSession {
  volumeId: string;
  volumeLabel: string;
  chapters: StepChapter[];
}

/** 开始分步导入：决定卷（显式 > 默认下一卷） */
export async function beginStep(ws: Workspace, opts: { volumeId?: string } = {}): Promise<StepSession> {
  const volumeId = opts.volumeId ?? (await nextVolumeId(ws));
  const label = volumeLabel(volumeId);
  await addVolume(ws, volumeId, label);
  await ensureVolumeDirs(ws, volumeId);
  return { volumeId, volumeLabel: label, chapters: [] };
}

/** 分步导入完成：落盘章节 + 合并 manifest */
export async function finishStep(ws: Workspace, session: StepSession): Promise<BookManifest> {
  const chapterIds = await allocateChapterIds(ws, session.chapters.length);
  const metas: ChapterMeta[] = [];
  for (let i = 0; i < session.chapters.length; i++) {
    const ch = session.chapters[i]!;
    const id = chapterIds[i]!;
    await importWrite(join(ws.root, "source", session.volumeId, `${id}.md`), `# ${ch.title}\n\n${ch.content}\n`);
    metas.push({
      id,
      title: ch.title,
      charCount: ch.content.length,
      volume: session.volumeId,
    });
  }
  return mergeManifest(ws, {
    book: "step-import",
    chapters: metas,
    sourceFormat: "step",
  });
}

// ===== 工具 =====
import { atomicWriteFile } from "@lightee/core/atomic-fs";
async function importWrite(path: string, content: string | Buffer): Promise<void> {
  await atomicWriteFile(path, content);
}
