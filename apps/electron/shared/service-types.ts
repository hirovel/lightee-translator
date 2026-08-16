/**
 * 跨服务共享的领域类型（RH-11 从 `ipc-service.ts` 提取，零行为变更）。
 *
 * 只放**多个服务都要看见**的形状。单个服务私有的类型留在它自己的文件里，
 * 不要往这里堆——那会把「共享类型」重新变成另一个上帝模块。
 */
import type { BookReviewStatus, WorkspaceInfo } from "./ipc-contract.js";
import type { CreateLlmOptions, LlmBridge } from "./llm-types.js";
import type { ChapterPipelineOptions, ChapterPipelineResult, PipelineConfig } from "@lightee/engine";

/** 一个已打开的工作区：注册表信息 + 根目录 */
export interface WorkspaceRecord {
  info: WorkspaceInfo;
  root: string;
}

/** 全书/整卷两级批准状态文件（BQ-06） */
export interface BookReviewStateFile {
  status: BookReviewStatus;
  runId?: string;
  reportPath?: string;
  scope?: string[];
  /** 这次通读跑完的时刻（RV-06 之后只是时间戳，不再是「通过」的凭据） */
  reviewedAt?: number;
  staleReason?: string;
  /** 作者在 AI 全文审校后自行修改过译文（非阻塞提示；不阻止展示/导出） */
  authorEditedSinceReview?: boolean;
  /** 上次运行失败/中断的原因（RV-06；状态回 none，没跑成就是没跑成） */
  lastError?: string;
  /** 上次通读没看的章节（还没有译文） */
  skippedChapters?: string[];
  updatedAt: number;
}


/** 引擎接线面：Electron 主进程把 engine 的函数装配进来（测试可注入假实现） */
export interface EngineWiring {
  importFile(path: string, ws: { root: string }, opts: { volumeId?: string }): Promise<{ chapters: Array<{ id: string }> }>;
  previewImport?(path: string): Promise<{
    ext: string;
    chapters: Array<{ title: string; charCount: number; needsManualConfirm?: boolean; volume?: string; volumeIndex?: number }>;
    volumeHint?: string;
    /** EPUB 自带分卷（EV-01）：≥2 个分节才出现；章节 volumeIndex 对齐数组下标 */
    volumes?: Array<{ title: string; chapters: number }>;
  }>;
  // EX-08 / ADR-0007：prepareTerminology 接线随译前提取链退役。
  /**
   * 译者标注的新术语入队。产生在术语准备之后，需要独立的入队通道；缺省不接线时行为与此前一致。
   */
  promotePendingTerms?(ws: { root: string }): Promise<{ added: number; sessionId?: string }>;
  translateChapterToFile(
    ws: { root: string },
    chapterId: string,
    llm: { complete: (model: string, messages: Array<{ role: string; content: string }>, opts?: { thinking?: string }) => Promise<{ text: string }> },
    config: {
      project: { name: string; srcLang: string; tgtLang: string };
      agents: Record<string, { model: string; thinking: string }>;
      translation: { mode: string; concurrency: number; batchChars: number; quoteStyle?: string; staging?: boolean };
    },
    retryNote?: string,
  ): Promise<{ charCount: number }>;
  runChapterPipeline(
    ws: { root: string },
    chapterId: string,
    llm: { complete: (model: string, messages: Array<{ role: string; content: string }>, opts?: { thinking?: string }) => Promise<{ text: string }> },
    config: PipelineConfig,
    options?: ChapterPipelineOptions,
  ): Promise<ChapterPipelineResult>;
  recoverChapterPromotion(ws: { root: string }, chapterId: string): Promise<void>;
  recoverChapterPromotionInTransaction(ws: { root: string }, chapterId: string): Promise<void>;
  reviewChapter(
    ws: { root: string },
    chapterId: string,
    opts?: {
      translationOverride?: string;
      llm?: { complete: (system: string, user: string) => Promise<string> };
      /** 降级告警（自定义规则轮没跑成等）。不接的话引擎侧告警在真实路径上没有听众。 */
      onWarn?: (message: string) => void;
    },
  ): Promise<{
    chapterId: string;
    issueCount: number;
    issues: Array<{
      type: string;
      severity: string;
      location: string;
      found?: string;
      expected?: string;
      paragraphId?: string;
      paragraphIds?: string[];
      termJa?: string;
      dialogueSafe?: boolean;
    }>;
    checksRun?: string[];
    noTranslation?: boolean;
  }>;
  confirm: {
    loadSession(ws: { root: string }): Promise<{ cards: Array<{ ja: string }>; index: number; verdicts: unknown[]; done: boolean } | null>;
    saveSession(ws: { root: string }, session: unknown): Promise<void>;
    verdict(ws: { root: string }, session: unknown, v: { action: "accept" | "modify" | "skip"; chosenZh?: string; chosenCharacter?: string }): Promise<void>;
    finishSession(ws: { root: string }, session: unknown, options?: { afterCommit?: (applied: unknown[]) => Promise<void> }): Promise<unknown[]>;
  };
  /**
   * target：单章 id、`"all"`（全书），或作者勾选的一组章节 id
   * options：输出目录与文件名，都由作者在导出面板里定；省略则用工作区 output 与默认命名
   */
  exportChapter(ws: { root: string }, target: string | readonly string[], format: string, options?: { outDir?: string; fileName?: string }): Promise<{
    outPath: string;
    exported: string[];
    fromStaging: string[];
    skipped: string[];
  }>;
  runBookReview(
    ws: { root: string },
    options: {
      llm: { complete: (system: string, user: string) => Promise<string> };
      scope?: string[];
      /** 作者自定审校规则（settings review.rules，enabled 的那部分） */
      authorRules?: Array<{ name: string; rule: string }>;
      onProgress?: (phase: string, message: string, done: number, total: number) => void | Promise<void>;
    },
  ): Promise<{
    runId: string;
    report: {
      reportId: string;
      summary: { high: number; medium: number; low: number };
      issues: Array<{ chapterIds: string[]; type: string; severity: string; paragraphIds?: string[] }>;
      scope: string[];
    };
    reportPath: string;
  }>;
  /** 不传 options → 读磁盘 models.json 的共享形态；传 providers → 内存配置（思考能力探测用） */
  createLlm(options?: CreateLlmOptions): LlmBridge;
}

/** `state/source-corrections/<chapterId>.json`：作者对导入原文的修正（chapter-io 写权威） */
export interface SourceCorrectionFile {
  revision: number;
  source: string;
  /** 原始导入日文（审计/检测用） */
  previousSource?: string;
  /** 修改分类：仅空白/标点 = cosmetic；正文/结构变化 = semantic */
  changeClass?: "cosmetic" | "semantic";
  /** semantic 且尚未重新翻译 → 阻止全文审校与整书导出 */
  requiresRetranslation?: boolean;
  savedAt: number;
}

/**
 * 工作区解析后的流水线配置（config-service 产出，翻译/审校/术语三条编排共用）。
 * 与引擎的 `PipelineConfig` 保持结构兼容；此处显式写出，避免注入面反向依赖 config-service。
 */
export interface WorkspacePipelineConfig {
  project: { name: string; srcLang: string; tgtLang: string };
  agents: {
    translator: { model: string; thinking: string };
    /** 全书审校用。逐章审校是确定性检查，不经模型，与这一档无关 */
    reviewer: { model: string; thinking: string };
  };
  translation: {
    mode: "parallel" | "balanced" | "quality";
    concurrency: number;
    batchChars: number;
    quoteStyle?: "zh" | "jp";
    staging?: boolean;
    contextWindow?: number;
    /** 全书上下文注入的预算（策略）。窗口是事实上限，两者分开——见 engine 的 bookContextBudget */
    guide?: string;
    /** 术语注入模式（R2-1）：subset=逐章子集（缺省） · frozen=全表钉进静态前缀 */
    /** 风格锚定参考文本（R2-3）：作者提供的目标语样本，进静态前缀 */
    styleAnchor?: string;
  };
}
