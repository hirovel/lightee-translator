/**
 * 章节 IO 服务（RH-11 / design/ipc-service-decomposition.md §2）。
 *
 * 归属：`chapter.load` / `saveDraft` / `checkpoint` / `loadSourceCorrection` /
 * `saveSourceCorrection`——即编辑器与磁盘之间的全部直接读写。
 *
 * 写权威：`translations/**` 草稿、`state/checkpoints/**`、`state/source-corrections/**`。
 * revision 校验与 read-modify-write 必须整段在同一临界区内完成（DEF-02）。
 */
import { join } from "node:path";
import { atomicWriteFile, atomicWriteJson, readJson, readText, withFileMutationQueue } from "../atomic-file.js";
import { errorFor, failure, success, type AnyResult } from "../ipc-result.js";
import type {
  ChapterSnapshot,
  CheckpointResult,
  IpcRequestMap,
  ParagraphDraft,
  SaveResult,
  SourceCorrectionResult,
} from "../ipc-contract.js";
import {
  buildParagraphs,
  ChapterStateStore,
  resolveChapter,
  stagingTranslationPath,
  withChapterWorkspaceLock,
} from "@lightee/engine";
import type { ServiceContext } from "./service-context.js";
import type { SourceCorrectionFile } from "../service-types.js";

/**
 * 章节还没有作者写的原文——空文件，或只有 `createChapter` 写下的那行 `# 标题`。
 * 判据与正文面板的 `hasAuthorVisibleSource` 同义：标题不是原文。
 */
function lacksAuthoredSource(text: string): boolean {
  return text.split("\n").every((line) => !line.trim() || line.trim().startsWith("#"));
}

/** `translations/<chapterId>.draft.json`：段落级草稿（chapter-io 写权威） */
interface DraftFile {
  revision: number;
  savedAt: number;
  paragraphs: ParagraphDraft[];
}

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function makeParagraphs(source: string, translation: string): ParagraphDraft[] {
  const sourceParts = splitParagraphs(source);
  const translationParts = splitParagraphs(translation);
  const count = Math.max(sourceParts.length, translationParts.length);
  return Array.from({ length: count }, (_, index) => ({
    id: `p${String(index + 1).padStart(4, "0")}`,
    source: sourceParts[index] ?? "",
    translation: translationParts[index] ?? "",
  }));
}

function markdownFromParagraphs(paragraphs: ParagraphDraft[]): string {
  const text = paragraphs.map((paragraph) => paragraph.translation.trim()).filter(Boolean).join("\n\n");
  return text ? `${text}\n` : "";
}

/** 去空白 + 中英文标点（仅用于修改检测；不改变正文比较的语义） */
function stripPunctAndSpace(text: string): string {
  return text
    .replace(/[\s\u3000]/g, "")
    .replace(/[，。、！？；：""''（）【】《》〈〉〔〕「」『』…—・～~‥々,．.!?;:()\[\]{}<>\-‐_'"]/g, "");
}

/**
 * 确定性源文修改分类：段落数/顺序/类型或去除空白标点后的正文变化 = semantic（需重译）；
 * 仅空白/换行/标点变化 = cosmetic（不触发重译，但仍保存并显示）。
 * 不调用 LLM；保留“强制重新翻译”手动入口供作者覆盖 cosmetic 判定。
 */
function classifySourceChange(original: string, revised: string): { changeClass: "cosmetic" | "semantic"; requiresRetranslation: boolean } {
  const origParas = buildParagraphs(original);
  const revParas = buildParagraphs(revised);
  if (origParas.length !== revParas.length) return { changeClass: "semantic", requiresRetranslation: true };
  for (let i = 0; i < origParas.length; i++) {
    const o = origParas[i]!;
    const r = revParas[i]!;
    if (o.type !== r.type) return { changeClass: "semantic", requiresRetranslation: true };
    if (stripPunctAndSpace(o.text) !== stripPunctAndSpace(r.text)) return { changeClass: "semantic", requiresRetranslation: true };
  }
  return { changeClass: "cosmetic", requiresRetranslation: false };
}

export class ChapterIoService {
  constructor(private readonly ctx: ServiceContext) {}

  // ===== 注入面转发（搬移过来的方法体保持零改动） =====
  private get engine(): ServiceContext["engine"] { return this.ctx.engine; }
  private workspace(workspaceId: string) { return this.ctx.workspace(workspaceId); }
  private emit: ServiceContext["emit"] = (type, payload) => this.ctx.emit(type, payload);
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> { return this.ctx.enqueue(key, fn); }
  private trackWrite<T>(promise: Promise<T>): Promise<T> { return this.ctx.trackWrite(promise); }
  private readRevision(root: string, key: string): Promise<number> { return this.ctx.readRevision(root, key); }
  private writeRevision(root: string, key: string, revision: number): Promise<void> { return this.ctx.writeRevision(root, key, revision); }
  private markBookReviewStale(root: string, reason: string): Promise<void> { return this.ctx.markBookReviewStale(root, reason); }
  private markBookReviewAuthorEdited(root: string): Promise<void> { return this.ctx.markBookReviewAuthorEdited(root); }
  private syncParagraphsFromDraft(root: string, chapterId: string, drafts: ParagraphDraft[]): Promise<void> {
    return this.ctx.syncParagraphsFromDraft(root, chapterId, drafts);
  }

  async loadChapter(request: IpcRequestMap["chapter.load"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    return withChapterWorkspaceLock(workspace.root, async () => {
      if (this.engine?.recoverChapterPromotionInTransaction) {
        await this.engine.recoverChapterPromotionInTransaction({ root: workspace.root }, request.chapterId);
      }
      const resolved = await resolveChapter({ root: workspace.root }, request.chapterId);
      const sourcePath = resolved.paths.source;
      const translationPath = resolved.paths.translation;
      const draftPath = resolved.paths.draft;
      const draft = await readJson<DraftFile | null>(draftPath, null);
      const source = await readText(sourcePath);
      const approvedTranslation = await readText(translationPath);
      // approved 之前译文只存在于 state/staging/（beginPromotion 只在转 approved 时才写
      // translations/）。stuck 或审校中的章若只读 translations/，编辑器拿到的是「全空译文」
      // ——用户面对的是一个静默空白的正文面板。
      // 路径由 stagingTranslationPath 一处给出：这条约定此前在 9 个地方各手写一遍，
      // 靠注释互相声称「与某某同款」，而那种声称没有任何东西会检查（INV-2）。
      const translation = approvedTranslation.trim()
        ? approvedTranslation
        : await readText(stagingTranslationPath(workspace.root, request.chapterId));
      const revision = await this.readRevision(workspace.root, `chapter:${request.chapterId}`);
      const correction = await this.readSourceCorrectionFile(workspace.root, request.chapterId);
      const chapterState = new ChapterStateStore(workspace.root);
      const workflow = await chapterState.ensureChapter(request.chapterId);
      // everApproved 是快照上的持久字段（RH-14）：不再为了这一个布尔值全量扫描事件日志。
      const hasApprovedTransition = workflow.state === "approved" || workflow.everApproved;
      const snapshot: ChapterSnapshot = {
        workspaceId: request.workspaceId,
        chapterId: request.chapterId,
        revision,
        paragraphs: draft?.paragraphs ?? makeParagraphs(source, translation),
        sourceCorrection: correction ? { revision: correction.revision, source: correction.source } : null,
        // 判据用 translations/ 原文件而非回退结果：staging 半成品不构成「已定稿译文」
        hasApprovedTranslation: hasApprovedTransition && approvedTranslation.trim().length > 0,
        workflow,
      };
      return success(snapshot);
    });
  }

  async saveDraft(request: IpcRequestMap["chapter.saveDraft"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:chapter:${request.chapterId}`;
    return this.trackWrite(this.enqueue(key, () => withChapterWorkspaceLock(workspace.root, async () => {
      const resolved = await resolveChapter({ root: workspace.root }, request.chapterId);
      const currentRevision = await this.readRevision(workspace.root, `chapter:${request.chapterId}`);
      if (currentRevision !== request.baseRevision) {
        const error = errorFor("conflict", `Chapter revision is ${currentRevision}; received ${request.baseRevision}`, false, { currentRevision, baseRevision: request.baseRevision });
        this.emit("chapter.saveFailed", { workspaceId: request.workspaceId, chapterId: request.chapterId, error, baseRevision: request.baseRevision });
        return failure(error);
      }
      const revision = currentRevision + 1;
      const savedAt = Date.now();
      try {
        await atomicWriteJson(resolved.paths.draft, { revision, savedAt, paragraphs: request.paragraphs } satisfies DraftFile);
        await atomicWriteFile(resolved.paths.translation, markdownFromParagraphs(request.paragraphs));
        // 同步段落权威（P0：作者修改译文 → 段落 JSON 更新，保持单一权威；保留 type/source）
        await this.syncParagraphsFromDraft(workspace.root, request.chapterId, request.paragraphs);
        await this.writeRevision(workspace.root, `chapter:${request.chapterId}`, revision);
      } catch (cause) {
        const error = errorFor("internal", cause instanceof Error ? cause.message : "Draft save failed", true);
        this.emit("chapter.saveFailed", { workspaceId: request.workspaceId, chapterId: request.chapterId, error, baseRevision: request.baseRevision });
        return failure(error);
      }
      const result: SaveResult = { workspaceId: request.workspaceId, chapterId: request.chapterId, revision, savedAt };
      // 作者修改译文是创作自由：不 stale、不阻塞、不强制审校；仅记录非阻塞提示
      await this.markBookReviewAuthorEdited(workspace.root);
      this.emit("chapter.saved", result);
      return success(result);
    })));
  }

  async checkpoint(request: IpcRequestMap["chapter.checkpoint"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const resolved = await resolveChapter({ root: workspace.root }, request.chapterId);
    const currentRevision = await this.readRevision(workspace.root, `chapter:${request.chapterId}`);
    if (currentRevision !== request.revision) {
      return failure(errorFor("conflict", `Cannot checkpoint revision ${request.revision}; current is ${currentRevision}`, false, { currentRevision, requestedRevision: request.revision }));
    }
    const savedAt = Date.now();
    const checkpointPath = resolved.paths.checkpoint;
    await atomicWriteJson(checkpointPath, { chapterId: request.chapterId, revision: request.revision, savedAt });
    const result: CheckpointResult = { workspaceId: request.workspaceId, chapterId: request.chapterId, revision: request.revision, checkpointPath, savedAt };
    return success(result);
  }

  sourceCorrectionPath(root: string, chapterId: string): string {
    return join(root, "state", "source-corrections", `${chapterId}.json`);
  }

  async readSourceCorrectionFile(root: string, chapterId: string): Promise<SourceCorrectionFile | null> {
    return readJson<SourceCorrectionFile | null>(this.sourceCorrectionPath(root, chapterId), null);
  }

  async loadSourceCorrection(request: IpcRequestMap["chapter.loadSourceCorrection"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    return withChapterWorkspaceLock(workspace.root, async () => {
      await resolveChapter({ root: workspace.root }, request.chapterId);
      const correction = await this.readSourceCorrectionFile(workspace.root, request.chapterId);
      if (!correction) return success(null);
      const result: SourceCorrectionResult = { workspaceId: request.workspaceId, chapterId: request.chapterId, revision: correction.revision, source: correction.source };
      return success(result);
    });
  }

  async saveSourceCorrection(request: IpcRequestMap["chapter.saveSourceCorrection"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:source:${request.chapterId}`;
    // 修订号读取与写入必须在同一文件临界区内：clearRequiresRetranslation 走的是另一条队列。
    return this.trackWrite(this.enqueue(key, () => withChapterWorkspaceLock(workspace.root, () => withFileMutationQueue(this.sourceCorrectionPath(workspace.root, request.chapterId), async () => {
      const resolved = await resolveChapter({ root: workspace.root }, request.chapterId);
      const current = (await this.readSourceCorrectionFile(workspace.root, request.chapterId))?.revision ?? 0;
      if (current !== request.baseRevision) return failure(errorFor("conflict", `Source correction revision is ${current}`, false, { currentRevision: current, baseRevision: request.baseRevision }));
      const revision = current + 1;
      const savedAt = Date.now();
      // 修改分类：对比原始导入日文（cosmetic 不触发重译；semantic 需重译）
      let original = "";
      try {
        original = await readText(resolved.paths.source);
      } catch {
        original = "";
      }
      const cls = original ? classifySourceChange(original, request.source) : { changeClass: "semantic" as const, requiresRetranslation: true };
      // 首次粘贴是在**写**原文，不是在**改**原文。
      //
      // 此前无论哪种情况都只落进 state/source-corrections/<id>.json，而：
      //   · 正文面板判空看的是 chapter.load 的 paragraphs，来自 source/<vol>/<id>.md；
      //   · 引擎从头到尾没有一处读 source-corrections（只有路径常量与完整性巡检）。
      // 于是「原文已保存」句句属实——文件确实写了——却没有任何东西会去读它，
      // 回到正文照旧是「这个章节还没有日文原文」。
      // 章节还没有作者原文时，这里把正文直接写进原文文件；已有原文的修改仍走修正档。
      if (lacksAuthoredSource(original)) await atomicWriteFile(resolved.paths.source, request.source);
      await atomicWriteJson(this.sourceCorrectionPath(workspace.root, request.chapterId), {
        revision,
        source: request.source,
        previousSource: original,
        changeClass: cls.changeClass,
        requiresRetranslation: cls.requiresRetranslation,
        savedAt,
      } satisfies SourceCorrectionFile);
      // semantic 源文修改 → 全书审校失效（cosmetic 不失效；作者仍可手动“强制重新翻译”）
      if (cls.requiresRetranslation) await this.markBookReviewStale(workspace.root, `章节 ${request.chapterId} 源文已修改（${cls.changeClass}）`);
      const result: SourceCorrectionResult = { workspaceId: request.workspaceId, chapterId: request.chapterId, revision, source: request.source, changeClass: cls.changeClass, requiresRetranslation: cls.requiresRetranslation };
      return success(result);
    }))));
  }
}
