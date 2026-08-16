/**
 * Orchestrator 主循环 —— 状态机驱动流水线（LLM 大脑 + 代码工具手）。
 *
 * 流程:
 *   import → ready → translate(并发池) → translated → review → 修订循环 → approved/stuck
 *
 * 关键设计:
 *  - 状态权威在 chapterState（单写者：仅 Orchestrator 修改）
 *  - 并发池调度 Translator 与修复阶段（默认 3），同章排他（M1）
 *  - 修订循环: replace_all 代码替换 → 复校；revise_chapter 打回重译 → 复校
 *  - 熔断: 修订 ≥2 次仍 high → stuck
 *  - 断点续跑: 从非 approved 状态继续（L1）
 */

import {
  advanceState,
  createChapterStatus,
  type ChapterStatus,
  type ChapterState,
} from "@lightee/core/state-machine";

/** 审校报告里的一条问题。取自 `PipelineOptions.review` 的返回形状，一处真相 */
type ReviewIssueLike = Awaited<ReturnType<NonNullable<PipelineOptions["review"]>>>["issues"][number];

/**
 * 局部修订的次数上限（RV-03）。修复阶梯只剩一级：整章重译（含换备用模型）已退役
 * ——花 token 把整章重写去修一个局部问题，还可能把别处改坏，而作者反正要自己核对。
 * 修不净就标给作者。
 */
const MAX_LOCAL = 1;

/**
 * 修订阶梯的动作集（BQ-03）。**代码按状态/报告/阶梯算出 allowed，然后取首项**——
 * 这个类型此前叫 `ManagerAction`，因为当时设想由 LLM 从 allowed 里挑一个。
 * MG-01 删掉 Manager 之后名实归一：挑选从来就是代码做的（allowed 按代价升序，取 [0]）。
 */
type RepairAction = "revise_passages" | "request_human";

/**
 * 章节卡在人工决策上的原因（MG-01）。
 *
 * 此前这句话由一次 LLM 调用产出（manager 的 stuck 决策），而那次调用**不改变任何
 * 处置路径**——`orchestrator` 的注释自己写着「skip/keep 两者都不改变代码的处置路径」。
 * 生产中它只触发过 3 次，每次的产出就是拼进这行文案的一句散文。
 *
 * 现在由代码写：所有事实（问题类型、是否重复出现、局部修订试过几次、可定位段落占比）
 * 本来就在手上，不需要花钱问模型。**说得比从前更具体**——从前那句只说「仍待处理」。
 */
function describeStuck(facts: {
  issues: ReviewIssueLike[];
  repeated: boolean;
  localTried: number;
  localizable: number;
  allLocalizable: boolean;
  total: number;
}): string {
  const types = [...new Set(facts.issues.filter((i) => i.severity === "high").map((i) => i.type))];
  const what = types.length > 0 ? types.join("、") : "审校问题";
  // 为什么没走局部修订——四条互斥的理由，按判定顺序取第一条命中的
  const why = facts.repeated
    ? "同类问题上一轮修过又出现，再修一次多半还是同样结果"
    : facts.localTried >= MAX_LOCAL
      ? `局部修订已用满 ${MAX_LOCAL} 次`
      : !facts.allLocalizable
        ? "有问题定位不到具体段落，局部修订无从下手"
        : facts.localizable === 0
          ? "没有可定位的段落"
          : facts.total > 0 && facts.localizable / facts.total > 0.15
            ? `涉及 ${facts.localizable}/${facts.total} 段，超出局部修订的范围`
            : `涉及 ${facts.localizable} 段，超出局部修订单次上限 5 段`;
  return `需要作者处理：${what}（${why}）`;
}

export type TranslatorFn = (chapterId: string, opts: { retryNote?: string; model?: string }) => Promise<{
  translation: string;
  drifts: Array<{ ja: string; type: string; expected?: string; found?: string }>;
  pendingTerms: Array<{ ja: string; context: string }>;
}>;

export type ReviewerFn = (chapterIds: string[]) => Promise<{
  issues: Array<{
    id: string;
    severity: "high" | "medium" | "low";
    type: string;
    chapterId: string;
    expected?: string;
    found?: string;
    dialogueSafe: boolean;
    // `suggestedAction` 已删除：BQ-03 之后动作由**代码**从状态/报告/阶梯算出
    // （allowed 按代价升序取首项），审校那侧的建议从来没有被读过。
    // RV-03 退役 replace_all 之后它连唯一可能的用途也没有了。
    /** RV-04 权威定位：这条问题落在哪些段落上（扫描时记录，不靠行号反解）。 */
    paragraphIds?: string[];
    /** 术语类问题涉及的日文词（RV-03 的修订指示要写「把 X 改为 Y」）。 */
    termJa?: string;
  }>;
}>;

export interface PipelineOptions {
  chapterIds: string[];
  // EX-07 / ADR-0007：terminologyConfirmed 门禁退役。译前提取阶段不复存在，
  // 术语随翻译逐章长出来（EX-04 融合提取），没有「确认完才准开工」这个节点了。
  translate: TranslatorFn;
  review: ReviewerFn;
  // RV-03：orderText / applyReplacement（字符串盲替换）已随修复循环重构删除。
  // 术语面板里作者显式发起的全章术语同步是另一条路径，不受影响。
  /** 局部修订（BQ-03）：返回每个段落的修订译文（不落盘；由调用方经 applyParagraphChanges 应用） */
  revisePassages?: (
    chapterId: string,
    items: Array<{ paragraphId: string; issues: string[] }>,
    opts?: { model?: string }
  ) => Promise<Array<{ paragraphId: string; translation: string; resolvedIssueIds?: string[] }>>;
  /** 应用局部修订（BQ-03）：按段落 ID 原子写入（受版本保护） */
  applyParagraphChanges?: (chapterId: string, changes: Array<{ paragraphId: string; translation: string }>) => Promise<void> | void;
  /** 把审校 issue 定位到段落（BQ-03：allowedActions 资格判断） */
  resolveIssueParagraphs?: (issue: { location?: string; type?: string; chapterId?: string; paragraphIds?: string[] }) => string[];
  /** 章节源段落数（BQ-03：局部修订 15% 阈值） */
  totalParagraphs?: (chapterId: string) => number;
  // RV-03：hasFallbackModel / fallbackModel 随 reroute_translator 一并删除。
  // 该字段从未接入 Electron（无配置入口，实测恒为 undefined），删除不损失既有能力。
  concurrency?: number;
  onStateChange?: (chapterId: string, from: ChapterState, to: ChapterState, detail?: string) => void | Promise<void>;
  /** Counts translator executions that do not claim a fresh translating state. */
  onAttempt?: (chapterId: string) => void | Promise<void>;
  /** 恢复用：已有状态（断点续跑） */
  initialStates?: Map<string, ChapterStatus>;
  /** States claimed as translating by the current caller before orchestration. */
  initialTranslatingClaims?: Set<string>;
}

export interface ChapterOutcome {
  chapterId: string;
  state: ChapterState;
  version: number;
  reviseCount: number;
  attempt: number;
  retryCount: number;
  lastError?: string;
  lastReason?: string | null;
}

type ChapterStatusWithError = ChapterStatus & { attempt?: number; retryCount?: number; lastError?: string };

export interface PipelineResult {
  outcomes: ChapterOutcome[];
  /** 完成（approved）的章节 */
  approved: string[];
  /** 熔断（stuck）的章节 */
  stuck: string[];
  /** 是否全部完成 */
  allDone: boolean;
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  // EX-05 / D7：默认串行。融合提取（EX-04）让术语表随翻译逐章增长，并发翻译时
  // 同一个新词会在同批章节里各自得到一个译名，而先落盘的那个才是权威——
  // 这种不一致要靠追溯改名去补，代价高于并发省下的挂钟。跑通之后再评估窗口并发。
  const concurrency = options.concurrency ?? 1;
  // 翻译顺序即阅读顺序（MG-01）。此前这里有一次 LLM 定序调用，但轻小说的
  // 上下文连续性正建立在阅读顺序上——那个决策点最好的结果就是「什么都不改」。
  const order = options.chapterIds;
  const states = new Map<string, ChapterStatusWithError>(
    order.map((id) => [id, (options.initialStates?.get(id) ?? createChapterStatus(id)) as ChapterStatusWithError])
  );

  const transition = async (id: string, to: ChapterState, detail?: string) => {
    const cur = states.get(id)!;
    const next = advanceState(cur, to) as ChapterStatusWithError;
    if (to === "translating") next.attempt = (cur.attempt ?? 0) + 1;
    states.set(id, next);
    await options.onStateChange?.(id, cur.state, to, detail);
  };

  const recordAttempt = async (id: string): Promise<void> => {
    const current = states.get(id)!;
    const next = {
      ...current,
      attempt: (current.attempt ?? 0) + 1,
      lastActivityAt: new Date().toISOString(),
      lastError: undefined,
    } satisfies ChapterStatusWithError;
    states.set(id, next);
    await options.onAttempt?.(id);
  };

  const translateOnce = async (id: string, opts: { retryNote?: string; model?: string }, enteredTranslating: boolean): Promise<Awaited<ReturnType<TranslatorFn>>> => {
    if (!enteredTranslating) await recordAttempt(id);
    return options.translate(id, opts);
  };

  // 将 imported → ready
  for (const id of options.chapterIds) {
    const s = states.get(id)!;
    if (s.state === "imported") await transition(id, "ready");
  }

  /**
   * 固定并发池：按 ids 顺序分发，每个 id 只被一个 worker 领取（同章排他）。
   * states/repair 的读改写均为同步段（set 早于 await），故跨 worker 无竞态。
   */
  const runPool = async (ids: string[], handle: (id: string) => Promise<void>): Promise<void> => {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++]!;
        await handle(id);
      }
    });
    await Promise.all(workers);
  };

  // —— 翻译阶段（并发池）——
  // 只处理 ready / revising（打回的）章节
  const translateBatch = async (ids: string[]) =>
    runPool(ids, async (id) => {
      const s = states.get(id)!;
      if (s.state !== "ready" && s.state !== "revising" && s.state !== "translating") return;
      // A persisted translating state means the previous process stopped after
      // claiming the work. Re-run the translator without an illegal self-transition.
      const claimedByCurrentRun = options.initialTranslatingClaims?.has(id) ?? false;
      const needsTransition = s.state !== "translating";
      if (needsTransition) await transition(id, "translating");
      try {
        await translateOnce(id, {}, needsTransition || claimedByCurrentRun);
        states.set(id, { ...states.get(id)!, lastActivityAt: new Date().toISOString() });
        // 保存译文（简化：这里只推进状态，译文落盘由调用方处理）
        await transition(id, "translated");
      } catch (e) {
        states.set(id, { ...states.get(id)!, lastError: (e as Error).message } as ChapterStatusWithError);
        await transition(id, "ready", `翻译失败: ${(e as Error).message}`);
      }
    });

  await translateBatch([...states.keys()].filter((id) => ["ready", "revising", "translating"].includes(states.get(id)!.state)));

  // —— 审校阶段 ——
  const toReview = [...states.keys()].filter((id) => ["translated", "reviewing"].includes(states.get(id)!.state));
  if (toReview.length > 0) {
    for (const id of toReview) {
      if (states.get(id)!.state === "translated") await transition(id, "reviewing");
    }

    // 修订循环：每章处理自己的问题（循环直到 approved/stuck，熔断保护）
    // BQ-03：allowedActions 由代码按状态/报告/阶梯算出，代码执行并维护修订阶梯
    const repair = new Map<string, { local: number; lastTypes: string[] }>();
    const getRepair = (id: string) => {
      let r = repair.get(id);
      if (!r) {
        r = { local: 0, lastTypes: [] };
        repair.set(id, r);
      }
      return r;
    };

    /**
     * 一条问题写给局部修订的指示（RV-03）。
     *
     * 术语类问题从前走字符串盲替换，现在改由 LLM 在段内精确改写——但必须把
     * 「换什么、换成什么、凭什么」一起交代清楚，否则模型只会看到一个孤零零的词。
     * 「作者已确认」这句是权威声明：档案里的译法是作者拍过板的，不容模型另行发挥。
     *
     * **按类型逐条写，不做通用拼装**。从前这里是一句 `issue.found ? 把「found」改为
     * 「expected」 : …`，靠的是「term 族问题的 found 一定是译文里那个错词」这个前提。
     * term_missing / term_drift / count_mismatch 整族删除之后，剩下的两类里
     * `pun_note_missing` 的 found 是一句**散文描述**（「译法有但译注缺失」）——
     * 那条通用拼装会写出「把「译法有但译注缺失」改为「小灯」」，指使模型去替换一句说明文字。
     *
     * 修复循环会把该段上的**所有**问题（不只 high）都写进指示，所以低severity 的
     * pun_note_missing 确实到得了这里。
     */
    const reviseInstructionFor = (issue: ReviewIssueLike): string => {
      const term = (issue as { termJa?: string }).termJa;
      const authority = "（该判定为作者确认，请勿另行发挥；只改这一处，句子其余部分保持原样，改后读起来要通顺）";
      if (issue.type === "no_translate_missing" && term) {
        return `[no_translate_missing] 原文的「${term}」是禁翻词，译文里必须**原样保留**，不得译成中文${authority}`;
      }
      if (issue.type === "pun_note_missing" && term && issue.expected) {
        return `[pun_note_missing] 原文的「${term}」是谐音梗，须译作「${issue.expected}」并紧跟一句（译注: 说明梗在哪里）${authority}`;
      }
      return `[${issue.type}] ${issue.found ?? ""}${issue.expected ? `（应为: ${issue.expected}）` : ""}`;
    };

    /**
     * 处理一章的审校问题。返回：
     * - "approved"：通过
     * - "stuck"：熔断/人工升级
     * - "pending"：已修订，待复校
     */
    const repairChapter = async (id: string, chapterIssues: ReviewIssueLike[]): Promise<"approved" | "stuck" | "pending"> => {
      const high = chapterIssues.filter((i) => i.severity === "high");
      if (high.length === 0) {
        await transition(id, "approved");
        return "approved";
      }

      // RV-03：`replace_all` 的字符串盲替换已退役。它不看上下文，把「雏鸟」换成「小灯」
      // 会造语法/量词错配；术语问题一律转成局部修订单，指示里写明该换什么、为什么该换。
      // （术语面板里作者显式发起的全章术语同步不在此列，那是 R3 的决策，保留不动。）

      // 修订阶梯状态（先取；熔断与 allowedActions 共用）
      const r = getRepair(id);

      // —— BQ-03：allowedActions（代码计算）——
      const types = high.map((i) => i.type);
      const repeated = r.lastTypes.length > 0 && types.some((t) => r.lastTypes.includes(t));
      const paraIds = new Set<string>();
      let allLocalizable = true;
      for (const i of chapterIssues) {
        const ids = options.resolveIssueParagraphs?.(i) ?? [];
        if (ids.length === 0) allLocalizable = false;
        for (const pid of ids) paraIds.add(pid);
      }
      const total = options.totalParagraphs?.(id) ?? 0;
      const localEligible = allLocalizable && paraIds.size > 0 && paraIds.size <= 5 && (total === 0 || paraIds.size / total <= 0.15);
      const allowed: RepairAction[] = [];
      if (!repeated && r.local < MAX_LOCAL && localEligible) allowed.push("revise_passages");
      // RV-03：retranslate_chapter / reroute_translator 已从阶梯移除。局部修不了或修不净，
      // 下一步就是交给作者——这是设计意图，不是能力不足的退让。
      allowed.push("request_human");

      // 动作选择：allowed 按代价升序构造，首项即当前最省的可行动作（PL-12）。
      // 原 arbitrate LLM 调用只能选到更靠后（更贵或更终态）的动作，且其输入仅为截断的问题摘要，
      // 不具备优于首项的判断依据，已删除。
      let chosen: RepairAction = allowed[0]!;

      // —— 执行 ——
      if (chosen === "revise_passages") {
        if (!options.revisePassages) {
          chosen = allowed.filter((a) => a !== "revise_passages")[0]!;
        } else {
          const byParagraph = new Map<string, string[]>();
          for (const i of chapterIssues) {
            const ids = options.resolveIssueParagraphs?.(i) ?? [];
            for (const pid of ids) {
              const list = byParagraph.get(pid) ?? [];
              list.push(reviseInstructionFor(i));
              byParagraph.set(pid, list);
            }
          }
          const items = [...byParagraph.entries()].map(([paragraphId, issues]) => ({ paragraphId, issues }));
          try {
            const changes = await options.revisePassages(id, items);
            if (changes.length === 0) {
              chosen = allowed.filter((a) => a !== "revise_passages")[0]!;
            } else {
              await options.applyParagraphChanges?.(id, changes);
              r.local += 1;
              await transition(id, "revising", `局部修订 ${changes.length} 段`);
              await transition(id, "translated", "局部修订完成，待复校");
              return "pending";
            }
          } catch (e) {
            await transition(id, "stuck", `局部修订失败: ${(e as Error).message}`);
            return "stuck";
          }
        }
      }
      // request_human（局部修订之外的唯一动作）
      await transition(id, "stuck", describeStuck({
        issues: chapterIssues,
        repeated,
        localTried: r.local,
        localizable: paraIds.size,
        allLocalizable,
        total,
      }));
      return "stuck";
    };

    // 主循环：首轮 + 复校（最多 4 轮，熔断保护；每轮所有 translated 章节统一审校）
    let current = toReview;
    let round = 0;
    while (current.length > 0 && round < 4) {
      for (const id of current) {
        if (states.get(id)!.state === "translated") await transition(id, "reviewing");
      }
      const reportRound = await options.review(current);
      const issuesByChapterRound = new Map<string, typeof reportRound.issues>();
      for (const issue of reportRound.issues) {
        const list = issuesByChapterRound.get(issue.chapterId) ?? [];
        list.push(issue);
        issuesByChapterRound.set(issue.chapterId, list);
      }
      let anyPending = false;
      // 修复走与翻译同一并发池（PL-31）：按 id 分发保证同章排他
      await runPool(current, async (id) => {
        const issues = issuesByChapterRound.get(id) ?? [];
        const r = getRepair(id);
        const highTypes = issues.filter((i) => i.severity === "high").map((i) => i.type);
        const result = await repairChapter(id, issues);
        r.lastTypes = highTypes;
        if (result === "pending") anyPending = true;
      });
      if (!anyPending) break;
      current = [...states.keys()].filter((cid) => states.get(cid)!.state === "translated");
      round += 1;
    }

    // 轮次耗尽仍未决的章节升级 stuck（PL-06）：否则滞留 translated，approved/stuck 两侧都不报，
    // 用户看到的是一次静默的不完整运行。translated 无法直达 stuck，先过 reviewing。
    for (const id of [...states.keys()]) {
      const state = states.get(id)!.state;
      if (state !== "translated" && state !== "reviewing") continue;
      if (state === "translated") await transition(id, "reviewing");
      await transition(id, "stuck", "复校轮次耗尽");
    }
  }

  return summarize(states);
}

function summarize(states: Map<string, ChapterStatusWithError>): PipelineResult {
  const outcomes: ChapterOutcome[] = [...states.entries()].map(([id, s]) => ({
    chapterId: id,
    state: s.state,
    version: s.version,
    reviseCount: s.reviseCount,
    attempt: (s as ChapterStatusWithError & { attempt?: number }).attempt ?? 0,
    retryCount: (s as ChapterStatusWithError & { retryCount?: number }).retryCount ?? 0,
    lastError: s.lastError,
    lastReason: (s as ChapterStatusWithError & { lastReason?: string | null }).lastReason,
  }));
  const approved = outcomes.filter((o) => o.state === "approved").map((o) => o.chapterId);
  const stuck = outcomes.filter((o) => o.state === "stuck").map((o) => o.chapterId);
  return {
    outcomes,
    approved,
    stuck,
    allDone: outcomes.every((o) => o.state === "approved"),
  };
}
