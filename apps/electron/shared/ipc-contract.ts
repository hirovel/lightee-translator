export const IPC_VERSION = 1 as const;
export const INVOKE_CHANNEL = "lightee:invoke" as const;
export const EVENT_CHANNEL = "lightee:event" as const;
export const FLUSH_CHANNEL = "lightee:flush" as const;

export const IPC_COMMANDS = [
  "workspace.open",
  "workspace.list",
  "workspace.create",
  "workspace.close",
  "workspace.forget",
  "workspace.session.read",
  "workspace.session.write",
  "workspace.renameVolume",
  "workspace.renameChapter",
  "import.preview",
  "import.text",
  "import.run",
  "chapter.create",
  "chapter.delete",
  "chapter.restore",
  "chapter.move",
  "volume.delete",
  "volume.restore",
  "chapter.load",
  "chapter.saveDraft",
  "chapter.checkpoint",
  "chapter.loadSourceCorrection",
  "chapter.saveSourceCorrection",
  "translate.run",
  "translate.cancel",
  "translate.runScope",
  "translate.stopScope",
  "review.run",
  "chapter.accept",
  "bookReview.run",
  "bookReview.cancel",
  "bookReview.status",
  "confirm.list",
  "confirm.decide",
  "terms.query",
  "terms.create",
  "terms.update",
  "terms.delete",
  "terms.restore",
  "rename.review",
  "rename.resolve",
  "export.run",
  "workspace.exportArchive",
  "settings.read",
  "settings.write",
  "ai.providers.list",
  "ai.key.write",
  "ai.model.write",
  "ai.test",
  "ai.provider.upsert",
  "ai.provider.delete",
  "ai.model.upsert",
  "ai.model.delete",
  "ai.provider.presets",
  "ai.config.open",
  "ai.models.detect",
  "ai.thinking.probe",
  "ai.key.open",
  "ai.thinking.write",
  "ai.reviewThinking.write",
  "ai.key.delete",
  "ai.oauth.login",
  "ai.oauth.wait",
  "ai.oauth.refresh",
  "agent.log.list",
  "usage.report",
  "agent.log.read",
  "dialog.pickDirectory",
  "dialog.pickFile",
  // EX-02 实验台。命令名恒在契约里（类型是静态的），但处理器只在 LIGHTEE_DEV_PROBE=1 时放行；
  // 发布版调用一律 invalid_request，与不存在的命令表现一致。
  "dev.prompt.probe",
] as const;

export type IpcCommand = (typeof IPC_COMMANDS)[number];

export const IPC_EVENT_NAMES = [
  "translate.progress",
  "translate.scopeChanged",
  "review.progress",
  "bookReview.progress",
  "bookReview.changed",
  "agent.status",
  "agent.thinking",
  "agent.text",
  "workspace.changed",
  "terminology.changed",
  "chapter.saved",
  "chapter.saveFailed",
  "chapter.stateChanged",
  "terms.changed",
] as const;

export type IpcEventName = (typeof IPC_EVENT_NAMES)[number];

export interface ParagraphDraft {
  id: string;
  source: string;
  translation: string;
}

export interface WorkspaceChapterInfo {
  id: string;
  title: string;
  state?: ChapterWorkflowState;
}

export interface WorkspaceVolumeInfo {
  id: string;
  label: string;
  chapters: WorkspaceChapterInfo[];
}

export interface WorkspaceInfo {
  id: string;
  path: string;
  name: string;
  srcLang: string;
  tgtLang: string;
  openedAt: number;
  status: "ready" | "missing" | "invalid";
  error?: string;
  volumes: WorkspaceVolumeInfo[];
}

export interface WorkspaceSessionInfo {
  workspaceId: string;
  chapterId: string;
  /** 上次编辑时光标所在段。恢复时 revealParagraph 直接落回这一段；缺省落到章首。 */
  paragraphId?: string;
  savedAt: number;
}

/** 与 @lightee/core 的 TERMINOLOGY_ARCHIVES 同一清单（后三类是 R1 的作者字典） */
export const TERM_ARCHIVES = ["names", "terms", "voice", "onomatopoeia", "puns", "preDict", "postDict", "noTranslate"] as const;
export type TermArchive = (typeof TERM_ARCHIVES)[number];

export interface TermRecord {
  /**
   * **展示** id。八个档案摊平成一张表时用来去重，因此带 `档案名:` 前缀，
   * 必要时还会追加 `-2` 这样的后缀。它在仓库里不存在，**不能拿来做变更键**。
   */
  id: string;
  /**
   * 仓库里的真实条目 id，`terms.update` / `terms.delete` / `terms.restore` 认的就是它。
   * 交出一行却不交能改它的键，界面上的「编辑 / 删除」就只能报 not_found。
   * 条目本身没有 id（历史投影）时缺省，这种行改不动，界面应当据此禁用操作。
   */
  entryId?: string;
  ja: string;
  zh: string;
  type?: string;
  archive?: TermArchive;
  archiveFile?: string;
  /** 溯源指针（指向会话卡片等），与 entryId 无关，不可用作变更键 */
  sourceId?: string;
  readOnly?: boolean;
  deletedAt?: number;
  /**
   * 谁定的译法（ADR-0008）：`"model"` = 暂定（已生效、未终审），`"author"` = 终审过。
   * 缺省按 author——存量档案全是作者在旧闸门下确认过的。
   * 与旧 pending/status 语义正交：pending 是「不生效等确认」（已废的闸门模型）。
   */
  provenance?: "model" | "author";
  [key: string]: unknown;
}

export interface TermQueryFilters {
  archive?: TermArchive;
  type?: string;
  status?: string;
  /** Include deleted terms from the repository trash projection. */
  deleted?: boolean;
}

export interface IpcRequestMap {
  "workspace.open": { path: string };
  "workspace.list": Record<string, never>;
  "workspace.create": { path: string; name: string; srcLang?: string; tgtLang?: string };
  "workspace.close": { workspaceId: string };
  /** 从最近列表移除条目（**不删磁盘文件**）——失效条目的唯一出口 */
  "workspace.forget": { workspaceId: string };
  "workspace.session.read": Record<string, never>;
  "workspace.session.write": { workspaceId: string; chapterId: string; paragraphId?: string };
  "workspace.renameVolume": { workspaceId: string; volumeId: string; name: string };
  "workspace.renameChapter": { workspaceId: string; volumeId: string; chapterId: string; title: string };
  "import.preview": { sourcePath: string };
  "import.text": { workspaceId: string; text: string; volumeId?: string; target?: ImportTarget };
  "import.run": { workspaceId: string; sourcePath: string; volumeId?: string; previewToken?: string; target?: ImportTarget };
  "chapter.create": {
    workspaceId: string;
    volumeId: string;
    title?: string;
    afterChapterId?: string;
    source?: string;
  };
  "chapter.delete": { workspaceId: string; volumeId: string; chapterId: string };
  "chapter.restore": { workspaceId: string; trashId: string };
  "chapter.move": {
    workspaceId: string;
    chapterId: string;
    targetVolumeId: string;
    afterChapterId?: string;
    /** 插入到目标卷卷首（与 afterChapterId 互斥） */
    atStart?: boolean;
  };
  "volume.delete": { workspaceId: string; volumeId: string };
  "volume.restore": { workspaceId: string; trashId: string };
  "chapter.load": { workspaceId: string; chapterId: string };
  "chapter.saveDraft": {
    workspaceId: string;
    chapterId: string;
    baseRevision: number;
    paragraphs: ParagraphDraft[];
  };
  "chapter.checkpoint": { workspaceId: string; chapterId: string; revision: number };
  "chapter.loadSourceCorrection": { workspaceId: string; chapterId: string };
  "chapter.saveSourceCorrection": {
    workspaceId: string;
    chapterId: string;
    baseRevision: number;
    source: string;
  };
  "translate.run": { workspaceId: string; chapterId: string };
  /** 取消进行中的章节翻译（RH-16）；无进行中任务时返回 idle */
  "translate.cancel": { workspaceId: string; chapterId: string };
  /**
   * 范围跑批（RS-1 / D6）：清单是**意图不是命令**——主进程逐章开工前再校验状态，
   * 不再需要翻的章跳过并在事件流出声。串行执行（EX-05 累积词表的追加序前提）。
   * `retranslate=true` 表示作者显式勾选了已译章（D4），复核时不因 approved 跳过。
   */
  "translate.runScope": { workspaceId: string; chapters: Array<{ chapterId: string; retranslate?: boolean }> };
  /**
   * 两段式停止（D7）：第一击=章边界停（翻完当前章即停），第二击=立即取消当前章。
   * 无跑批进行时返回 idle。
   */
  "translate.stopScope": { workspaceId: string };
  "review.run": { workspaceId: string; chapterId: string };
  /** 作者复核后显式接受本章（解除 stuck / 无正文章节的死锁） */
  "chapter.accept": { workspaceId: string; chapterId: string };
  "bookReview.run": { workspaceId: string };
  /** 取消进行中的全文审校（RH-16） */
  "bookReview.cancel": { workspaceId: string };
  "bookReview.status": { workspaceId: string };
  /** confirmHigh：存在未解决 high 问题时，作者显式确认仍接受为全书通过（RH-06 方向 A） */
  "confirm.list": { workspaceId: string; chapterId?: string };
  "confirm.decide": {
    workspaceId: string;
    action: "accept" | "modify" | "skip" | "back" | "quit";
    chosenZh?: string;
    chosenCharacter?: string;
    expectedIndex?: number;
  };
  "terms.query": {
    workspaceId: string;
    chapterId?: string;
    paragraphId?: string;
    search?: string;
    filters?: TermQueryFilters;
    cursor?: number;
    /** Snapshot revision token required for subsequent pages. */
    baseRevision?: number;
  };
  "terms.create": {
    workspaceId: string;
    archive: TermArchive;
    ja: string;
    zh: string;
    type?: string;
    character?: string;
    strategy?: string;
    /** 字典档案的开关；条目删不掉时，关掉是唯一的止损手段 */
    enabled?: boolean;
    /** 语气档案的角色性别（female/male/unknown）；中文代词选他/她的唯一依据 */
    gender?: string;
    baseRevision: number;
  };
  "terms.update": {
    workspaceId: string;
    termId: string;
    archive?: TermArchive;
    ja: string;
    zh: string;
    type?: string;
    character?: string;
    strategy?: string;
    enabled?: boolean;
    gender?: string;
    baseRevision: number;
  };
  /**
   * archive 省略 = terms。省不得的场合：档案是按名字分表存的，删一条人名却不带
   * archive，落到 terms 表里按 id 找不到 → not_found。终审「拒绝」一个模型登记的
   * 人名，从前就死在这里。
   */
  "terms.delete": { workspaceId: string; termId: string; archive?: TermArchive; baseRevision: number };
  "terms.restore": { workspaceId: string; termId: string; archive?: TermArchive; baseRevision: number };
  /** EX-06：追溯改名的复查队列（窄门外的位置，需作者逐处确认） */
  "rename.review": { workspaceId: string };
  "rename.resolve": { workspaceId: string; entryId: string };
  /**
   * target：单章 id、`"all"`（全书），或作者在导出面板勾选的一组章节 id
   * outDir：作者选的输出目录，省略则写工作区的 output
   * fileName：作者改的文件名（不含扩展名），省略则用「书名_范围」
   */
  "export.run": { workspaceId: string; target: string | string[]; format: "txt" | "md" | "epub" | "txt-bilingual" | "md-bilingual" | "epub-bilingual"; outDir?: string; fileName?: string };
  /** 工作区归档导出（RH-21 / C-2）。目标目录由主进程弹原生选择器决定，payload 只带工作区 */
  "workspace.exportArchive": { workspaceId: string };
  "settings.read": { workspaceId: string };
  "settings.write": {
    workspaceId: string;
    baseRevision: number;
    key: string;
    value: JsonValue;
  };
  "ai.providers.list": { workspaceId: string };
  "ai.key.write": { providerId: string; apiKey: string };
  "ai.model.write": { workspaceId: string; model: string };
  "ai.test": { workspaceId: string; model?: string };
  "ai.provider.upsert": { providerId: string; name: string; baseUrl: string; api: "openai-responses" | "openai-completions" };
  "ai.provider.delete": { providerId: string };
  "ai.model.upsert": { providerId: string; modelId: string; modelName?: string; thinkingLevelMap?: Record<string, string | null>; contextWindow?: number; maxTokens?: number };
  "ai.model.delete": { providerId: string; modelId: string };
  "ai.provider.presets": Record<string, never>;
  "ai.config.open": { kind: "models" | "auth" };
  "ai.models.detect": { workspaceId: string; providerId: string; baseUrl: string; apiKey?: string };
  /** 逐档试探思考能力：对每个候选档位各发一次极小请求，据实测结果写回 thinkingLevelMap */
  "ai.thinking.probe": { providerId: string; modelId: string };
  "ai.key.open": { providerId: string };
  "ai.thinking.write": { workspaceId: string; thinking: string };
  "ai.reviewThinking.write": { workspaceId: string; thinking: string };
  "ai.key.delete": { providerId: string };
  // 三个 oauth 命令的请求体都只有 providerId（与 :1156 起的校验器一致）
  "ai.oauth.login": { providerId: string };
  "ai.oauth.wait": { providerId: string };
  "ai.oauth.refresh": { providerId: string };
  /** workspaceId 给了就只列这本书的调用（打过工作区戳的记录才认得出归属） */
  "agent.log.list": { limit?: number; workspaceId?: string };
  "usage.report": { workspaceId: string };
  "agent.log.read": { id: string };
  /** EX-02：自拟 prompt 直发（prompt 编排实验台）。model 省略时用工作区默认翻译模型 */
  /**
   * EX-02 实验台。`user` 是单轮的简写；给了 `messages` 则用完整多轮历史
   * （工具协议的第二轮必须回灌 assistant 的调用 + toolResult，PT-02）。
   */
  "dev.prompt.probe": { model?: string; system: string; user: string; thinking?: string; maxTokens?: number; tools?: Array<{ name: string; description: string; parameters: Record<string, unknown>; constrainedSampling?: false | { type: "json_schema"; strict: "prefer" | "require" } }>; messages?: Array<{ role: string; content: string; continuation?: JsonValue; reasoning?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; toolCallId?: string; toolName?: string; toolIsError?: boolean }> };
  "dialog.pickDirectory": { title?: string };
  "dialog.pickFile": { title?: string };
}

export interface ChapterSnapshot {
  workspaceId: string;
  chapterId: string;
  revision: number;
  paragraphs: ParagraphDraft[];
  sourceCorrection: { revision: number; source: string } | null;
  /** True only when durable workflow history proves an approved file exists. */
  hasApprovedTranslation: boolean;
  workflow: ChapterWorkflowSnapshot;
}

export interface SaveResult {
  workspaceId: string;
  chapterId: string;
  revision: number;
  savedAt: number;
}

export interface TermMutationResult extends SaveResult {
  reloadRequired: true;
  /**
   * 改译法时的追溯改名结果（EX-06）。只有 names/terms 改了 zh 才出现。
   *
   * 必须外传给界面：自动替换动了作者已经翻好的正文，静默进行等于背着人改稿；
   * 而进了复查队列的那些，作者不知道就永远不会去处理。
   */
  renameRepair?: {
    oldZh: string;
    newZh: string;
    /** 自动替换的段落数 */
    replaced: number;
    /** 涉及的章节数 */
    chapters: number;
    /** 进复查队列的位置数 */
    queued: number;
    /** 整次改名被窄门挡下的原因（有值时 replaced 必为 0） */
    blocked?: "too_short" | "substring_of_term";
  };
}

/** 追溯改名的复查队列（EX-06）。窄门外的每一处出现一条，作者逐处确认。 */
export interface RenameReviewResult {
  entries: Array<{
    id: string;
    ja: string;
    oldZh: string;
    newZh: string;
    chapterId: string;
    /** `"*"` = 该章没有段落权威文件，整章待人工处理 */
    paragraphId: string;
    reason: "too_short" | "substring_of_term" | "human_edited" | "overlaps_term" | "no_paragraphs";
    excerpt: string;
    createdAt: number;
    resolvedAt?: number;
  }>;
  /** 未处理条目数（界面徽标用） */
  pending: number;
}

export interface PickDirectoryResult {
  path: string | null;
}

export interface PickFileResult {
  path: string | null;
}

export interface CheckpointResult {
  workspaceId: string;
  chapterId: string;
  revision: number;
  checkpointPath: string;
  savedAt: number;
}

export interface SourceCorrectionResult {
  workspaceId: string;
  chapterId: string;
  revision: number;
  source: string;
  /** 修改分类：仅空白/标点 = cosmetic；正文/结构变化 = semantic */
  changeClass?: "cosmetic" | "semantic";
  /** semantic 且尚未重新翻译 → 需要重新翻译 */
  requiresRetranslation?: boolean;
}

export interface ReviewIssueInfo {
  type: string;
  severity: string;
  location: string;
  message?: string;
  suggestion?: string;
  found?: string;
  expected?: string;
  /** 权威定位（RV-04）：跳转与就地标注都用它，不再从 location 反解行号。 */
  paragraphId?: string;
  /** 同一条问题涉及的全部段落。 */
  paragraphIds?: string[];
  /** 术语类问题涉及的日文词——面板据此提供「打开术语条目」。 */
  termJa?: string;
  /** 修订不得破坏对话引号（D5）。 */
  dialogueSafe?: boolean;
}

export interface ReviewReportSummary {
  reportId: string;
  generatedAt: string;
  issueCount: number;
}

export interface ReviewResult {
  chapterId: string;
  issueCount: number;
  issues: ReviewIssueInfo[];
  reportId?: string;
  generatedAt?: string;
  history?: ReviewReportSummary[];
  /**
   * 本次实际执行的检查项 id（RV-04）。零问题时界面显示「N 项检查全部通过」，
   * N 只能来自这里——把没跑过的检查算成通过就是撒谎。标签见 engine 的 CHECK_LABELS。
   */
  checksRun?: string[];
  /**
   * 本章没有可审校的译文（RV-01）。界面必须据此区分「查过没问题」与「没东西可查」，
   * 不能把两者都画成绿勾。
   */
  noTranslation?: boolean;
}

export type TranslationWorkflowStatus = "approved" | "needs-review" | "stuck";

/** 全书/整卷两级批准状态（BQ-06） */
/** 取消命令的结果：cancelling = 已发出中止；idle = 当前没有进行中的任务 */
export interface CancelResult {
  status: "cancelling" | "idle";
}

/**
 * 范围跑批的结算单（RS-1）。每一章恰好落进一个桶——总数对不上就是引擎丢章。
 *
 * D9（续跑无状态）：这份结果只描述**这一次 run**，不持久化；再跑一次的范围
 * 由「对章节状态的即时查询」重新给出。
 */
export interface RunScopeResult {
  runId: string;
  /** 意图清单长度（去重后） */
  total: number;
  approved: string[];
  /** 翻完但未过审（needs-review）——不是失败，待作者处理 */
  needsReview: string[];
  /** 审校熔断（D8：中途跳过续跑，这里是结算汇总） */
  stuck: string[];
  /** 开工前复核后跳过的章（D6：清单是意图不是命令） */
  skipped: Array<{ chapterId: string; reason: string }>;
  /** 翻译失败但跑批继续的章（无人值守是跑批的存在理由） */
  failed: Array<{ chapterId: string; reason: string }>;
  /** 停止时还没开工（或被立即取消）的章 */
  remaining: string[];
  stopped: "none" | "boundary" | "cancelled";
  /** 结束时点待终审术语数 = 档案暂定（provenance=model）+ 确认卡（ADR-0008 两来源一队列） */
  pendingTerms: number;
}

/**
 * 全书审校三态（RV-06）：没跑过 / 正在跑 / 有建议。
 *
 * 旧的七态（ready/needs-repair/approved/stale/blocked）围绕「它是不是一道门禁」而设计。
 * 全书审校是 L2 的 LLM 判断——本项目架构定稿时明确拒绝通用 LLM-as-judge——却曾握着
 * 整书导出的否决权和自动逐章重译的执行权。降级为建议后，那些状态没有了对应的权力，
 * 也就没有了存在的理由。失效与失败改由 `staleReason` / `lastError` 两个注记字段承载。
 */
export type BookReviewStatus = "none" | "running" | "advisory";

export interface BookReviewAdvice {
  chapterIds: string[];
  type: string;
  severity: string;
  paragraphIds?: string[];
  found?: string;
  expected?: string;
  /** 建议怎么改（可执行的一句话）。此前被 IPC 裁掉，作者一条都没见过。 */
  repairInstruction?: string;
  evidenceRefs?: Array<{ source: string; context: string }>;
}

export interface BookReviewStatusResult {
  status: BookReviewStatus;
  runId?: string;
  reportPath?: string;
  scope?: string[];
  summary?: { high: number; medium: number; low: number };
  issues?: BookReviewAdvice[];
  /** 这份建议基于的译文已经变了（不阻塞任何操作，只是提醒重跑） */
  staleReason?: string;
  /** 作者在 AI 全文审校后自行修改过译文（非阻塞提示） */
  authorEditedSinceReview?: boolean;
  /** 上次运行失败/中断的原因。失败不留报告，状态回 none——没跑成就是没跑成。 */
  lastError?: string;
  /** 本次没有参与通读的章节（还没有译文），如实说明而不是悄悄少看几章。 */
  skippedChapters?: string[];
}
/**
 * 导出结果的构成披露（RV-07）。
 *
 * 导出永远可点——拿不到书的唯一原因只能是那部分真的还没译。代价是产物里可能混着
 * 未定稿的稿子，所以必须如实说清这本书是由什么拼出来的：哪些章定稿了、哪些还是暂存稿、
 * 哪几章根本没译因而被跳过。**跳过的章节绝不用原文占位**——中日混排的书流出去是第一类事故。
 */
export interface ExportRunResult {
  status: "queued";
  workspaceId: string;
  outPath?: string;
  /** 实际写进产物的章节 */
  exported?: string[];
  /** 其中读的是暂存稿（有译文但作者还没定稿） */
  fromStaging?: string[];
  /** 没有任何译文、已跳过的章节 */
  skipped?: string[];
}

export type ChapterWorkflowState = "imported" | "ready" | "translating" | "translated" | "reviewing" | "revising" | "approved" | "stuck";

export interface ChapterWorkflowSnapshot {
  chapterId: string;
  state: ChapterWorkflowState;
  version: number;
  reviseCount: number;
  attempt: number;
  retryCount: number;
  lastError: string | null;
  lastReason: string | null;
  lastActivityAt: string | null;
  userModified: boolean;
  recheckReason: string | null;
  runId: string | null;
  transitionCount: number;
  /** 是否曾经通过审校（进入过 approved），一旦为 true 永不回退（RH-14） */
  everApproved: boolean;
}

export interface ChapterStateChangedPayload {
  workspaceId: string;
  chapterId: string;
  from: ChapterWorkflowState;
  to: ChapterWorkflowState;
  reason: string;
  runId: string;
  state: ChapterWorkflowSnapshot;
}

export type TerminologyStatus = "not-extracted" | "pending" | "confirmed";

export type TerminologyChangeAction = "prepared" | "confirmed" | "created" | "updated" | "deleted" | "restored" | "recovered" | "status";

export interface TerminologyStatusSnapshot {
  status: TerminologyStatus;
  cardCount: number;
  pendingCount: number;
  confirmedCount: number;
  updatedAt: number | null;
  extractionId: string | null;
}

export interface TerminologyChangedPayload extends TerminologyStatusSnapshot {
  workspaceId: string;
  revision: number;
  commitId: string;
  archives: TermArchive[];
  action: TerminologyChangeAction;
}

export interface ImportPreviewResult {
  sourcePath: string;
  format: "txt" | "md" | "epub" | "unknown";
  chapters: Array<{ title: string; charCount: number; needsManualConfirm?: boolean; volume?: string; volumeIndex?: number }>;
  /**
   * EPUB 自带分卷（EV-01 合本）：≥2 个分节才出现。
   * 章节的 volumeIndex 对齐本数组下标——分节标题可重复（连载书的幕間×N），只有下标能对上。
   * 语义：目标卷留「自动」= 按原书分卷落盘；显式指定卷 = 整本并入该卷。
   */
  volumes?: Array<{ title: string; chapters: number }>;
}

export interface ImportTarget {
  /** 目标卷：auto=书名识别/下一卷；new=强制新建卷；其它字符串=指定已有卷 */
  volume?: "auto" | "new" | string;
}

export interface TermQueryResult {
  items: TermRecord[];
  nextCursor: number | null;
  revision: number;
}

export interface SettingsSnapshot {
  values: Record<string, JsonValue>;
  revision: number;
}

/**
 * 单次 LLM 调用的 token 计量（R0-2 缓存可观测 / roadmap A3）。
 *
 * **口径**：`input` 已剔除缓存部分——pi-ai 的两条 API 路径都算
 * `prompt_tokens - cacheRead - cacheWrite`。所以提示词总量 = `input + cacheRead + cacheWrite`，
 * 缓存命中率 = `cacheRead ÷ 该和`。把 `input` 当「全部输入」会把命中率算高。
 *
 * 全部字段可缺席：服务商不上报时**不补 0**，否则「没数据」和「真为零」在 UI 上无法区分。
 */
export interface LlmUsageSnapshot {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface IpcResponseMap {
  "workspace.open": WorkspaceInfo;
  "workspace.list": WorkspaceInfo[];
  "workspace.create": WorkspaceInfo;
  "workspace.close": { workspaceId: string };
  /** 从最近列表移除条目（**不删磁盘文件**），返回移除后的完整列表 */
  "workspace.forget": WorkspaceInfo[];
  "workspace.session.read": WorkspaceSessionInfo | null;
  "workspace.session.write": WorkspaceSessionInfo;
  "workspace.renameVolume": WorkspaceInfo;
  "workspace.renameChapter": WorkspaceInfo;
  "import.preview": ImportPreviewResult;
  "import.text": { status: "queued"; workspaceId: string; chapters: number };
  "import.run": { status: "queued"; workspaceId: string; chapters: number };
  "chapter.create": {
    status: "created";
    workspaceId: string;
    volumeId: string;
    chapterId: string;
    title: string;
  };
  "chapter.delete": {
    status: "deleted";
    workspaceId: string;
    volumeId: string;
    chapterId: string;
    title: string;
    trashId: string;
    deletedAt: number;
  };
  "chapter.restore": {
    status: "restored";
    workspaceId: string;
    volumeId: string;
    chapterId: string;
    title: string;
    restoredAt: number;
  };
  "chapter.move": {
    status: "moved";
    workspaceId: string;
    chapterId: string;
    volumeId: string;
    afterChapterId?: string;
    order: string[];
  };
  "volume.delete": {
    status: "deleted";
    workspaceId: string;
    volumeId: string;
    trashId: string;
    chapterCount: number;
    deletedAt: number;
  };
  "volume.restore": {
    status: "restored";
    workspaceId: string;
    volumeId: string;
    chapterCount: number;
    restoredAt: number;
  };
  "chapter.load": ChapterSnapshot;
  "chapter.saveDraft": SaveResult;
  "chapter.checkpoint": CheckpointResult;
  "chapter.loadSourceCorrection": SourceCorrectionResult | null;
  "chapter.saveSourceCorrection": SourceCorrectionResult;
  "translate.run": { chapterId: string; charCount: number; workflowStatus: TranslationWorkflowStatus; workflow: ChapterWorkflowSnapshot; review?: ReviewResult };
  "translate.cancel": CancelResult;
  "translate.runScope": RunScopeResult;
  "translate.stopScope": { status: "idle" | "boundary" | "cancelling" };
  "review.run": ReviewResult;
  "chapter.accept": { workspaceId: string; chapterId: string; state: ChapterWorkflowState; reason: string };
  "bookReview.cancel": CancelResult;
  "bookReview.status": BookReviewStatusResult;
  "bookReview.run": BookReviewStatusResult;
  "confirm.list": { cards: JsonValue[]; session: JsonValue | null; status: TerminologyStatusSnapshot; revision: number };
  "confirm.decide": { index: number; total: number; applied: number; status: TerminologyStatus; revision: number };
  "terms.query": TermQueryResult;
  "terms.create": TermMutationResult;
  "terms.update": TermMutationResult;
  "terms.delete": TermMutationResult;
  "terms.restore": TermMutationResult;
  "rename.review": RenameReviewResult;
  "rename.resolve": { resolved: boolean };
  "export.run": ExportRunResult;
  "workspace.exportArchive": { status: "exported" | "cancelled"; workspaceId: string; path?: string; bytes?: number };
  "settings.read": SettingsSnapshot;
  "settings.write": { revision: number; key: string };
  "ai.providers.list": {
    // api：服务商编辑器要原样回填它——漏了会把已配好的接口形态覆盖成 undefined
    providers: Array<{ id: string; name: string; baseUrl: string; api?: "openai-responses" | "openai-completions"; keyUrl?: string; hasKey?: boolean; models: Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number; thinkingLevelMap?: Record<string, string | null> }> }>;
    current: string;
    currentProvider: string;
    currentThinking: string;
    /**
     * 全书审校的思考档。它的唯一消费者是 `bookReview.run`，而那条功能的界面入口
     * 目前是关的（renderer 的 BOOK_AI_REVIEW_ENABLED）。配置与服务层照旧保留，
     * 开关改回 true 时整条链路连同这一档一起回来。
     */
    reviewThinking: string;
  };
  "ai.key.write": { providerId: string; hasKey: boolean };
  "ai.model.write": { model: string };
  "ai.test": { ok: boolean; message: string; model?: string; usage?: { input?: number; output?: number } };
  "ai.provider.upsert": { providerId: string };
  "ai.provider.delete": { providerId: string };
  "ai.model.upsert": { providerId: string; modelId: string; thinkingLevelMap?: Record<string, string | null> };
  "ai.model.delete": { providerId: string; modelId: string };
  "ai.provider.presets": Array<{ id: string; name: string; baseUrl: string; api: string; models: Array<{ id: string; name: string }>; hint?: string }>;
  "ai.config.open": { opened: boolean; path: string };
  // contextWindow：服务商在 /models 里声明了才有；没有就没有，绝不猜（model-metadata.ts）
  "ai.models.detect": { models: Array<{ id: string; name: string; contextWindow?: number }>; providerId: string };
  /**
   * 逐档试探结果。`thinkingLevelMap` 是据实测写回配置的那一份；
   * `outcomes` 保留每一档的原始结论（含「接受但没回传思考内容」这种细节）供界面展示——
   * 折进 map 会把「服务商没回传思考过程」误判成「不支持」。
   */
  "ai.thinking.probe": {
    providerId: string;
    modelId: string;
    thinkingLevelMap: Record<string, string | null>;
    outcomes: Array<{ candidate: string; accepted: boolean; reasoned: boolean; error?: string }>;
  };
  "ai.key.open": { opened: boolean; url: string };
  "ai.thinking.write": { thinking: string };
  "ai.reviewThinking.write": { thinking: string };
  "ai.key.delete": { providerId: string };
  // login 返回授权地址供 renderer 打开；wait/refresh 返回登录结果
  "ai.oauth.login": { authUrl: string; redirectUri: string; providerId: string };
  "ai.oauth.wait": { ok: boolean; providerId: string; message?: string };
  "ai.oauth.refresh": { ok: boolean; providerId: string; message?: string };
  "agent.log.list": { entries: Array<{
    id: string; label?: string; model: string; thinking?: string; ok: boolean;
    promptPreview: string; responsePreview: string; ms: number; ts: number; error?: string;
    usage?: LlmUsageSnapshot;
    /**
     * 本次尝试发起了几次工具调用。列表只给**计数**（明细在 `agent.log.read`）——
     * 有了它，工具轮在折叠状态下就认得出来：那一轮 `responsePreview` 是空的，
     * 不标出来的话它和「模型什么都没回」长得一模一样。
     */
    toolCallCount?: number;
  }>; dev: boolean; totals?: { input: number; output: number; cacheRead: number; cacheWrite: number } };
  /**
   * 一次网络尝试的**完整**记录。
   *
   * `tools` / `toolCalls` 是本轮补的，理由是控制台此前对工具通道完全瞎：KA-5 之后
   * 术语登记的指令一个字都不在 `prompt` 里（判据在工具 description、形状由 schema 保证），
   * 而工具轮的产出也不在 `response` 里（那一轮 `response` 是空串）。
   * 只给 prompt + response，界面上呈现的是「我们什么都没告诉模型，模型也什么都没产出」。
   */
  "agent.log.read": {
    id: string; label?: string; model: string; thinking?: string; ok: boolean;
    prompt: string; response: string; reasoning?: string; ms: number; ts: number; error?: string;
    usage?: LlmUsageSnapshot;
    /** 发出去的工具定义（问） */
    tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
    /** 模型发起的工具调用（答） */
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  };
  /**
   * 用量去向（读工作区 `sessions/usage.jsonl`）。
   *
   * 页脚那四个聚合数字回答不了「钱花在哪」：看到「输出 81166」既不知道是哪一章
   * 吃掉的，也不知道其中多少是思考、多少废在没交付结果的尝试上。
   *
   * 全是数字与短枚举——账本的白名单保证了正文进不来，这条 IPC 原样转发。
   */
  "usage.report": {
    report: {
      attempts: number; wastedAttempts: number; wastedRatio: number; wastedMs: number; wastedOutput: number;
      wastedByKind: Record<string, number>; ms: number; input: number; output: number;
      cacheRead: number; cacheWrite: number; cacheHitRatio: number; downgraded: number;
      effectiveThinking: Record<string, number>; reasoningRatio: number; incomplete: number; ceilingHits: number;
      findings: string[];
    };
    /** 按标签（通常是一章）分组，花得多的排前面 */
    groups: Array<{
      label: string; attempts: number; wastedAttempts: number; ms: number;
      input: number; cacheRead: number; output: number; wastedOutput: number;
      reasoningChars: number; textChars: number; reasoningRatio: number; ceilingHits: number;
      wastedByKind: Record<string, number>; effectiveThinking: Record<string, number>;
    }>;
  };
  "dialog.pickDirectory": PickDirectoryResult;
  "dialog.pickFile": PickFileResult;
  /** EX-02：探针回传模型响应与计量。`attempts>1` 表示这一次里含重试 */
  "dev.prompt.probe": { text: string; continuation?: JsonValue; reasoning?: string; reasoningRedacted?: number; usage?: LlmUsageSnapshot; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; stopReason?: string; rawStopReason?: string; diagnostics?: Array<{ type: string; timestamp: number; name?: string; message?: string; code?: string | number }>; ms: number; attempts: number; model: string };
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface IpcEnvelope {
  version: typeof IPC_VERSION;
  requestId: string;
  command: IpcCommand;
  payload: unknown;
}

export interface IpcError {
  code:
    | "invalid_request"
    | "not_found"
    | "permission_denied"
    | "conflict"
    | "busy"
    | "unsupported"
    | "shutdown"
    | "internal";
  message: string;
  retryable: boolean;
  details?: JsonValue;
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: IpcError };

export interface FlushResult {
  status: "drained" | "already-drained";
  pendingAtStart: number;
  completedAt: number;
}

export interface LighteeApi {
  ping(): string;
  windowAction(action: "minimize" | "maximize" | "close"): void;
  /** 生产 sandbox 下解析拖入文件的真实路径（webUtils），renderer 无法读 File.path */
  getPendingDrop(): { path: string | null; name: string | null };
  invoke<K extends IpcCommand>(command: K, payload: IpcRequestMap[K]): Promise<IpcResult<IpcResponseMap[K]>>;
  onEvent<K extends IpcEventName>(eventName: K, listener: (event: IpcEvent<K>) => void): () => void;
  flushPendingWrites(): Promise<IpcResult<FlushResult>>;
  /** 关窗排空握手（RH-04）：主进程宣布即将关闭；返回取消订阅函数 */
  onWillClose(listener: () => void): () => void;
  /** 关窗排空握手回执（RH-04）：renderer 排空编辑会话后调用，主进程据此进入写队列 drain */
  closeReady(): void;
}

export interface IpcEventMap {
  "translate.progress": { workspaceId: string; chapterId: string; progress: number; message?: string };
  /**
   * 范围跑批的生命周期（RS-1）。忙碌卡 k/N、跳章出声、停止档位提示都从这里来；
   * `notification-clicked` 是结束通知（D13）被点击后主进程发的回执——RS-2 据此落 Agent 控制台。
   */
  "translate.scopeChanged": {
    workspaceId: string;
    runId: string;
    phase: "started" | "chapter-started" | "chapter-skipped" | "chapter-done" | "stop-requested" | "finished" | "notification-clicked";
    total: number;
    /** 当前章在意图清单中的序号（1-based；chapter-* 相位携带） */
    index?: number;
    chapterId?: string;
    /** chapter-skipped 的理由 / chapter-done 的落点状态 */
    reason?: string;
    /** stop-requested / finished 携带的停止档位 */
    stop?: "none" | "boundary" | "cancelled";
    /** finished 携带完整结算单 */
    summary?: RunScopeResult;
  };
  "review.progress": { workspaceId: string; chapterId: string; progress: number; message?: string };
  "bookReview.progress": { workspaceId: string; status: string; message?: string; progress?: number };
  "bookReview.changed": { workspaceId: string; status: BookReviewStatus; reason?: string; updatedAt: number };
  "agent.status": {
    agent: string;
    status: "idle" | "running" | "done" | "failed";
    message?: string;
    /**
     * 消息的性质。这个通道此前同时承载「正在做什么」与「出问题了但继续跑」两件事，
     * 消费方无从区分——忙碌指示器于是显示出「正在：语气归属未完成…」这种句子。
     * 缺省视为 progress，既有事件不受影响。
     */
    kind?: "progress" | "warning";
    workspaceId?: string;
    chapterId?: string;
    runId?: string;
    operation?: "import" | "terminology" | "translate" | "review" | "bookReview" | "export" | "configuration";
  };
  /**
   * 模型思考块的增量（TR-03）。主进程按时间窗 + 体积攒批后发出，见 {@link ThinkingBuffer}。
   *
   * 存在的理由：此前运行中的界面上只有一个转圈的秒表，模型花两分钟在想什么人看不到。
   * 2026-08-12 的诊断因此只能事后刨 30MB 历史文件——而当时失败尝试的思考根本没落盘。
   *
   * 红线：`delta` 含原文与译文草稿。它只走**进程内 → 渲染层**，
   * **不得**进 usage.jsonl（那里只记 reasoningChars 长度）与 AppLog。
   */
  /**
   * 译文**正文**的增量。
   *
   * 存在的理由是一段实测的黑窗：工具通道的轮 2 全长约 22 秒，其中思考只有几十个
   * 字符、几秒就吐完，剩下二十来秒是正文在流式产出——而界面上那段时间什么都没有，
   * 更糟的是思考块还标着 running，显示成「正在思考」。
   *
   * `text_delta` 本来就在流里、本来就已经被遍历到，只是没人接。所以这条通道
   * **零 API 成本、零额外往返**：同一条流、同一批 token。
   *
   * `delta` 已经过 `ParagraphTextStream` 剥离，是**干净的段内正文**，不含 wire 标签。
   *
   * 红线同 {@link agent.thinking}：正文只走进程内 → 渲染层，
   * **不得**进 usage.jsonl 与 AppLog。
   */
  "agent.text": {
    /** 归属标签，与 `agent.thinking` 同一套 */
    label: string;
    attempt?: number;
    /** 这段正文属于哪个段落（段落协议的 id）。取不到时为空串 */
    paragraphId: string;
    /** 攒批后的正文增量。`done=true` 时可能为空串（纯收尾信号） */
    delta: string;
    /** 本次正文流是否结束。渲染层靠它把打字机停下 */
    done?: boolean;
    workspaceId?: string;
    chapterId?: string;
    runId?: string;
  };
  "agent.thinking": {
    /** 归属标签 `<agent>:<stage>[:<unit>]`，如 `translate:ch012` */
    label: string;
    /** 本次逻辑调用的第几次网络尝试（1 起）。降档重试时它会跳到 2、3…… */
    attempt?: number;
    /** 这次尝试**实际生效**的思考档位 */
    thinking?: string;
    /** 攒批后的思考增量。`done=true` 时可能为空串（纯收尾信号） */
    delta: string;
    /** 这个思考块是否已结束。渲染层靠它把打字机停下 */
    done?: boolean;
    workspaceId?: string;
    chapterId?: string;
    runId?: string;
  };
  "workspace.changed": {
    action: "opened" | "created" | "closed" | "structure";
    workspaceId: string;
    reason?: "imported" | "chapter-created" | "chapter-deleted" | "chapter-restored" | "chapter-moved" | "volume-deleted" | "volume-restored";
  };
  "terminology.changed": TerminologyChangedPayload;
  "chapter.saved": SaveResult;
  "chapter.saveFailed": {
    workspaceId: string;
    chapterId: string;
    error: IpcError;
    baseRevision?: number;
  };
  "chapter.stateChanged": ChapterStateChangedPayload;
  "terms.changed": { workspaceId: string; revision: number; action: "created" | "updated" | "deleted" | "restored" };
}

export interface IpcEvent<K extends IpcEventName = IpcEventName> {
  version: typeof IPC_VERSION;
  type: K;
  emittedAt: number;
  payload: IpcEventMap[K];
}

export type ValidatedEnvelope = IpcEnvelope;

type Validation<T> = { ok: true; value: T } | { ok: false; error: IpcError };

const MAX_TEXT = 1_000_000;
const MAX_ID = 128;
/** 一次导出最多勾多少章。比任何一本书的章节数都宽，只用来挡住畸形请求。 */
const MAX_EXPORT_TARGETS = 5_000;
/** Windows 完整路径上限 32767；这里留足余量，够长又不至于让畸形请求带着兆级字符串进来 */
const MAX_PATH = 4_096;
/** 单段文件名，Windows 上限 255。engine 还会再截到 180 并净化 */
const MAX_FILE_NAME = 255;

function ok<T>(value: T): Validation<T> {
  return { ok: true, value };
}

function invalid(message: string, details?: JsonValue): Validation<never> {
  return {
    ok: false,
    error: { code: "invalid_request", message, retryable: false, details },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  return isRecord(value) ? value : null;
}

function stringField(value: unknown, name: string, max = MAX_TEXT): Validation<string> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${name} must be a non-empty string`);
  }
  if (value.length > max) return invalid(`${name} exceeds ${max} characters`);
  return ok(value);
}

function optionalStringField(value: unknown, name: string, max = MAX_TEXT): Validation<string | undefined> {
  if (value === undefined) return ok(undefined);
  return stringField(value, name, max);
}

/** 上下文窗口 / 最大输出这类正整数字段；上界只为挡住明显的误填与溢出 */
function optionalPositiveIntField(value: unknown, name: string): Validation<number | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 100_000_000) {
    return invalid(`${name} must be a positive integer`);
  }
  return ok(value);
}

function thinkingLevelMapField(value: unknown): Validation<Record<string, string | null> | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) return invalid("thinkingLevelMap must be an object");
  const map: Record<string, string | null> = {};
  for (const [level, providerLevel] of Object.entries(value)) {
    if (typeof providerLevel !== "string" && providerLevel !== null) return invalid(`thinkingLevelMap.${level} must be a string or null`);
    map[level] = providerLevel;
  }
  return ok(map);
}

function archiveField(value: unknown, name: string): Validation<TermArchive | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value === "string" && TERM_ARCHIVES.includes(value as TermArchive)) return ok(value as TermArchive);
  return invalid(`${name} must be a supported terminology archive`);
}

function importTargetField(value: unknown): Validation<ImportTarget | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) return invalid("target must be an object");
  const volume = value.volume;
  if (volume === undefined) return ok({});
  if (volume === "auto" || volume === "new") return ok({ volume });
  if (typeof volume === "string" && volume.trim().length > 0 && volume.length <= MAX_ID && /^[A-Za-z0-9._:-]+$/.test(volume)) return ok({ volume });
  return invalid("target.volume must be auto, new, or a volume id");
}

function termQueryFilters(value: unknown): Validation<TermQueryFilters | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) return invalid("filters must be an object");
  const archive = archiveField(value.archive, "filters.archive");
  const type = optionalStringField(value.type, "filters.type", 128);
  const status = optionalStringField(value.status, "filters.status", 128);
  const deleted = value.deleted === undefined ? ok(undefined) : booleanField(value.deleted, "filters.deleted");
  if (!archive.ok || !type.ok || !status.ok || !deleted.ok) return invalid("terms.query filters are invalid");
  return ok({ archive: archive.value, type: type.value, status: status.value, deleted: deleted.value });
}

function booleanField(value: unknown, name: string): Validation<boolean> {
  if (typeof value !== "boolean") return invalid(`${name} must be a boolean`);
  return ok(value);
}

function idField(value: unknown, name: string): Validation<string> {
  const result = stringField(value, name, MAX_ID);
  if (!result.ok) return result;
  if (!/^[A-Za-z0-9._:-]+$/.test(result.value)) return invalid(`${name} contains unsupported characters`);
  return result;
}

function revisionField(value: unknown, name: string): Validation<number> {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid(`${name} must be a non-negative integer`);
  return ok(value as number);
}

function jsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => jsonValue(item, depth + 1));
  if (isRecord(value)) return Object.values(value).every((item) => jsonValue(item, depth + 1));
  return false;
}

function paragraphList(value: unknown): Validation<ParagraphDraft[]> {
  if (!Array.isArray(value) || value.length > 10_000) return invalid("paragraphs must be an array with at most 10000 entries");
  const paragraphs: ParagraphDraft[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!isRecord(item)) return invalid(`paragraphs[${i}] must be an object`);
    const id = idField(item.id, `paragraphs[${i}].id`);
    const source = typeof item.source === "string" && item.source.length <= MAX_TEXT ? ok(item.source) : invalid(`paragraphs[${i}].source is invalid`);
    const translation = typeof item.translation === "string" && item.translation.length <= MAX_TEXT ? ok(item.translation) : invalid(`paragraphs[${i}].translation is invalid`);
    if (!id.ok || !source.ok || !translation.ok) return invalid(`paragraphs[${i}] is invalid`);
    paragraphs.push({ id: id.value, source: source.value, translation: translation.value });
  }
  return ok(paragraphs);
}

function workspaceIdPayload(value: unknown): Validation<{ workspaceId: string }> {
  const record = asRecord(value);
  if (!record) return invalid("payload must be an object");
  const workspaceId = idField(record.workspaceId, "workspaceId");
  return workspaceId.ok ? ok({ workspaceId: workspaceId.value }) : workspaceId;
}

function chapterPayload(value: unknown): Validation<{ workspaceId: string; chapterId: string }> {
  const record = asRecord(value);
  if (!record) return invalid("payload must be an object");
  const workspaceId = idField(record.workspaceId, "workspaceId");
  const chapterId = idField(record.chapterId, "chapterId");
  if (!workspaceId.ok || !chapterId.ok) return invalid("workspaceId and chapterId are required");
  return ok({ workspaceId: workspaceId.value, chapterId: chapterId.value });
}

export function validatePayload(command: IpcCommand, payload: unknown): Validation<unknown> {
  const record = asRecord(payload);
  if (!record) return invalid(`${command} payload must be an object`);

  switch (command) {
    case "workspace.list":
      return ok({});
    case "workspace.open": {
      const path = stringField(record.path, "path", 4_096);
      return path.ok ? ok({ path: path.value }) : path;
    }
    case "workspace.create": {
      const path = stringField(record.path, "path", 4_096);
      const name = stringField(record.name, "name", 256);
      const srcLang = optionalStringField(record.srcLang, "srcLang", 32);
      const tgtLang = optionalStringField(record.tgtLang, "tgtLang", 32);
      if (!path.ok) return path;
      if (!name.ok) return name;
      if (!srcLang.ok) return srcLang;
      if (!tgtLang.ok) return tgtLang;
      return ok({ path: path.value, name: name.value, srcLang: srcLang.value, tgtLang: tgtLang.value });
    }
    case "workspace.close":
    case "workspace.forget":
      return workspaceIdPayload(payload);
    case "workspace.session.read":
      return ok({});
    case "workspace.session.write": {
      const base = chapterPayload(payload);
      if (!base.ok) return base;
      if (record.paragraphId === undefined) return base;
      const paragraphId = idField(record.paragraphId, "paragraphId");
      if (!paragraphId.ok) return invalid("workspace.session.write payload is invalid");
      return ok({ ...(base.value as Record<string, JsonValue>), paragraphId: paragraphId.value });
    }
    case "workspace.renameVolume": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const volumeId = idField(record.volumeId, "volumeId");
      const name = stringField(record.name, "name", 256);
      if (!workspaceId.ok || !volumeId.ok || !name.ok) return invalid("workspace.renameVolume payload is invalid");
      return ok({ workspaceId: workspaceId.value, volumeId: volumeId.value, name: name.value });
    }
    case "workspace.renameChapter": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const volumeId = idField(record.volumeId, "volumeId");
      const chapterId = idField(record.chapterId, "chapterId");
      const title = stringField(record.title, "title", 256);
      if (!workspaceId.ok || !volumeId.ok || !chapterId.ok || !title.ok) return invalid("workspace.renameChapter payload is invalid");
      return ok({ workspaceId: workspaceId.value, volumeId: volumeId.value, chapterId: chapterId.value, title: title.value });
    }
    case "import.preview": {
      const sourcePath = stringField(record.sourcePath, "sourcePath", 4_096);
      return sourcePath.ok ? ok({ sourcePath: sourcePath.value }) : sourcePath;
    }
    case "import.text": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const text = stringField(record.text, "text");
      const volumeId = optionalStringField(record.volumeId, "volumeId", MAX_ID);
      const target = importTargetField(record.target);
      if (!workspaceId.ok) return workspaceId;
      if (!text.ok) return text;
      if (!volumeId.ok) return volumeId;
      if (!target.ok) return target;
      return ok({ workspaceId: workspaceId.value, text: text.value, volumeId: volumeId.value, target: target.value });
    }
    case "import.run": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const sourcePath = stringField(record.sourcePath, "sourcePath", 4_096);
      const volumeId = optionalStringField(record.volumeId, "volumeId", MAX_ID);
      const previewToken = optionalStringField(record.previewToken, "previewToken", 256);
      const target = importTargetField(record.target);
      if (!workspaceId.ok || !sourcePath.ok || !volumeId.ok || !previewToken.ok || !target.ok) return invalid("import.run payload is invalid");
      return ok({ workspaceId: workspaceId.value, sourcePath: sourcePath.value, volumeId: volumeId.value, previewToken: previewToken.value, target: target.value });
    }
    case "chapter.create": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const volumeId = idField(record.volumeId, "volumeId");
      const title = optionalStringField(record.title, "title", 256);
      const afterChapterId = optionalStringField(record.afterChapterId, "afterChapterId", MAX_ID);
      const source = optionalStringField(record.source, "source", 2_000_000);
      if (!workspaceId.ok || !volumeId.ok || !title.ok || !afterChapterId.ok || !source.ok) return invalid("chapter.create payload is invalid");
      return ok({ workspaceId: workspaceId.value, volumeId: volumeId.value, title: title.value, afterChapterId: afterChapterId.value, source: source.value });
    }
    case "chapter.delete": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const volumeId = idField(record.volumeId, "volumeId");
      const chapterId = idField(record.chapterId, "chapterId");
      if (!workspaceId.ok || !volumeId.ok || !chapterId.ok) return invalid("chapter.delete payload is invalid");
      return ok({ workspaceId: workspaceId.value, volumeId: volumeId.value, chapterId: chapterId.value });
    }
    case "chapter.restore":
    case "volume.restore": {
      const base = workspaceIdPayload(payload);
      const trashId = idField(record.trashId, "trashId");
      if (!base.ok || !trashId.ok) return invalid(`${command} payload is invalid`);
      return ok({ ...base.value, trashId: trashId.value });
    }
    case "chapter.move": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const chapterId = idField(record.chapterId, "chapterId");
      const targetVolumeId = idField(record.targetVolumeId, "targetVolumeId");
      const afterChapterId = optionalStringField(record.afterChapterId, "afterChapterId", MAX_ID);
      const atStart = record.atStart === undefined ? ok(false) : booleanField(record.atStart, "atStart");
      if (!workspaceId.ok || !chapterId.ok || !targetVolumeId.ok || !afterChapterId.ok || !atStart.ok) return invalid("chapter.move payload is invalid");
      return ok({ workspaceId: workspaceId.value, chapterId: chapterId.value, targetVolumeId: targetVolumeId.value, afterChapterId: afterChapterId.value, atStart: atStart.value });
    }
    case "volume.delete": {
      const base = workspaceIdPayload(payload);
      const volumeId = idField(record.volumeId, "volumeId");
      if (!base.ok || !volumeId.ok) return invalid("volume.delete payload is invalid");
      return ok({ ...base.value, volumeId: volumeId.value });
    }
    case "chapter.load":
    case "chapter.loadSourceCorrection":
      return chapterPayload(payload);
    case "chapter.saveDraft": {
      const base = chapterPayload(payload);
      const baseRevision = revisionField(record.baseRevision, "baseRevision");
      const paragraphs = paragraphList(record.paragraphs);
      if (!base.ok || !baseRevision.ok || !paragraphs.ok) return invalid("chapter.saveDraft payload is invalid");
      return ok({ ...base.value, baseRevision: baseRevision.value, paragraphs: paragraphs.value });
    }
    case "chapter.checkpoint": {
      const base = chapterPayload(payload);
      const revision = revisionField(record.revision, "revision");
      if (!base.ok || !revision.ok) return invalid("chapter.checkpoint payload is invalid");
      return ok({ ...base.value, revision: revision.value });
    }
    case "chapter.saveSourceCorrection": {
      const base = chapterPayload(payload);
      const baseRevision = revisionField(record.baseRevision, "baseRevision");
      const source = typeof record.source === "string" && record.source.length <= MAX_TEXT ? ok(record.source) : invalid("source is invalid");
      if (!base.ok || !baseRevision.ok || !source.ok) return invalid("chapter.saveSourceCorrection payload is invalid");
      return ok({ ...base.value, baseRevision: baseRevision.value, source: source.value });
    }
    case "translate.run":
    case "translate.cancel":
    case "review.run":
    case "chapter.accept":
      return chapterPayload(payload);
    case "translate.runScope": {
      const base = workspaceIdPayload(payload);
      const raw = record.chapters;
      // 上限 2000：轻小说全集也到不了这个数；超出更可能是渲染层 bug 而不是真实意图
      if (!base.ok || !Array.isArray(raw) || raw.length === 0 || raw.length > 2000) {
        return invalid("translate.runScope payload is invalid");
      }
      const chapters: Array<{ chapterId: string; retranslate?: boolean }> = [];
      for (const item of raw) {
        const entry = asRecord(item);
        if (!entry) return invalid("translate.runScope chapters must be objects");
        const chapterId = idField(entry.chapterId, "chapterId");
        const retranslate = entry.retranslate === undefined ? ok(undefined) : booleanField(entry.retranslate, "retranslate");
        if (!chapterId.ok || !retranslate.ok) return invalid("translate.runScope chapters payload is invalid");
        chapters.push({ chapterId: chapterId.value, ...(retranslate.value === true ? { retranslate: true } : {}) });
      }
      return ok({ ...base.value, chapters });
    }
    case "translate.stopScope":
      return workspaceIdPayload(payload);
    case "bookReview.run":
    case "bookReview.cancel":
    case "bookReview.status":
      return workspaceIdPayload(payload);
    case "confirm.list": {
      const base = workspaceIdPayload(payload);
      const chapterId = optionalStringField(record.chapterId, "chapterId", MAX_ID);
      if (!base.ok || !chapterId.ok) return invalid("confirm.list payload is invalid");
      return ok({ ...base.value, chapterId: chapterId.value });
    }
    case "confirm.decide": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const action = record.action;
      const chosenZh = optionalStringField(record.chosenZh, "chosenZh", MAX_TEXT);
      const chosenCharacter = optionalStringField(record.chosenCharacter, "chosenCharacter", 256);
      const expectedIndex = record.expectedIndex === undefined ? ok(undefined) : revisionField(record.expectedIndex, "expectedIndex");
      if (!workspaceId.ok || !chosenZh.ok || !chosenCharacter.ok || !expectedIndex.ok || !["accept", "modify", "skip", "back", "quit"].includes(String(action))) {
        return invalid("confirm.decide payload is invalid");
      }
      return ok({ workspaceId: workspaceId.value, action: action as IpcRequestMap["confirm.decide"]["action"], chosenZh: chosenZh.value, chosenCharacter: chosenCharacter.value, expectedIndex: expectedIndex.value });
    }
    case "terms.query": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const chapterId = optionalStringField(record.chapterId, "chapterId", MAX_ID);
      const paragraphId = optionalStringField(record.paragraphId, "paragraphId", MAX_ID);
      const search = optionalStringField(record.search, "search", 256);
      const filters = termQueryFilters(record.filters);
      const cursor = record.cursor === undefined ? ok(undefined) : revisionField(record.cursor, "cursor");
      const baseRevision = record.baseRevision === undefined ? ok(undefined) : revisionField(record.baseRevision, "baseRevision");
      if (!workspaceId.ok || !chapterId.ok || !paragraphId.ok || !search.ok || !filters.ok || !cursor.ok || !baseRevision.ok) {
        return invalid("terms.query payload is invalid");
      }
      if (cursor.value !== undefined && baseRevision.value === undefined) return invalid("terms.query pagination requires baseRevision");
      return ok({ workspaceId: workspaceId.value, chapterId: chapterId.value, paragraphId: paragraphId.value, search: search.value, filters: filters.value, cursor: cursor.value, baseRevision: baseRevision.value });
    }
    case "terms.create":
    case "terms.update": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const termId = command === "terms.update" ? idField(record.termId, "termId") : ok(undefined);
      const archive = archiveField(record.archive, "archive");
      const ja = stringField(record.ja, "ja", 256);
      const zh = stringField(record.zh, "zh", 256);
      const type = optionalStringField(record.type, "type", 128);
      const character = optionalStringField(record.character, "character", 256);
      const strategy = optionalStringField(record.strategy, "strategy", 4_000);
      const enabled = record.enabled === undefined ? ok(undefined) : booleanField(record.enabled, "enabled");
      const gender = optionalStringField(record.gender, "gender", 16);
      const baseRevision = revisionField(record.baseRevision, "baseRevision");
      if (!workspaceId.ok || !termId.ok || !archive.ok || !ja.ok || !zh.ok || !type.ok || !character.ok || !strategy.ok || !enabled.ok || !gender.ok || !baseRevision.ok) return invalid(`${command} payload is invalid`);
      if (command === "terms.create" && !archive.value) return invalid("terms.create archive is required");
      if (archive.value === "voice" && !character.value) return invalid("voice terminology requires character");
      const fields = { workspaceId: workspaceId.value, archive: archive.value, ja: ja.value, zh: zh.value, type: type.value, character: character.value, strategy: strategy.value, enabled: enabled.value, gender: gender.value, baseRevision: baseRevision.value };
      return command === "terms.update" ? ok({ ...fields, termId: termId.value! }) : ok({ ...fields, archive: archive.value! });
    }
    case "rename.review":
      return workspaceIdPayload(payload);
    case "rename.resolve": {
      const base = workspaceIdPayload(payload);
      const entryId = idField(record.entryId, "entryId");
      if (!base.ok || !entryId.ok) return invalid("rename.resolve payload is invalid");
      return ok({ ...base.value, entryId: entryId.value });
    }
    case "terms.delete":
    case "terms.restore": {
      const base = workspaceIdPayload(payload);
      const termId = idField(record.termId, "termId");
      const archive = archiveField(record.archive, "archive");
      const baseRevision = revisionField(record.baseRevision, "baseRevision");
      if (!base.ok || !termId.ok || !archive.ok || !baseRevision.ok) return invalid(`${command} payload is invalid`);
      return ok({ ...base.value, termId: termId.value, archive: archive.value, baseRevision: baseRevision.value });
    }
    case "export.run": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      // target 可以是一组章节 id（作者在导出面板勾选的那些）。逐个按 id 规则校验：
      // 数组一律走 idField，混进空串或超长串时整个请求作废，不做「过滤掉坏的照样导」——
      // 那样导出的范围就不是作者勾的那个范围了。
      const target = Array.isArray(record.target)
        ? ((): Validation<string[]> => {
            const list = record.target as unknown[];
            if (list.length === 0) return invalid("target must not be an empty selection");
            if (list.length > MAX_EXPORT_TARGETS) return invalid(`target exceeds ${MAX_EXPORT_TARGETS} chapters`);
            const ids: string[] = [];
            for (const item of list) {
              const id = idField(item, "target[]");
              if (!id.ok) return id;
              ids.push(id.value);
            }
            return ok(ids);
          })()
        : stringField(record.target, "target", MAX_ID);
      const format = record.format;
      // 目录是路径（可以很长），文件名是单段（不该很长，更不该带路径）。
      // 净化在 engine 的 authorFileName 里做，这里只挡住畸形请求。
      const outDir = optionalStringField(record.outDir, "outDir", MAX_PATH);
      const fileName = optionalStringField(record.fileName, "fileName", MAX_FILE_NAME);
      if (!workspaceId.ok || !target.ok || !outDir.ok || !fileName.ok
        || !["txt", "md", "epub", "txt-bilingual", "md-bilingual", "epub-bilingual"].includes(String(format))) return invalid("export.run payload is invalid");
      return ok({
        workspaceId: workspaceId.value,
        target: target.value,
        format: format as IpcRequestMap["export.run"]["format"],
        ...(outDir.value === undefined ? {} : { outDir: outDir.value }),
        ...(fileName.value === undefined ? {} : { fileName: fileName.value }),
      });
    }
    case "workspace.exportArchive":
      return workspaceIdPayload(payload);
    case "settings.read":
      return workspaceIdPayload(payload);
    case "settings.write": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const baseRevision = revisionField(record.baseRevision, "baseRevision");
      const key = stringField(record.key, "key", 256);
      if (!workspaceId.ok || !baseRevision.ok || !key.ok || !jsonValue(record.value)) return invalid("settings.write payload is invalid");
      return ok({ workspaceId: workspaceId.value, baseRevision: baseRevision.value, key: key.value, value: record.value as JsonValue });
    }
    case "ai.providers.list":
      return workspaceIdPayload(payload);
    case "ai.key.write": {
      const providerId = stringField(record.providerId, "providerId", 256);
      const apiKey = stringField(record.apiKey, "apiKey", 4096);
      if (!providerId.ok || !apiKey.ok) return invalid("ai.key.write payload is invalid");
      return ok({ providerId: providerId.value, apiKey: apiKey.value });
    }
    case "ai.model.write": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const model = stringField(record.model, "model", 512);
      if (!workspaceId.ok || !model.ok) return invalid("ai.model.write payload is invalid");
      return ok({ workspaceId: workspaceId.value, model: model.value });
    }
    case "ai.test": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const model = optionalStringField(record.model, "model", 512);
      if (!workspaceId.ok || !model.ok) return invalid("ai.test payload is invalid");
      return ok({ workspaceId: workspaceId.value, model: model.value });
    }
    case "ai.provider.upsert": {
      const providerId = stringField(record.providerId, "providerId", 256);
      const name = stringField(record.name, "name", 256);
      const baseUrl = stringField(record.baseUrl, "baseUrl", 1024);
      const api = record.api === "openai-responses" || record.api === "openai-completions" ? ok(record.api) : invalid("api is invalid");
      if (!providerId.ok || !name.ok || !baseUrl.ok || !api.ok) return invalid("ai.provider.upsert payload is invalid");
      return ok({ providerId: providerId.value, name: name.value, baseUrl: baseUrl.value, api: api.value });
    }
    case "ai.provider.delete": {
      const providerId = stringField(record.providerId, "providerId", 256);
      return providerId.ok ? ok({ providerId: providerId.value }) : invalid("ai.provider.delete payload is invalid");
    }
    case "ai.model.upsert": {
      const providerId = stringField(record.providerId, "providerId", 256);
      const modelId = stringField(record.modelId, "modelId", 256);
      const modelName = optionalStringField(record.modelName, "modelName", 256);
      const thinkingLevelMap = thinkingLevelMapField(record.thinkingLevelMap);
      const contextWindow = optionalPositiveIntField(record.contextWindow, "contextWindow");
      const maxTokens = optionalPositiveIntField(record.maxTokens, "maxTokens");
      if (!providerId.ok || !modelId.ok || !modelName.ok || !thinkingLevelMap.ok || !contextWindow.ok || !maxTokens.ok) return invalid("ai.model.upsert payload is invalid");
      return ok({ providerId: providerId.value, modelId: modelId.value, modelName: modelName.value, thinkingLevelMap: thinkingLevelMap.value, contextWindow: contextWindow.value, maxTokens: maxTokens.value });
    }
    case "ai.model.delete": {
      const providerId = stringField(record.providerId, "providerId", 256);
      const modelId = stringField(record.modelId, "modelId", 256);
      if (!providerId.ok || !modelId.ok) return invalid("ai.model.delete payload is invalid");
      return ok({ providerId: providerId.value, modelId: modelId.value });
    }
    case "ai.provider.presets":
      return ok({});
    case "ai.config.open": {
      if (record.kind !== "models" && record.kind !== "auth") return invalid("ai.config.open payload is invalid");
      return ok({ kind: record.kind });
    }
    case "ai.models.detect": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const providerId = stringField(record.providerId, "providerId", 256);
      const baseUrl = stringField(record.baseUrl, "baseUrl", 1024);
      const apiKey = optionalStringField(record.apiKey, "apiKey", 4096);
      if (!workspaceId.ok || !providerId.ok || !baseUrl.ok || !apiKey.ok) return invalid("ai.models.detect payload is invalid");
      return ok({ workspaceId: workspaceId.value, providerId: providerId.value, baseUrl: baseUrl.value, apiKey: apiKey.value });
    }
    case "ai.thinking.probe": {
      const providerId = stringField(record.providerId, "providerId", 256);
      const modelId = stringField(record.modelId, "modelId", 256);
      if (!providerId.ok || !modelId.ok) return invalid("ai.thinking.probe payload is invalid");
      return ok({ providerId: providerId.value, modelId: modelId.value });
    }
    case "ai.key.open": {
      const providerId = stringField(record.providerId, "providerId", 256);
      return providerId.ok ? ok({ providerId: providerId.value }) : invalid("ai.key.open payload is invalid");
    }
    case "ai.thinking.write": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const thinking = stringField(record.thinking, "thinking", 32);
      if (!workspaceId.ok || !thinking.ok) return invalid("ai.thinking.write payload is invalid");
      return ok({ workspaceId: workspaceId.value, thinking: thinking.value });
    }
    case "ai.reviewThinking.write": {
      const workspaceId = idField(record.workspaceId, "workspaceId");
      const thinking = stringField(record.thinking, "thinking", 32);
      if (!workspaceId.ok || !thinking.ok) return invalid("ai.reviewThinking.write payload is invalid");
      return ok({ workspaceId: workspaceId.value, thinking: thinking.value });
    }
    case "ai.key.delete": {
      const providerId = stringField(record.providerId, "providerId", 256);
      return providerId.ok ? ok({ providerId: providerId.value }) : invalid("ai.key.delete payload is invalid");
    }
    case "ai.oauth.login":
    case "ai.oauth.wait":
    case "ai.oauth.refresh": {
      const providerId = stringField(record.providerId, "providerId", 256);
      return providerId.ok ? ok({ providerId: providerId.value }) : invalid("ai.oauth payload is invalid");
    }
    case "usage.report": {
      const workspaceId = stringField(record.workspaceId, "workspaceId", 128);
      return workspaceId.ok ? ok({ workspaceId: workspaceId.value }) : invalid("usage.report payload is invalid");
    }
    case "agent.log.list": {
      const limit = isRecord(payload) && typeof payload.limit === "number" && payload.limit > 0 ? Math.min(Math.floor(payload.limit), 100) : undefined;
      // workspaceId 给了就必须合法（与其他 id 同一把尺）。类型不对不许静默回落成
      // 「不过滤」——那等于把这本书的控制台悄悄变回全局流水账，正是这条参数要防的事。
      if (record.workspaceId !== undefined) {
        const workspaceId = idField(record.workspaceId, "workspaceId");
        if (!workspaceId.ok) return invalid("agent.log.list payload is invalid");
        return ok({ limit, workspaceId: workspaceId.value });
      }
      return ok({ limit });
    }
    case "agent.log.read": {
      const id = stringField(record.id, "id", 128);
      return id.ok ? ok({ id: id.value }) : invalid("agent.log.read payload is invalid");
    }
    case "dev.prompt.probe": {
      // prompt 可以很长（实验台要送整章正文），上限按单次调用的现实规模给，不按普通字段给
      const system = stringField(record.system, "system", 400_000);
      const user = stringField(record.user, "user", 400_000);
      const model = optionalStringField(record.model, "model", 256);
      const thinking = optionalStringField(record.thinking, "thinking", 32);
      if (!system.ok || !user.ok || !model.ok || !thinking.ok) return invalid("dev.prompt.probe payload is invalid");
      const maxTokens = record.maxTokens === undefined ? undefined
        : typeof record.maxTokens === "number" && Number.isFinite(record.maxTokens) && record.maxTokens > 0 ? Math.floor(record.maxTokens)
        : null;
      if (maxTokens === null) return invalid("dev.prompt.probe payload is invalid");
      // 工具（PT-02）：只校验形状（name/description/parameters 三件套齐全），
      // 不校验 JSON Schema 本身——那是服务商的活，我们再写一份只会有第二套判定。
      let tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> | undefined;
      if (record.tools !== undefined) {
        if (!Array.isArray(record.tools)) return invalid("dev.prompt.probe payload is invalid");
        const parsed: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
        for (const raw of record.tools) {
          const tool = raw as { name?: unknown; description?: unknown; parameters?: unknown };
          if (typeof tool.name !== "string" || !tool.name
            || typeof tool.description !== "string"
            || !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
            return invalid("dev.prompt.probe payload is invalid");
          }
          // 约束采样（KA-2）：只认这两种形态，别的一律拒——写错了就该在这里失败，
          // 而不是变成一次「schema 看着生效了其实没有」的实验
          const sampling = (tool as { constrainedSampling?: unknown }).constrainedSampling;
          let constrainedSampling: false | { type: "json_schema"; strict: "prefer" | "require" } | undefined;
          if (sampling === false) constrainedSampling = false;
          else if (isRecord(sampling)) {
            if (sampling.type !== "json_schema" || (sampling.strict !== "prefer" && sampling.strict !== "require")) {
              return invalid("dev.prompt.probe payload is invalid");
            }
            constrainedSampling = { type: "json_schema", strict: sampling.strict };
          } else if (sampling !== undefined) return invalid("dev.prompt.probe payload is invalid");
          parsed.push({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as Record<string, unknown>,
            ...(constrainedSampling === undefined ? {} : { constrainedSampling }),
          });
        }
        tools = parsed;
      }
      // 多轮历史（PT-02）：只验形状与角色枚举，内容长度按单次调用的现实规模给。
      // 实验台是 dev 门控通道，这里不做业务校验——真伪判定属于引擎的 L0 层。
      let messages: IpcRequestMap["dev.prompt.probe"]["messages"];
      if (record.messages !== undefined) {
        if (!Array.isArray(record.messages)) return invalid("dev.prompt.probe payload is invalid");
        const roles = new Set(["system", "user", "assistant", "toolResult"]);
        const parsed: NonNullable<IpcRequestMap["dev.prompt.probe"]["messages"]> = [];
        for (const raw of record.messages) {
          const m = raw as Record<string, unknown>;
          if (typeof m.role !== "string" || !roles.has(m.role) || typeof m.content !== "string") {
            return invalid("dev.prompt.probe payload is invalid");
          }
          // 续接句柄（KA-1）：本层**不解读**它——它是引擎侧 pi-ai 的原始 assistant 消息，
          // 认识它就等于让 electron 依赖 pi-ai。但「不解读」不等于「不设防」：
          // 它从渲染层进来，按不可信输入过一遍 jsonValue（含 8 层深度上限）。
          if (m.continuation !== undefined && !jsonValue(m.continuation)) {
            return invalid("dev.prompt.probe payload is invalid");
          }
          parsed.push({
            role: m.role,
            content: m.content,
            ...(m.continuation === undefined ? {} : { continuation: m.continuation as JsonValue }),
            ...(typeof m.reasoning === "string" ? { reasoning: m.reasoning } : {}),
            ...(Array.isArray(m.toolCalls) ? { toolCalls: m.toolCalls as NonNullable<NonNullable<IpcRequestMap["dev.prompt.probe"]["messages"]>[number]["toolCalls"]> } : {}),
            ...(typeof m.toolCallId === "string" ? { toolCallId: m.toolCallId } : {}),
            ...(typeof m.toolName === "string" ? { toolName: m.toolName } : {}),
            ...(m.toolIsError === true ? { toolIsError: true } : {}),
          });
        }
        messages = parsed;
      }
      return ok({
        system: system.value,
        user: user.value,
        ...(messages === undefined ? {} : { messages }),
        ...(model.value === undefined ? {} : { model: model.value }),
        ...(thinking.value === undefined ? {} : { thinking: thinking.value }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(tools === undefined ? {} : { tools }),
      });
    }
    case "dialog.pickDirectory":
    case "dialog.pickFile": {
      const title = isRecord(payload) && typeof payload.title === "string" ? payload.title : undefined;
      return ok({ title });
    }
  }
}

export function validateEnvelope(input: unknown): Validation<ValidatedEnvelope> {
  if (!isRecord(input)) return invalid("IPC envelope must be an object");
  if (input.version !== IPC_VERSION) return invalid("Unsupported IPC envelope version");
  const requestId = stringField(input.requestId, "requestId", 128);
  const command = input.command;
  if (!requestId.ok || typeof command !== "string" || !(IPC_COMMANDS as readonly string[]).includes(command)) {
    return invalid("IPC envelope requestId or command is invalid");
  }
  const payload = validatePayload(command as IpcCommand, input.payload);
  if (!payload.ok) return payload;
  return ok({ version: IPC_VERSION, requestId: requestId.value, command: command as IpcCommand, payload: payload.value });
}

export function isIpcCommand(value: unknown): value is IpcCommand {
  return typeof value === "string" && (IPC_COMMANDS as readonly string[]).includes(value);
}

export function isIpcEventName(value: unknown): value is IpcEventName {
  return typeof value === "string" && (IPC_EVENT_NAMES as readonly string[]).includes(value);
}
