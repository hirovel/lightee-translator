/**
 * TXT BookSource —— 分章 + 导入（官方 Wiki：规则优先，失败标记人工确认）。
 * 卷支持（官方 Wiki 导入章节）：source/{volumeId}/chXXX.md · manifest 合并 · 卷标题自动识别。
 */

import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "@lightee/core/atomic-fs";
import { join } from "node:path";
import type { Workspace } from "./workspace.ts";
import {
  addVolume,
  ensureVolumeDirs,
  nextVolumeId,
  volumeLabel,
} from "./workspace.ts";
import { detectVolumeTitle } from "@lightee/core/epub-parse";
import { allocateChapterIds, assertUniqueChapterIds } from "./chapter-fs.ts";

export interface ChapterMeta {
  id: string;
  title: string;
  charCount: number;
  volume: string;
  needsManualConfirm?: boolean;
}

export interface BookManifest {
  book: string;
  chapters: ChapterMeta[];
  sourceFormat: string;
}

/** 章节标题模式（规则优先） */
const CHAPTER_RE =
  /^(第[一二三四五六七八九十百千万0-9０-９]+[章話话]|プロローグ|エピローグ|幕間|間章|序章|終章|终章|番外編|短編|第一章|第二章)/;

export function splitChapters(text: string): Array<{ title: string; content: string; needsManualConfirm?: boolean }> {
  const lines = text.split("\n");
  const chapters: Array<{ title: string; content: string; needsManualConfirm?: boolean }> = [];
  let current: { title: string; content: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    chapters.push({ title: current.title, content: current.content.join("\n").trim() });
    current = null;
  };

  for (const line of lines) {
    const t = line.trim();
    if (t && CHAPTER_RE.test(t)) {
      flush();
      current = { title: t, content: [] };
    } else {
      if (!current) current = { title: "本文", content: [] };
      current.content.push(line);
    }
  }
  flush();

  if (chapters.length === 1 && chapters[0]!.title === "本文") {
    chapters[0]!.needsManualConfirm = true;
  }
  return chapters;
}

export interface ImportTxtOptions {
  /** 直接提供文本（测试用；不提供则读 srcPath） */
  sourceText?: string;
  /** 显式卷 id（缺省: 卷标题识别 → 自动下一卷） */
  volumeId?: string;
  /** 卷标签（缺省: 第N卷） */
  volumeLabel?: string;
  /** 来源名（manifest.book，缺省: 文件名） */
  bookName?: string;
}

/** 导入 TXT 书（卷感知 + manifest 合并） */
export async function importTxtBook(
  srcPath: string,
  ws: Workspace,
  opts: ImportTxtOptions = {}
): Promise<BookManifest> {
  const raw = opts.sourceText ?? (await readFile(srcPath, "utf-8"));

  // 卷决定：显式 > 文本卷标题识别 > 自动下一卷
  let volumeId = opts.volumeId;
  if (!volumeId) {
    const detected = detectVolumeTitle(raw);
    volumeId = detected ?? (await nextVolumeId(ws));
  }
  const label = opts.volumeLabel ?? volumeLabel(volumeId);
  await addVolume(ws, volumeId, label);
  await ensureVolumeDirs(ws, volumeId);

  const chapters = splitChapters(raw);
  const chapterIds = await allocateChapterIds(ws, chapters.length);

  const metas: ChapterMeta[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]!;
    const id = chapterIds[i]!;
    const content = `# ${ch.title}\n\n${ch.content}\n`;
    await atomicWriteFile(join(ws.root, "source", volumeId, `${id}.md`), content);
    metas.push({
      id,
      title: ch.title,
      charCount: ch.content.length,
      volume: volumeId,
      needsManualConfirm: ch.needsManualConfirm,
    });
  }

  const manifest = await mergeManifest(ws, {
    book: opts.bookName ?? srcPath.split(/[\\/]/).pop() ?? "book.txt",
    chapters: metas,
    sourceFormat: "txt",
  });
  return manifest;
}

/** 合并 manifest（读旧 → 追加/插入 → 写回）。insertAfter 给定则把 next.chapters 插到该章节之后。 */
export async function mergeManifest(ws: Workspace, next: BookManifest, opts: { insertAfter?: string } = {}): Promise<BookManifest> {
  const manifestPath = join(ws.root, "source", "manifest.json");
  let existing: BookManifest | null = null;
  try {
    existing = JSON.parse(await readFile(manifestPath, "utf-8")) as BookManifest;
  } catch {
    existing = null;
  }
  const baseChapters = existing?.chapters ?? [];
  let chapters: typeof baseChapters;
  const after = opts.insertAfter ? baseChapters.findIndex((chapter) => chapter.id === opts.insertAfter) : -1;
  if (after >= 0) {
    chapters = [...baseChapters.slice(0, after + 1), ...next.chapters, ...baseChapters.slice(after + 1)];
  } else {
    chapters = [...baseChapters, ...next.chapters];
  }
  assertUniqueChapterIds(chapters);
  const merged: BookManifest = {
    book: next.book,
    chapters,
    sourceFormat: next.sourceFormat,
  };
  await atomicWriteFile(manifestPath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
