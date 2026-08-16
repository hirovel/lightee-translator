/**
 * export-one —— 导出（TUI /export 真实实现）。
 * epub: 再生式 EPUB3（generateEpub，单章或全卷）
 * txt/md: 直接拼译文
 */

import { readFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Workspace } from "./workspace.ts";
import { generateEpub, type EpubExportChapter } from "@lightee/core/epub-write";
import { atomicWriteFile } from "@lightee/core/atomic-fs";
import { chapterPaths, readChapterCatalog, requireChapter, stagingTranslationPath, type ChapterCatalog, type ChapterCatalogEntry } from "./chapter-fs.ts";

/**
 * 导出结果的构成（RV-07）。作者想导出不该受任何阻碍，代价是产物里可能混着未定稿的稿子，
 * 所以必须如实交代这本书是由什么拼出来的。
 */
export interface ExportResult {
  outPath: string;
  /** 实际写进产物的章节 */
  exported: string[];
  /** 其中读的是 state/staging（有译文但还没定稿） */
  fromStaging: string[];
  /** 没有任何译文、被跳过的章节。**绝不用原文占位**——中日混排的书流出去是第一类事故。 */
  skipped: string[];
}

/** 译文来源：定稿优先，其次暂存稿；都没有就是真没有。 */
function resolveTranslationSource(ws: Workspace, meta: { id: string; volume?: string }): { path: string; staging: boolean } | null {
  const approved = chapterPaths(ws, meta).translation;
  if (existsSync(approved)) return { path: approved, staging: false };
  const staging = stagingTranslationPath(ws.root, meta.id);
  if (existsSync(staging)) return { path: staging, staging: true };
  return null;
}

/**
 * 导出目标：单章 id、`"all"`（全书），或一组章节 id（作者在导出面板里勾选的那些）。
 *
 * 多选与 all 走同一条「缺译文就跳过」的路：作者勾了 20 章、其中 3 章还没译，
 * 该给他那 17 章并如实说跳过了哪 3 章，而不是整次失败。只有**单章**导出失败才合理——
 * 他点的就是这一章。
 */
export type ExportTarget = string | readonly string[];

/** 单章导出（不是 all、也不是多选）——只有它「缺译文 = 报错」 */
function isSingle(target: ExportTarget): boolean {
  if (Array.isArray(target)) return target.length === 1;
  return typeof target === "string" && target !== "all";
}

/** 产物文件名里代表「导了什么」的那一段 */
function targetSuffix(target: ExportTarget, metas: ReadonlyArray<{ id: string }>): string {
  if (target === "all") return "全卷";
  if (Array.isArray(target) && target.length > 1) return `选${target.length}章`;
  return metas[0]?.id ?? "chapter";
}

/** 目标 → 章节元数据。多选保持作者勾选的顺序为目录顺序，避免产物里章节乱序。 */
function resolveTargets(catalog: ChapterCatalog, target: ExportTarget): ChapterCatalogEntry[] {
  if (target === "all") return catalog.entries;
  const wanted = new Set(Array.isArray(target) ? target : [target as string]);
  // 有 id 不在目录里：requireChapter 抛出明确错误，好过静默少导一章
  if (![...wanted].every((id) => catalog.byId.has(id))) for (const id of wanted) requireChapter(catalog, id);
  return catalog.entries.filter((entry) => wanted.has(entry.id));
}

// Windows 与 POSIX 都不接受的字符。空格与连字符**不在**其中——书名里它们很常见，
// 换成下划线等于替作者改了书名。
const UNSAFE_NAME = /[/\\:*?"<>|]/g;

/** 书名、章节名进文件名前的净化。空白结尾的名字在 Windows 上创建不了。 */
function safeStem(value: string): string {
  return value.replace(UNSAFE_NAME, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
}

/**
 * 作者自定的文件名。
 *
 * 三件事必须在这里做掉，否则每个调用方都要各做一遍：
 * 1. 去掉路径分隔符——文件名带路径等于绕过「导出到哪个目录」这个选择；
 * 2. 去掉他顺手打上的扩展名，免得出 `我的书.epub.epub`；
 * 3. 长度封顶。Windows 单段路径上限 255，留出扩展名与后缀的余量。
 * 净化完是空的就当他没填，回落到默认命名——不能产出一个叫 `.epub` 的文件。
 */
function authorFileName(raw: string | undefined, extensions: readonly string[]): string | undefined {
  if (typeof raw !== "string") return undefined;
  let name = raw.replace(/[\r\n]/g, " ");
  for (const ext of extensions) {
    if (name.toLowerCase().endsWith(`.${ext}`)) { name = name.slice(0, -(ext.length + 1)); break; }
  }
  // 非法字符换成下划线（`第1章:开始` → `第1章_开始`，结构还在），但连成一串的下划线要压掉。
  const cleaned = safeStem(name).replace(/_{2,}/g, "_").slice(0, 180);
  // 剩下的全是下划线/空格/点，说明他打的整串都是非法字符——那不叫「填了名字」。
  // 只判空串是不够的：净化是替换不是删除，`///:*?"` 会变成一串下划线，非空但毫无意义。
  return /[^_\s.]/.test(cleaned) ? cleaned : undefined;
}

export interface ExportOptions {
  /** 输出目录。默认 `<工作区>/output`；作者选了别处就写别处。 */
  outDir?: string;
  /** 产物文件名（不含扩展名）。给了就用它，不再拼「书名_范围」。 */
  fileName?: string;
}

export async function exportChapter(
  ws: Workspace,
  target: ExportTarget,
  format: string,
  options: ExportOptions = {}
): Promise<ExportResult> {
  const catalog = await readChapterCatalog(ws);

  const metas = resolveTargets(catalog, target);
  if (metas.length === 0) throw new Error("Cannot export an empty workspace");
  const single = isSingle(target);
  const suffix = targetSuffix(target, metas);
  const outDir = options.outDir && options.outDir.trim() ? options.outDir : join(ws.root, "output");

  // 双语对照（R3-4）：数据源是段落权威 JSON，源译天然逐段对齐，零额外成本。
  // 竞品空白区——对照阅读是校对与学习两种用法的共同刚需。
  if (format === "md-bilingual" || format === "epub-bilingual" || format === "txt-bilingual") {
    const kind = format === "epub-bilingual" ? "epub" : format === "txt-bilingual" ? "txt" : "md";
    return exportBilingual(ws, { single, suffix, outDir, ...(options.fileName === undefined ? {} : { fileName: options.fileName }) }, kind, metas, catalog.book ?? "无题");
  }
  // RV-07：定稿 → 暂存稿 → 跳过。整本导出时缺一章不该让整次导出失败；
  // 单章导出时若这一章真没有译文，报错仍然是对的——用户点的就是它。
  const translations = new Map<string, string>();
  const fromStaging: string[] = [];
  const skipped: string[] = [];
  for (const meta of metas) {
    const source = resolveTranslationSource(ws, meta);
    if (!source) {
      if (single) throw new Error(`Missing translation for chapter ${meta.id}`);
      skipped.push(meta.id);
      continue;
    }
    if (source.staging) fromStaging.push(meta.id);
    translations.set(meta.id, await readFile(source.path, "utf-8"));
  }
  const included = metas.filter((meta) => translations.has(meta.id));
  if (included.length === 0) throw new Error("没有任何章节有译文，无从导出");

  await mkdir(outDir, { recursive: true });
  const bookName = safeStem(catalog.book ?? "无题");

  const composition = { exported: included.map((m) => m.id), fromStaging, skipped };

  if (format === "epub") {
    // 再生式 EPUB3（干净中文排版）
    const chapters: EpubExportChapter[] = [];
    for (const m of included) {
      const tr = translations.get(m.id)!;
      const lines = tr.split("\n").filter((l) => l.trim());
      chapters.push({
        id: m.id,
        title: m.title ?? m.id,
        content: lines.map((l) => ({ kind: "text" as const, text: l })),
      });
    }
    const buf = await generateEpub({ title: bookName, lang: "zh", chapters });
    const outPath = join(outDir, `${authorFileName(options.fileName, ["epub"]) ?? `${bookName}_${suffix}`}.epub`);
    await atomicWriteFile(outPath, buf);
    return { outPath, ...composition };
  }

  // txt / md
  const parts: string[] = [];
  for (const m of included) {
    const tr = translations.get(m.id)!;
    const title = m.title ?? m.id;
    parts.push(`${format === "txt" ? title : `# ${title}`}\n\n${format === "txt" ? stripMarkdown(tr) : tr}`);
  }
  const ext = format === "md" ? "md" : "txt";
  const outPath = join(outDir, `${authorFileName(options.fileName, [ext]) ?? `${bookName}_${suffix}`}.${ext}`);
  await atomicWriteFile(outPath, parts.join("\n\n---\n\n"));
  return { outPath, ...composition };
}

/**
 * 双语对照导出。
 *
 * 只认段落权威 JSON：Markdown 投影是「\n\n 拼起来的译文」，与原文没有可靠的对齐关系，
 * 拿它硬对会在有空段或多行段的章节上错位——错位的对照比没有对照更害人。
 */
async function exportBilingual(
  ws: Workspace,
  scope: { single: boolean; suffix: string; outDir: string; fileName?: string },
  kind: "md" | "epub" | "txt",
  metas: ReadonlyArray<{ id: string; title?: string }>,
  book: string
): Promise<ExportResult> {
  const { readChapterParagraphs } = await import("./paragraph-gate.ts");
  const chapters: Array<{ id: string; title: string; pairs: Array<{ source: string; translation: string }> }> = [];
  const skipped: string[] = [];
  for (const meta of metas) {
    const file = await readChapterParagraphs(ws, meta.id);
    if (!file || file.paragraphs.length === 0) {
      // RV-07：整本导出缺一章不该让整次导出失败；单章导出报错仍是对的——用户点的就是它。
      if (scope.single) throw new Error(`章节 ${meta.id} 没有段落数据，无法导出双语对照`);
      skipped.push(meta.id);
      continue;
    }
    chapters.push({
      id: meta.id,
      title: meta.title ?? meta.id,
      pairs: file.paragraphs.map((p) => ({ source: p.source, translation: p.translation })),
    });
  }
  if (chapters.length === 0) throw new Error("没有任何章节有段落数据，无法导出双语对照");
  // 双语读的是段落权威文件，它对定稿与暂存稿一视同仁，因此无「来自暂存稿」之分。
  const composition = { exported: chapters.map((c) => c.id), fromStaging: [] as string[], skipped };

  await mkdir(scope.outDir, { recursive: true });
  const bookName = safeStem(book);
  // 作者自己填了名字就用他的，不再往后缀里塞「_双语」——他要什么名字是他的事
  const stem = authorFileName(scope.fileName, ["md", "epub", "txt"]) ?? `${bookName}_${scope.suffix}_双语`;

  if (kind === "txt") {
    // 纯文本对照：没有引用块可用，靠「原文段落 → 空行 → 译文段落 → 空行」的节奏分辨，
    // 章与章之间用一行分隔线。给的是能直接丢进任何阅读器的东西。
    const body = chapters
      .map((chapter) => {
        const pairs = chapter.pairs
          .map((pair) => (pair.translation.trim() ? `${pair.source}\n${pair.translation}` : pair.source))
          .join("\n\n");
        return `${chapter.title}\n\n${pairs}`;
      })
      .join("\n\n————————\n\n");
    const outPath = join(scope.outDir, `${stem}.txt`);
    await atomicWriteFile(outPath, body);
    return { outPath, ...composition };
  }

  if (kind === "md") {
    // 原文进引用块弱化、译文作正文：对照阅读时视线主轴仍是译文
    const body = chapters
      .map((chapter) => {
        const pairs = chapter.pairs
          .map((pair) => {
            const source = pair.source.split("\n").map((line) => `> ${line}`).join("\n");
            return pair.translation.trim() ? `${source}\n\n${pair.translation}` : source;
          })
          .join("\n\n");
        return `# ${chapter.title}\n\n${pairs}`;
      })
      .join("\n\n---\n\n");
    const outPath = join(scope.outDir, `${stem}.md`);
    await atomicWriteFile(outPath, body);
    return { outPath, ...composition };
  }

  const epubChapters: EpubExportChapter[] = chapters.map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    content: chapter.pairs.flatMap((pair) => {
      const rows = [{ kind: "text" as const, text: pair.source }];
      if (pair.translation.trim()) rows.push({ kind: "text" as const, text: pair.translation });
      return rows;
    }),
  }));
  const buf = await generateEpub({ title: `${bookName}（双语对照）`, lang: "zh", chapters: epubChapters });
  const outPath = join(scope.outDir, `${stem}.epub`);
  await atomicWriteFile(outPath, buf);
  return { outPath, ...composition };
}

/** TXT 导出净化：去掉 Markdown 标记（标题 # / 粗斜体星号 / 列表 - / 引用 > / 分隔线 ---） */
export function stripMarkdown(text: string): string {
  return text
    .split("\n")
    .map((l) => {
      let line = l;
      // 标题: # 1~6 个 + 空格
      line = line.replace(/^ {0,3}#{1,6}\s+/, "");
      // 引用块 >
      line = line.replace(/^ {0,3}>\s?/, "");
      // 列表 -/*/+/数字. （保留文本）
      line = line.replace(/^ {0,3}([-*+]|\d+\.)\s+/, "");
      // 分隔线 ---/***/___
      if (/^ {0,3}(-{3,}|\*{3,}|_{3,})$/.test(line)) line = "";
      // 粗体/斜体 **x** / *x* / __x__ / _x_（保留内容）
      line = line.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
      line = line.replace(/(^|[^*])\*([^*]+)\*(?![*])/g, "$1$2").replace(/(^|[^_])_([^_]+)_(?![_])/g, "$1$2");
      // 行内代码 `x`
      line = line.replace(/`([^`]+)`/g, "$1");
      return line.trimEnd();
    })
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === "")) // 连续空行合一
    .join("\n")
    .trim();
}

/** 导出进度预览（已翻译章节数） */
export async function exportProgress(ws: Workspace): Promise<{ total: number; done: number }> {
  const catalog = await readChapterCatalog(ws);
  const dir = join(ws.root, "translations");
  const files = existsSync(dir) ? await readdir(dir) : [];
  const done = catalog.entries.filter((chapter) => files.includes(`${chapter.id}_zh.md`)).length;
  return { total: catalog.entries.length, done };
}
