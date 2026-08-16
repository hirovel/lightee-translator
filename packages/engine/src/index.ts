/**
 * @lightee/engine 公共 API 出口（Electron 主进程接线用）。
 */

export { WORKSPACE_DIRS, WORKSPACE_SCHEMA_VERSION, createWorkspace, createWorkspaceSkeleton, listVolumes, addVolume, ensureVolumeDirs, countChaptersInVolume, nextVolumeId, volumeLabel } from "./workspace.js";
export { seedPostDictRules, SEEDED_POST_DICT_RULES } from "./seed-rules.js";
export { inspectWorkspaceIntegrity, migrateLegacyEmptyManifest, type WorkspaceIntegrityIssue, type WorkspaceIntegrityReport } from "./workspace-integrity.js";
export { withWorkspaceFileTransaction, recoverWorkspaceFileTransactions } from "./file-transaction.js";
export type { Workspace, VolumeInfo } from "./workspace.js";
export { allocateChapterIds, assertUniqueChapterIds, readChapterCatalog, requireChapter, chapterPaths, stagingTranslationPath, resolveChapter, nextChapterId, chapterFilePaths, moveChapterFiles, removeVolumeDirs, type ChapterCatalog, type ChapterCatalogEntry } from "./chapter-fs.js";

export { splitChapters, importTxtBook, mergeManifest } from "./txt-import.js";
export type { ChapterMeta, BookManifest, ImportTxtOptions } from "./txt-import.js";

export { importFile, importEpubFile, previewImport } from "./import-pipeline.js";
export type { ImportPreview } from "./import-pipeline.js";

export { translateChapterToFile, DEFAULT_GUIDE } from "./translate-one.js";
export { promotePendingTerms, readPendingTerms, type PendingTerm } from "./pending-terms.js";
export type { TranslateOneResult } from "./translate-one.js";

export {
  applyParagraphPatch,
  gateTranslationOutput,
  repairParagraphsXml,
  readChapterParagraphs,
  writeChapterParagraphs,
  paragraphsPath,
} from "./paragraph-gate.js";
export type {
  ParagraphGateResult,
  ParagraphPatch,
  ParagraphPatchChange,
  ParagraphPatchResult,
  ChapterParagraph,
  ChapterParagraphsFile,
} from "./paragraph-gate.js";

export {
  planRename,
  planRenameForChapters,
  applyRenamePlan,
  retroRename,
  claimOccurrences,
  replaceAtPositions,
  readRenameReview,
  resolveRenameReview,
  renameReviewPath,
  checkRenameGate,
  overlapsOtherTerm,
  classifyParagraph,
  MIN_AUTO_RENAME_LENGTH,
} from "./rename-repair.js";
export type {
  RenamePlan,
  RenameHit,
  RenameInput,
  RenameApplyResult,
  RenameReviewEntry,
  RenameReviewQueue,
  RenameReviewReason,
  RenameBlockReason,
} from "./rename-repair.js";

export { appendRenameEvent, readRenameEventsSince, renameLogPath } from "./rename-log.js";
export type { RenameEvent } from "./rename-log.js";

export { reviseChapterPassages } from "./translate-revise.js";
export type { RevisePassageItem, RevisePassageChange } from "./translate-revise.js";

export {
  compilePreferences,
  saveAuthorPreferences,
  readAuthorPreferences,
  readPreferenceProfile,
  preparePreferencesForTranslation,
  preferencesForChapter,
} from "./author-preferences.js";
export type {
  PreferenceProfile,
  PreferenceRule,
  PreferenceKind,
  PreferenceScope,
  PreferenceScopeKind,
  PreferenceUnresolved,
  PreferenceConflict,
} from "./author-preferences.js";

export { runBookReview, shardChapters } from "./book-review.js";
export type {
  BookReviewReport,
  BookReviewIssue,
  BookReviewShard,
  BookReviewRunInput,
  BookReviewResult,
  BookReviewAction,
  BookReviewSeverity,
} from "./book-review.js";

export { buildParagraphs, paragraphsToText, normalizeParagraphText, splitParagraphs } from "@lightee/core/paragraph";
export type { ParagraphBlock, ParagraphType } from "@lightee/core/paragraph";

export { reviewChapter } from "./review-one.js";
export type { ReviewOneResult, ReviewChapterOptions } from "./review-one.js";


export { runPipeline } from "./orchestrator.js";
export type { PipelineOptions, PipelineResult, ChapterOutcome, TranslatorFn, ReviewerFn } from "./orchestrator.js";
export { runChapterPipeline, recoverChapterPromotion, recoverChapterPromotionInTransaction } from "./chapter-pipeline.js";
export type { ChapterPipelineOptions, ChapterPipelineResult, ChapterHookContext, ChapterHookAction, PostChapterHook } from "./chapter-pipeline.js";

export { createSession, loadSession, saveSession, currentCard, verdict, finishSession, parseAction, ConfirmSessionConflictError } from "./confirm-session.js";
export type { ConfirmSession, SessionAction } from "./confirm-session.js";
export type { DecisionCard, Verdict } from "@lightee/core/evidence-card";

export { exportChapter, stripMarkdown, exportProgress } from "./export-one.js";

export { LlmRuntime } from "./llm-runtime.js";
export { retryCall, isRetryableError, isContextOverflowError, classifyLlmError, attachErrorKind, type LlmErrorKind, type LlmErrorInfo, type RetryPolicy, type RetryCallbacks } from "./llm-retry.js";
export type { ProviderConfig, LlmMessage, LlmCallOptions, LlmCallResult, LlmCallLogEntry } from "./llm-runtime.js";

// EX-08 / ADR-0007：prepareTerminology 及其入参/产物类型随译前提取链一并退役。
export type { PipelineConfig } from "./cli-pipeline.js";

export { ChapterStateStore, ChapterStateStoreError, CHAPTER_STATE_FORMAT_VERSION, CHAPTER_EVENT_FORMAT_VERSION } from "@lightee/core/chapter-state";
export { withChapterWorkspaceLock } from "@lightee/core/chapter-state";
export type { ChapterStateSnapshot, ChapterStateEvent, ChapterTransitionOptions, ChapterAttemptOptions, ChapterWorkflowStatus } from "@lightee/core/chapter-state";

export { TerminologyRepository, TerminologyRepositoryError, TERMINOLOGY_ARCHIVES, withTerminologyWorkspaceLock } from "@lightee/core/terminology-repository";
export type {
  TerminologyAction,
  TerminologyArchive,
  TerminologyCommit,
  TerminologyEntry,
  TerminologyMergeEntry,
  TerminologyMergeInput,
  TerminologyMutationResult,
  TerminologyRepositoryErrorCode,
  TerminologySnapshot,
  TerminologyTermsMutationInput,
  TerminologyTrashEntry,
} from "@lightee/core/terminology-repository";

// 工作区归档与自动快照（RH-21 / C-2）
export { ARCHIVE_EXCLUDED_DIRS, SNAPSHOT_DIR, SNAPSHOT_INTERVAL_MS, SNAPSHOT_KEEP, createWorkspaceArchive, maybeSnapshotWorkspace, pruneSnapshots, shouldSnapshot } from "./workspace-archive.js";
export { REGISTER_TERMS_TOOL, renderToolResult, validateRegisteredTerms } from "./register-terms.js";
export type { RegisteredVoice, RegisterTermsResult } from "./register-terms.js";
