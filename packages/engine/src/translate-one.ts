/**
 * translate-one —— 单章翻译到文件（TUI /translate 的真实 pipeline 入口）。
 *
 * 上下文组装（PL-11 前缀缓存排序，单发与分批共用同一组装函数）:
 *   system: 静态前缀（角色 + 翻译指南 + 输出格式 + 融合提取规则）
 *           + 累积词表（全表、追加序）+ 章节可变段（作者偏好 + 本章双关档案）
 *   user:   重译要求 + 原文（段落 wire）
 * 落盘:     L0 译后变换（引号风格）→ translations/{id}_zh.md
 *
 * 输出预算（PL-01）：译文 + reasoning 必须落在模型 maxTokens 之内，
 * 超预算的章节走分批通道，而不是发出去等着被截断。
 *
 * 门禁重试预算（R0-5）：单章所有门禁触发的额外调用共用一个计数器，见 GATE_RETRY_BUDGET。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Workspace } from "./workspace.ts";
import { resolveChapter } from "./chapter-fs.ts";
import { configuredMaxTokens, type PipelineConfig } from "./cli-pipeline.ts";
import { TerminologyRepository } from "@lightee/core/terminology-repository";
import { batchBlocks } from "@lightee/core/batch";
import {
  buildParagraphs,
  paragraphsToXml,
  parseParagraphsXml,
  paragraphsToText,
  type ParagraphBlock,
  type ParagraphType,
} from "@lightee/core/paragraph";
import {
  gateTranslationOutput,
  readChapterParagraphs,
  writeChapterParagraphs,
  type ChapterParagraph,
  type ParagraphWireError,
} from "./paragraph-gate.ts";
import { preparePreferencesForTranslation, preferencesForChapter } from "./author-preferences.ts";
import { applyPostTransforms } from "./post-transform.ts";
import { applyPreTransforms, buildNoTranslateLines, readDictionaries } from "./dictionary.ts";
import { renderTermLine } from "./term-prefix.ts";
import { resolvePersonas } from "./persona.ts";
import { collectLeakedTerms, extractPendingTerms, firstOccurrence, recordPendingTerms, type PendingTerm } from "./pending-terms.ts";
import { archiveRegisteredTerms } from "./register-archive.ts";
import { recordPendingVoices } from "./pending-voices.ts";
import { estTokensJa } from "./token-estimate.ts";
import { FUSED_EXAMPLE, describeDropped, type FusedTerm } from "@lightee/core/extract-fuse";
import type { Tool } from "@earendil-works/pi-ai";
import { REGISTER_TERMS_TOOL, renderToolResult, validateRegisteredTerms, type RegisteredVoice } from "./register-terms.ts";

/** 翻译指南（目标读者水平 + 语言风格）——settings translation.guide 可覆盖 */
export const DEFAULT_GUIDE = `【翻译指南】
目标读者: 中文轻小说读者——熟悉日式题材，但要求中文表达自然流畅，不保留日文语序的生硬感。
语言风格:
- 口语自然、角色语气鲜明（每个角色说话方式可辨识）、内心独白流畅
- 对话符合中文口语习惯，长度适中不啰嗦
- 拟声词/感叹词中文化（如「えっ」→「诶？」），不硬译
- 保持轻小说节奏感：场景切换干净、段落衔接自然
- 谐音/双关取舍之后，紧跟一句（译注: 说明梗在哪里）——中文读者看不到日文读音，
  不说破就等于这个笑点没译出来`;


export interface TranslateOneResult {
  translation: string;
  charCount: number;
  /** 译者在本章标注的新术语候选（已排除档案中已有的词），见 pending-terms.ts */
  pendingTerms: PendingTerm[];
  /** 因为是作者手改而未被本次重译覆盖的段落数（R3-2） */
  preservedHumanParagraphs: number;
  /**
   * 本章融合提取登记的新术语（EX-04）。已过补救层：逐字见于原文、不与累积词表重复。
   * 与 `pendingTerms` 并存而不合并——那是「译者拿不准、请作者定」，这是「这个词后续要统一」，
   * 两者的下游动作不同（前者建待审卡，后者进累积词表）。
   */
  newTerms: FusedTerm[];
  /**
   * 本章登记的语气档案卡（KA-4，仅工具通道产出）。已过补救层：角色名与引文都
   * 逐字见于本章原文。**存储形态即注入形态**（CONTEXT.md），下游不再做一次转换。
   *
   * 与 `newTerms` 分开：两者的下游动作不同——词进累积词表，卡进角色花名册。
   */
  newVoices: RegisteredVoice[];
}

/** 翻译侧 LLM 通道（maxTokens 显式传递，缺省交由注册表默认） */
export interface TranslateLlm {
  complete: (
    model: string,
    messages: Array<{
      role: "system" | "user" | "assistant" | "toolResult";
      content: string;
      /** 上一轮的原始 assistant 消息（KA-1）。工具通道的第二轮靠它回灌，不重建 */
      continuation?: unknown;
      toolCallId?: string;
      toolName?: string;
    }>,
    opts?: {
      thinking?: string;
      maxTokens?: number;
      /**
       * 函数工具（KA-4）。不传时行为与从前逐字节相同。
       *
       * 类型直取 pi 的 `Tool`：这是运行时真正的入参形状，在这里放宽成 `unknown[]`
       * 只会让「假 LLM 能过、真运行时不能过」——测试面比生产面松，等于没测。
       */
      tools?: Tool[];
    }
  ) => Promise<{
    text: string;
    /** 原始 assistant 消息。第二轮原样回灌（KA-1） */
    continuation?: unknown;
    /** 模型发起的工具调用（KA-4）。参数已过 schema，真伪校验仍在 L0 */
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    /**
     * 归一后的停止原因。`length` 只说明「没正常结束」——pi-ai 把所有
     * `status:"incomplete"` 都压成它。
     */
    stopReason?: string;
    /**
     * 服务商原始状态，未经归一映射（TR-12）。此前这个接口只声明 `text`，
     * 于是整条翻译链判「输出有没有被砍断」只能数 `<paragraph>` 标签的开闭差
     * （looksTruncated 的启发式）——服务商明说了的事，我们在用正则猜。
     */
    rawStopReason?: string;
  }>;
}

/**
 * 运行时抛出的「未正常结束且没有正文」（llm-runtime / TR-12）：
 * 思考把输出预算整个吃光的形态。降档与原样重发都不对，退路是切小任务。
 *
 * 判据是结构化的 `shapeKind`（KA-1）。此前这里比较的是中文文案
 * `errorMessage === "模型未正常结束"`——两个最大模块之间的控制流跑在一条字符串上，
 * 改个词要同时改三处而没有任何东西会红。
 */
function isIncompleteNoText(error: unknown): boolean {
  return (error as { shapeKind?: string } | null)?.shapeKind === "incomplete";
}

/** 段落 wire 输出格式要求（BQ-02：逐段一一对应） */
/**
 * 思考的用途与禁区（TR-06）。
 *
 * 判据来自真实跑批的思考内容：炸掉的调用平均复述 1554 个假名字符，正常的只有 23——
 * **66 倍**。它们把原文抄进思考、在里面完整译一遍、再推翻改写，然后才开始往外吐。
 * 同一份劳动做了两次，而预算烧在第一遍上（实测思考 13447 字符 / 正文 174 字符，
 * 正文停在半个标签上）。
 *
 * 这不是「档位太高」：同一档位内思考量能差 100 倍，输入规模与思考量的相关系数
 * 只有 −0.166。也不是「任务太复杂」：那条 13447 的样本本身就是第 4/4 批、
 * 只有 8 个段落。是我们从来没告诉过模型思考该用在哪。
 */
const THINKING_SCOPE_RULE = `【思考的用法】思考用来解决真正的歧义：人名读音、指代对象、双关取舍、敬称层级。
不要在思考中复述原文，不要在思考中先起草一遍完整译文——译文直接写进输出。`;

/**
 * 完整样例块。放在静态前缀末尾：它对每一章都相同，落在前缀缓存边界内。
 *
 * 样例只示范段落——术语登记的格式说明书是 `register_terms` 的 schema，不是散文，
 * 也不需要样例（KA-5：`===TERMS===` 尾块通道已退役）。
 */
function exampleBlock(): string {
  return `【完整样例】输入：\n${FUSED_EXAMPLE.input}\n\n输出（一字不差地照这个结构）：\n${FUSED_EXAMPLE.output}`;
}

const PARAGRAPH_OUTPUT_RULE = `【输出格式】逐段翻译【原文】中的每个 <paragraph> 段落，返回：<paragraph id="原文段落id">译文</paragraph>。每段独立成行。严格规则：
- 段落 id 必须与输入完全一致，顺序一致，数量一致。
- 不得新增、删除、合并、拆分或调换段落。
- 段内允许自由组织句子（拆句/并句/调语序），但不得跨段。
- 除 id 外不要输出其他属性，不要输出本说明。`;

// NEW_TERM_RULE（内联【待审:原文】标记）在 EX-08 收尾时退役，判据是实测而不是推演：
//
// - R4-2 的真实一章（4622 字）实测：模型写出的内联标记 **0 个**，而同一章里术语表外的
//   角色名出现了 53 次。这条规则每章都在静态前缀里收费，产出为零。
// - EX-04 的 ===TERMS=== 尾块要的是同一件事（登记术语表外的专名），且实测有效
//   （准确率 ≈98%）。两条规则并存等于对同一件事下两道格式不同的指令，
//   模型只会挑一条执行——实测挑的是尾块。
//
// 收割侧**保留不动**：`extractPendingTerms` 的正则、reviewer-scan 与 term-adherence 的
// 剥离仍在。历史译文里可能残留标记，收割和剥离不能跟着规则一起消失。
// R4-2 的假名残留反推（collectLeakedTerms）也保留——它不依赖模型自觉。

// ===== 风格锚定（R2-3） =====

/**
 * 风格参照的硬顶。锚定是为了给模型一个语感样本，不是把参考书塞进上下文——
 * 它在静态前缀里，超限的代价是每章都要为这段多付一次缓存读。
 */
export const STYLE_ANCHOR_MAX_TOKENS = 2000;

export interface StyleAnchor {
  text: string;
  tokens: number;
  truncated: boolean;
}

/**
 * 规整并按上限截断作者提供的风格参照文本。
 *
 * 优先按段落边界截断（切在句子中间的样本给不出语感）；单段就超限时硬切，
 * 因为整段丢弃等于锚定没生效，作者却看不到任何提示。
 */
export function buildStyleAnchor(raw: string | undefined): StyleAnchor {
  const text = (raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { text: "", tokens: 0, truncated: false };
  if (estTokensJa(text) <= STYLE_ANCHOR_MAX_TOKENS) {
    return { text, tokens: estTokensJa(text), truncated: false };
  }
  const paragraphs = text.split(/\n{2,}/);
  const kept: string[] = [];
  for (const paragraph of paragraphs) {
    const candidate = [...kept, paragraph].join("\n\n");
    if (estTokensJa(candidate) > STYLE_ANCHOR_MAX_TOKENS) break;
    kept.push(paragraph);
  }
  if (kept.length > 0) {
    const joined = kept.join("\n\n");
    return { text: joined, tokens: estTokensJa(joined), truncated: true };
  }
  // 首段自己就超限 → 按估算系数反推字符数硬切
  const cut = text.slice(0, Math.floor(STYLE_ANCHOR_MAX_TOKENS * 1.8));
  return { text: cut, tokens: estTokensJa(cut), truncated: true };
}

// ===== 输出预算（PL-01） =====

/**
 * 「产出明显偏少」检测的触发下限（源字符）。太短的章节（标题页、分隔页）本来就
 * 可能既无新词也无必要输出尾块，对它们告警只会制造噪音——一个总在响的警报等于没有警报。
 */
const MIN_CHARS_FOR_TERMS_EXPECTED = 800;

/** 注册表默认输出上限（llm-runtime.ts 的 `m.maxTokens ?? 8192`）——未配置时按此估算 */
const REGISTRY_DEFAULT_MAX_TOKENS = 8192;
/**
 * 推理开销是**可见输出的倍数**，不是一个常数加项（TR-08）。
 *
 * 原来写的是 `+ 2000`。2026-08-12 跑批把真实行为读出来了：medium 及以上档位，
 * 模型会先在思考块里把整章逐段译一遍，然后才开始正式输出——
 *
 * | 尝试         | 本批要求 | 思考里译到 | 正式输出 |
 * |--------------|---------|-----------|---------|
 * | ch002 · max  | 95 段   | **95 段** | **0**   |
 * | ch002 · high | 95 段   | **95 段** | **0**   |
 * | ch002 · low  | 95 段   | **0 段**  | 95 段   |
 *
 * ch002 的正文只要 7786 token，而思考吃满 16384 还没写完，总需求 ≥ 24000。
 * 拿一个 2000 的常数去估它，偏小八倍以上，于是发车前的闸门判定「装得下」，
 * 把注定撞墙的整章请求发了出去——四次尝试，一个字正文都没拿到。
 *
 * 判据与 OpenAI 推理模型指南一致：推理 token 计入 `max_output_tokens`，
 * 官方建议「reserve at least 25,000 tokens for reasoning and outputs」，
 * 且预算在推理阶段耗尽时返回 incomplete 且**没有可见输出**——与实测逐字吻合。
 *
 * 打不打草稿是个**二元开关**，不是连续的量：low 及以下一段不打，medium 起全打。
 * 所以这里是两档常数，不是一条平滑曲线——照实际观测建模，不做假的精细。
 */
const REASONING_MULTIPLIER_DRAFTING = 4;
const REASONING_MULTIPLIER_DIRECT = 1.3;
/** 会先打草稿的档位（实测分界在 low 与 medium 之间） */
const DRAFTING_THINKING = new Set(["medium", "high", "xhigh", "max"]);
/** 译文 token 估算：源字符数 / 1.5（日→中会缩短，取保守系数） */
const OUTPUT_CHARS_PER_TOKEN = 1.5;
/** 输出预算安全系数：只用 maxTokens 的 80%，余量留给 wire 标签与波动 */
const OUTPUT_BUDGET_RATIO = 0.8;
/** 输入侧安全系数：ctxWindow 只做输入上限校验 */
const INPUT_BUDGET_RATIO = 0.8;

/** 这个档位下推理要花掉可见输出的几倍。缺省按最坏情况（会打草稿） */
function reasoningMultiplier(thinking?: string): number {
  if (thinking === undefined) return REASONING_MULTIPLIER_DRAFTING;
  return DRAFTING_THINKING.has(thinking) ? REASONING_MULTIPLIER_DRAFTING : REASONING_MULTIPLIER_DIRECT;
}

/**
 * 整章单发所需的输出 token 估算（可见译文 × 推理倍数）。
 *
 * 不传档位时按**最坏情况**估：宁可多分一批，也别把请求发出去等着一个字都拿不到。
 */
export function estimateOutputTokens(srcChars: number, thinking?: string): number {
  const visible = Math.ceil(srcChars / OUTPUT_CHARS_PER_TOKEN);
  return Math.ceil(visible * reasoningMultiplier(thinking));
}

/** 输出预算是否装不下整章 —— 装不下就分批，而不是发出去等截断 */
export function needsBatchTranslation(srcChars: number, maxTokens: number, thinking?: string): boolean {
  return estimateOutputTokens(srcChars, thinking) > maxTokens * OUTPUT_BUDGET_RATIO;
}

/** 输出预算折算成单批安全源字符数 */
function batchCharsForBudget(maxTokens: number, thinking?: string): number {
  const usable = (maxTokens * OUTPUT_BUDGET_RATIO) / reasoningMultiplier(thinking);
  return Math.max(500, Math.floor(usable * OUTPUT_CHARS_PER_TOKEN));
}

/**
 * 模型输出上限的**唯一实现**在 `cli-pipeline.configuredMaxTokens`（PipelineConfig 在那里声明）。
 * 这里曾有一份私有副本，agent 写死 translator——于是 preferenceCompiler 这类同样发 LLM
 * 调用的环节永远读不到自己的 maxTokens。那边的注释当年就写着该引用它，只是没人执行。
 */

/** 从被砍断的输出里捞回来的东西 */
export interface SalvageResult {
  /** 已完整到达、id 在预期内、按预期顺序排好的段落 */
  kept: ParagraphBlock[];
  /** 还缺的 id（按原顺序） */
  missing: string[];
}

/**
 * 输出被砍断时保住已经完整到达的段落，只把缺的报出来（TR-05）。
 *
 * 2026-08-12 实测的那次砍断长这样：
 *
 *     <paragraph id="p0088">…完整的一段译文…</paragraph><paragraph id="p0089
 *
 * p0088 完好无损地到了，然后被整章重跑扔掉。ch003 那 380 秒就是这么烧的——
 * 三次从零开始，每次把整份预算重烧一遍。段落门禁协议恰好给了**精确无损**的
 * 续接边界：已闭合的留下，没闭合的重发。
 *
 * 三条收取判据，每条都在挡一种「比没有更糟」的产物：
 *
 * - **只收闭合的**。`parseParagraphsXml` 会把最后那个没闭合的残段丢掉，
 *   半句译文若被当成完整段落，会以「已翻译」的身份混进正文。
 * - **只收 expectedIds 里的**。模型编出来的段落 id 不能进正文。
 * - **空正文算没到**。空译文同样会在正文里留个洞，而状态上却是「已翻译」——
 *   RV-01 修的就是这一类假零。
 */
export function salvageTruncated(raw: string, expectedIds: string[]): SalvageResult {
  const expected = new Set(expectedIds);
  const byId = new Map<string, ParagraphBlock>();
  for (const p of parseParagraphsXml(raw).paragraphs) {
    if (!expected.has(p.id) || !p.text.trim()) continue;
    // 同一 id 出现两次只认第一次：后一次通常是模型自我修正的重写，
    // 但我们无从判断哪个更好，取先到的才是可复现的规则。
    if (!byId.has(p.id)) byId.set(p.id, p);
  }
  const kept: ParagraphBlock[] = [];
  const missing: string[] = [];
  // 按 expectedIds 的顺序排，而不是按到达顺序——顺序是正文的正确性，不是风格
  for (const id of expectedIds) {
    const hit = byId.get(id);
    if (hit) kept.push(hit);
    else missing.push(id);
  }
  return { kept, missing };
}

/**
 * 输出是否被截断。判据按可信度排序（TR-12）：
 *
 * 1. **服务商的原始状态**（`incomplete` 入参）。它明说了「没正常结束」，不用猜。
 * 2. 段落开标签多于闭标签（停在半个段落上）。
 * 3. 返回段落数显著少于预期（<80%）。
 *
 * 只靠 2/3 有一个真实的盲区：截断恰好落在段落边界、且已到段落 ≥80% 时
 * 两条都不触发——而这是最常见的截断形态，它会被误判成「格式问题」走整章重译，
 * 把已经到手的段落全部扔掉。截断后原样重发必然再次截断——
 * 但**不是**只能从零重来：见 {@link salvageTruncated}。
 */
export function looksTruncated(raw: string, expectedIds: string[], incomplete?: boolean): boolean {
  const text = raw.trimEnd();
  if (text.length === 0) return false;
  if (incomplete) return true;
  const opens = (text.match(/<paragraph\b/gi) ?? []).length;
  const closes = (text.match(/<\/paragraph>/gi) ?? []).length;
  if (opens > closes) return true;
  return closes < Math.ceil(expectedIds.length * 0.8);
}

// ===== system 组装（单发 / 分批 / 局部修订唯一真相） =====

export interface TranslatorPrefixInput {
  /** revise=局部修订模式（角色声明与输出规则不同，缓存前缀自然分组） */
  mode?: "translate" | "revise";
  guide: string;
  outputRule: string;
  /** 作者提供的目标语风格参照（R2-3）；空则前缀与无此字段时逐字节相同 */
  styleAnchor?: string;
}

export interface TranslatorSystemInput extends TranslatorPrefixInput {
  /** 累积词表注入块（EX-05：全表、发现顺序追加、永不重排） */
  termBlock: string;
  /** 作者偏好（可变段，含【作者偏好】标题） */
  prefBlock?: string;
  /** 本章双关档案（可变段，已按章过滤） */
  punBlock?: string;
}

/**
 * system 的静态前缀 —— 同一本书的所有章节 byte-identical，
 * 前缀缓存的命中边界终止于此。任何章节相关内容都不得进入这里。
 */
export function buildTranslatorStaticPrefix(input: TranslatorPrefixInput): string {
  // 引号风格不在这里约束：它是 L0 确定性映射（post-transform.applyQuoteStyle），
  // 写进 prompt 只是花全价买不确定性（R0-1）。
  const role = input.mode === "revise" ? "你是轻小译的译官（局部修订模式）" : "你是轻小译的译官";
  // 风格参照紧跟指南：两者说的是同一件事（怎么写），放在一起模型不必跨段拼。
  // 「不得抄用其内容」这句不能省——参照文本是别人的作品，产品不内置任何语料，
  // 作者贴进来的东西也只作语感样本用。
  const anchor = buildStyleAnchor(input.styleAnchor);
  const anchorBlock = anchor.text ? `\n【风格参照】以下为目标文体示例，模仿其语感与节奏，不得抄用其内容：\n${anchor.text}` : "";
  // prompt 里**没有**术语登记的格式指令：判据在工具 description 里，形状由 schema 保证（KA-5）。
  // THINKING_SCOPE_RULE 留下——它约束的是翻译本身的思考用法，与提取通道无关。
  return `${role}。翻译为中文。\n${input.guide}${anchorBlock}\n${input.outputRule}\n${THINKING_SCOPE_RULE}\n${exampleBlock()}`;
}

/**
 * system = 静态前缀 + 累积词表 + 章节可变段（作者偏好 → 双关档案）。
 *
 * EX-05：术语块紧跟静态前缀，内容是**累积词表全表、发现顺序追加**。
 * 它对同一本书的每一章都相同，因此天然落在前缀缓存边界之内；真正随章变化的
 * 只有后面的作者偏好与本章双关档案。
 */
export function buildTranslatorSystem(input: TranslatorSystemInput): string {
  const parts = [buildTranslatorStaticPrefix(input)];
  parts.push(`术语表:\n${input.termBlock || "（无）"}`);
  if (input.prefBlock) parts.push(input.prefBlock);
  if (input.punBlock) parts.push(input.punBlock);
  return parts.join("\n");
}

/**
 * 本章双关档案块（PL-16：全书档案按 ja 反查原文过滤，与术语索引同一机制）。
 *
 * 译注留空 = 这个梗不需要译注，只要译法统一。从前无论留没留空都写
 * `紧跟（译注: ${note ?? ""}）`——留空时那是在要求模型往正文里印一对空括号。
 */
export function buildChapterPunBlock(
  puns: Array<{ ja: string; zh?: string; note?: string }>,
  src: string
): string {
  const hit = puns.filter((p) => p.ja && src.includes(p.ja));
  if (hit.length === 0) return "";
  const lines = hit
    .map((p) => {
      const note = p.note?.trim();
      return note
        ? `- ${p.ja} → 译「${p.zh ?? "?"}」，紧跟（译注: ${note}）`
        : `- ${p.ja} → 译「${p.zh ?? "?"}」（不加译注）`;
    })
    .join("\n");
  return `【双关档案】以下谐音梗是作者确认过的，遇到时必须译出；标了译注的要在译法之后紧跟（译注: 内容）：\n${lines}`;
}

/**
 * 作者偏好块（BQ-04）：profile 最新才注入；编译失败/过期 → 空串
 * （原文保留，不阻断翻译）。编译是 JSON 抽取任务，档位默认 low（PL-13）。
 */
export async function buildPreferenceBlock(
  ws: Workspace,
  llm: TranslateLlm,
  config: PipelineConfig,
  chapterId: string,
  volume: string | undefined,
  src: string
): Promise<string> {
  const compiler = config.agents.preferenceCompiler;
  const model = compiler?.model ?? config.agents.translator?.model ?? "deepseek/deepseek-v4-pro";
  const thinking = compiler?.thinking ?? "low";
  try {
    const prefLlm = {
      complete: async (sys: string, usr: string) =>
        (
          await llm.complete(
            model,
            [
              { role: "system", content: sys },
              { role: "user", content: usr },
            ],
            { thinking }
          )
        ).text,
    };
    const profile = await preparePreferencesForTranslation(ws, prefLlm);
    if (!profile) return "";
    return preferencesForChapter(profile, chapterId, volume, src);
  } catch {
    return "";
  }
}

/** 门禁失败（含明细与原始输出，供截断判定/受控重译/上报） */
class ParagraphGateFailure extends Error {
  constructor(
    readonly gateErrors: ParagraphWireError[],
    readonly raw = "",
    /** 服务商说这次没正常结束（rawStopReason=incomplete / stopReason=length）。截断判定优先信它 */
    readonly incomplete = false,
  ) {
    super(gateErrors.map((e) => `${e.code}: ${e.message}`).join("；"));
    this.name = "ParagraphGateFailure";
  }
}

// ===== 门禁重试预算与降级阶梯（R0-5） =====

/**
 * 单章门禁重试总预算：整章重译、批内重试、二分子批、逐段单发共用这一个计数器，
 * 每批首次尝试不计费。竞品 AiNiee 的重试灾难（单例一上午 4200 万 token）
 * 来自「每批各自无限重试」，硬顶是唯一可靠的止损点。
 */
const GATE_RETRY_BUDGET = 4;

interface GateRetryBudget {
  left: number;
}

function spendRetry(budget: GateRetryBudget): boolean {
  if (budget.left <= 0) return false;
  budget.left -= 1;
  return true;
}

function budgetExhausted(cause: ParagraphGateFailure): Error {
  return new Error(`重试预算耗尽（章级门禁重试上限 ${GATE_RETRY_BUDGET} 次）：${cause.message}`);
}

/**
 * 工具通道的两轮循环（KA-4）。
 *
 * ```
 * 轮1  原文 + 累积词表 + register_terms 工具
 *      └─ 模型思考（实测：它本来就在思考里把整章草译一遍）→ 调用工具 → 让出
 *            stopReason = toolUse
 *      [ L0 补救层作为工具的执行体 ]
 * 轮2  回灌 continuation（含推理签名）+ toolResult（含被拒的词及原因）
 *      └─ 产出 <paragraph> 正文
 * ```
 *
 * 为什么第二轮几乎不花钱：推理**跨轮保留**（DeepSeek 强制回灌 reasoning 本身就是
 * 证明）。KA-1 真机实测推理 1118 → 4，输入 cacheRead 2432 / 新增 109。
 * 「模型在思考里草译整章」这个已观测行为，从浪费变成了资产。
 *
 * 轮次硬上限 2：工具结果只回一次。给模型「再报一批词」的机会会让一章烧三轮以上，
 * 而 EX-10 证明单次调用就足以覆盖全章术语（32 词）。
 *
 * 模型直接吐正文、不调工具时**不是错误**：这一章就是没有新词，照常走门禁。
 */
async function runToolTurns(
  llm: TranslateLlm,
  call: { model: string; thinking: string; maxTokens?: number },
  system: string,
  user: string,
  toolSink: ToolSink
): Promise<{ text: string; stopReason?: string; rawStopReason?: string }> {
  const opts = {
    thinking: call.thinking,
    ...(call.maxTokens === undefined ? {} : { maxTokens: call.maxTokens }),
    tools: [REGISTER_TERMS_TOOL],
  };
  const first = await llm.complete(
    call.model,
    [{ role: "system", content: system }, { role: "user", content: user }],
    opts
  );
  const registerCall = first.toolCalls?.find((c) => c.name === REGISTER_TERMS_TOOL.name);
  // 没调工具就直接给了正文 → 本章无新词，一轮结束。多发一轮只是白花钱。
  if (!registerCall) return first;

  // 工具的执行体就是补救层。判定结果**回到模型眼前**——这是整个改动的意义所在：
  // 此前模型永远不知道自己报的词被拒了，于是被拒的译法照样出现在正文里。
  const validated = toolSink.execute(registerCall.arguments);

  const second = await llm.complete(
    call.model,
    [
      { role: "system", content: system },
      { role: "user", content: user },
      // 原始 assistant 消息原样回灌：推理签名在 thinkingSignature 里，拆开就丢
      { role: "assistant", content: "", continuation: first.continuation },
      { role: "toolResult", content: validated.text, toolCallId: registerCall.id, toolName: registerCall.name },
    ],
    opts
  );
  return second;
}

/** 工具执行体的注入面：把 L0 判定与结果落库留在调用点，两轮循环本身不认识术语仓库 */
interface ToolSink {
  execute: (args: Record<string, unknown>) => { text: string };
}

/** 单次 LLM 调用 + 门禁判定（失败抛 ParagraphGateFailure） */
async function translateWithGate(
  llm: TranslateLlm,
  call: { model: string; thinking: string; maxTokens?: number },
  system: string,
  user: string,
  expectedIds: string[],
  /** 工具通道的执行体（KA-4）。术语登记的 L0 判定经 toolResult 回灌给模型 */
  toolSink: ToolSink
): Promise<ParagraphBlock[]> {
  const res = await runToolTurns(llm, call, system, user, toolSink);
  if (!res.text.trim()) throw new Error(`翻译结果为空（模型未返回译文）`);
  // 响应里只有译文：术语走工具参数，不再有需要先摘掉的尾块（KA-5）。
  const gate = gateTranslationOutput(res.text, expectedIds);
  if (gate.ok) return gate.paragraphs;
  // 服务商已经说了这次有没有正常结束——门禁失败时把这个事实带上，
  // 截断判定先信它，数标签只是没有它时的退路（TR-12）。
  const incomplete = res.rawStopReason === "incomplete" || res.stopReason === "length";
  throw new ParagraphGateFailure(gate.errors, res.text, incomplete);
}

// ===== 分批单元 =====

/** 分批最小单元：正常段落 1:1；超长段落按句末安全切成多个单元（PL-01） */
interface TranslationUnit {
  /** wire id（超长段的切片带 s{n} 后缀） */
  id: string;
  type: ParagraphType;
  text: string;
  /** 所属源段落 id */
  baseId: string;
}

/** 段落 → 单元：超长单段借 core/batch 的分句安全切分，绝不切在句子中间 */
function toTranslationUnits(paragraphs: ParagraphBlock[], batchChars: number): TranslationUnit[] {
  const units: TranslationUnit[] = [];
  for (const p of paragraphs) {
    if (p.text.length <= batchChars) {
      units.push({ id: p.id, type: p.type, text: p.text, baseId: p.id });
      continue;
    }
    const pieces = batchBlocks(
      [{ text: p.text, startOffset: 0, endsWithSeparator: false, estTokens: Math.ceil(p.text.length / 2) }],
      batchChars
    );
    pieces.forEach((piece, i) => {
      units.push({
        id: `${p.id}s${i + 1}`,
        type: p.type,
        text: piece.blocks.map((b) => b.text).join(""),
        baseId: p.id,
      });
    });
  }
  return units;
}

/** 单元按 batchChars 分组成批（单元自身已 ≤ batchChars） */
function groupUnitsIntoBatches(units: TranslationUnit[], batchChars: number): TranslationUnit[][] {
  const batches: TranslationUnit[][] = [];
  let current: TranslationUnit[] = [];
  let currentChars = 0;
  for (const u of units) {
    if (currentChars + u.text.length > batchChars && current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(u);
    currentChars += u.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 单元译文合回源段落（切片按顺序拼接，段内无分隔） */
function mergeUnitsIntoParagraphs(
  source: ParagraphBlock[],
  units: TranslationUnit[],
  translated: ParagraphBlock[]
): ParagraphBlock[] {
  const textById = new Map(translated.map((p) => [p.id, p.text]));
  const byBase = new Map<string, TranslationUnit[]>();
  for (const u of units) {
    const list = byBase.get(u.baseId);
    if (list) list.push(u);
    else byBase.set(u.baseId, [u]);
  }
  return source.map((sp) => ({
    id: sp.id,
    type: sp.type,
    text: (byBase.get(sp.id) ?? []).map((u) => textById.get(u.id) ?? "").join(""),
  }));
}

interface BatchLadderContext {
  llm: TranslateLlm;
  call: { model: string; thinking: string; maxTokens?: number };
  system: string;
  budget: GateRetryBudget;
  /** 按单元子集组装 user；gateNote 非空时附上次门禁明细 */
  buildUser: (units: TranslationUnit[], gateNote?: string) => string;
  /** 工具通道执行体（KA-4）。分批时每一批都各走一次两轮循环 */
  toolSink: ToolSink;
}

/**
 * 单批门禁降级阶梯（R0-5）：整批带明细重试一次 → 二分子批 → 递归到逐段单发。
 * 首次尝试之外的每次调用都从章级预算扣减，预算见底立即停手；
 * 递归到单段仍连败则点名坏段，让 stuck 上报能定位到具体段落。
 */
async function translateUnitsWithLadder(
  ctx: BatchLadderContext,
  units: TranslationUnit[]
): Promise<ParagraphBlock[]> {
  const attempt = (list: TranslationUnit[], gateNote?: string) =>
    translateWithGate(
      ctx.llm,
      ctx.call,
      ctx.system,
      ctx.buildUser(list, gateNote),
      list.map((u) => u.id),
      ctx.toolSink,
    );

  const ids = units.map((u) => u.id);

  /**
   * 截断兜底（TR-09）：保住已完整闭合的段落，只把缺的重发。
   *
   * TR-05 只补了单发路径。这条分批路径原来是「原样重发整批 → 再二分」，
   * 每一步都把已经到手的段落扔掉重译——与修好之前的单发路径是同一个浪费。
   * maxTokens 拉到官方上限之后单发是常态、分批是兜底，兜底那条路自己漏着
   * 等于没有兜底。
   *
   * 只治截断：门禁因为格式/数量不符而失败时仍走原来的重译与二分阶梯，
   * 因为那时候「已到达的段落」本身就不可信。
   */
  const continueTruncated = async (failed: ParagraphGateFailure): Promise<ParagraphBlock[] | undefined> => {
    if (!looksTruncated(failed.raw, ids, failed.incomplete)) return undefined;
    const { kept, missing } = salvageTruncated(failed.raw, ids);
    if (kept.length === 0 || missing.length === 0) return undefined;
    if (!spendRetry(ctx.budget)) throw budgetExhausted(failed);
    const missingSet = new Set(missing);
    const rest = await translateUnitsWithLadder(ctx, units.filter((u) => missingSet.has(u.id)));
    const merged = new Map([...kept, ...rest].map((p) => [p.id, p]));
    // 按本批的原始顺序排：顺序是正文的正确性，不是风格
    return ids.map((id) => merged.get(id)).filter((p): p is ParagraphBlock => p !== undefined);
  };

  /**
   * 未正常结束且**一个字正文都没有**（TR-12）：思考把本批的输出预算整个吃光。
   * 整批原样重发只会原样再撞（同样的输入引出同样的草稿），降档是运行时已经
   * 退役的老路——对半切，让每一半的思考需求跟着输出需求一起变小。
   * 单个单元还撞 = 一段就吃光预算，切无可切，如实上抛。
   */
  const splitIncomplete = async (cause: unknown): Promise<ParagraphBlock[]> => {
    if (units.length < 2) throw cause;
    const mid = Math.ceil(units.length / 2);
    const out: ParagraphBlock[] = [];
    for (const half of [units.slice(0, mid), units.slice(mid)]) {
      if (!spendRetry(ctx.budget)) throw cause;
      out.push(...(await translateUnitsWithLadder(ctx, half)));
    }
    return out;
  };

  let failure: ParagraphGateFailure;
  try {
    return await attempt(units);
  } catch (e) {
    if (isIncompleteNoText(e)) return splitIncomplete(e);
    if (!(e instanceof ParagraphGateFailure)) throw e;
    failure = e;
  }

  const continued = await continueTruncated(failure);
  if (continued) return continued;

  if (!spendRetry(ctx.budget)) throw budgetExhausted(failure);
  try {
    return await attempt(units, failure.message);
  } catch (e) {
    if (isIncompleteNoText(e)) return splitIncomplete(e);
    if (!(e instanceof ParagraphGateFailure)) throw e;
    failure = e;
  }

  if (units.length < 2) {
    throw new Error(`段落 ${units[0]!.id} 连续两次未通过段落门禁：${failure.message}`);
  }
  const mid = Math.ceil(units.length / 2);
  const out: ParagraphBlock[] = [];
  for (const half of [units.slice(0, mid), units.slice(mid)]) {
    if (!spendRetry(ctx.budget)) throw budgetExhausted(failure);
    out.push(...(await translateUnitsWithLadder(ctx, half)));
  }
  return out;
}



export async function translateChapterToFile(
  ws: Workspace,
  chapterId: string,
  llm: TranslateLlm,
  config: PipelineConfig,
  /** 重译要求（审校/Manager 反馈的详细问题清单）——重译时注入 user */
  retryNote?: string,
  /** 模型覆盖（Manager reroute_translator 用；缺省用 config） */
  modelOverride?: string,
  /**
   * 降级告警通道（EX-04 收尾）。融合提取的幻觉丢弃、尾块解析失败、登记词落盘失败
   * 此前只写 console.warn——那等于对作者不可见。译文照常交付，但**少了什么必须说出来**。
   */
  onWarn?: (message: string) => void,
): Promise<TranslateOneResult> {
  // 没接告警通道时退回 console.warn：库用法与 CLI 仍看得到，不至于彻底静默
  const warn = (message: string): void => { if (onWarn) onWarn(message); else console.warn(message); };
  const resolved = await resolveChapter(ws, chapterId);
  const meta = resolved.entry;

  // 原文和作者修订都由 canonical chapter catalog 定位。
  let src = await readFile(resolved.paths.source, "utf-8");
  const corrPath = resolved.paths.correction;
  if (existsSync(corrPath)) {
    try {
      const corr = JSON.parse(await readFile(corrPath, "utf-8")) as { source?: string };
      if (typeof corr.source === "string" && corr.source.trim().length > 0) src = corr.source;
    } catch {
      // 修正文件损坏 → 用原始原文
    }
  }

  // canonical 源段落（BQ-01）：空行/LF 规范化 + 稳定 id；wire 传输用段落 XML
  const sourceParas = buildParagraphs(src);

  // Canonical terminology snapshot；legacy JSON is only a projection.
  const terminology = await new TerminologyRepository(ws.root).readSnapshot();
  const dicts = readDictionaries(terminology.archives);

  // R1-2 译前规整只改发出去的 wire：段落 id 与切段结构仍由存储源文决定，
  // 落盘合并也以存储源文为准——规整若渗进存储，门禁比对的两侧就不是同一份东西了。
  const wireParas = dicts.preDict.length
    ? sourceParas.map((p) => ({ ...p, text: applyPreTransforms(p.text, dicts.preDict) }))
    : sourceParas;
  const srcWire = paragraphsToXml(wireParas);
  const allTerms: Array<{ ja: string; zh: string; type: string }> = [
    ...terminology.archives.names,
    ...terminology.archives.terms,
  ] as Array<{ ja: string; zh: string; type: string }>;

  // 术语注入：**累积词表，发现顺序追加，永不重排**（EX-05）。
  //
  // 融合提取之后表是活的——每翻一章就长几行。逐章子集（原 subset 模式）在这种表上
  // 是反效果：每章注入的行集合都不一样，前缀缓存章章落空，省下的那几百 token
  // 远抵不过全价重付。追加序则让第 N 章的注入块以第 N-1 章的为**字节级前缀**，
  // 缓存一路命中；改名会让前缀失效一次，但改名是低频动作。
  //
  // 原 frozen 模式（把快照钉进静态前缀）随之退役：它的前提是「表在翻译期间不变」，
  // 而融合提取正是要让表边翻边长。追加序给出的是同一个收益，且不需要「重钉」这个概念。
  const personas = resolvePersonas(terminology.archives);
  // R2-2 人设合流：角色的译法与说话方式合成同一行注入，模型不必自己把两张表对上号
  const injectTerms: Array<{ ja: string; zh: string; type?: string }> = allTerms;

  // EX-08 / D4：全书概览、本章摘要、前后章窗口在这里退役。
  //
  // 它们全部来自阅读轮写的 `state/book-understanding.json`，而阅读轮随译前提取链一起
  // 退役了——这个文件不再有人写。更根本的是作者的判断：全书梗概对译文质量没有帮助，
  // 它占着每章不可压缩的输入预算，换来的是一段与本章正文无关的转述。
  // 需要的连续性由累积词表（逐章增长、追加序）承担。

  // puns 档案（防御清洗：旧数据可能是建议句）→ 按本章原文过滤
  const { cleanZhHint } = await import("./pun-detect.ts");
  const puns = (terminology.archives.puns as Array<{ ja: string; zh?: string; note?: string }>).map((p) => ({
    ...p,
    zh: cleanZhHint(p.zh),
  }));

  // 截断必须上报：作者贴了 5000 字进去、实际只有前 2000 token 生效，界面上一声不吭
  // 就是另一种形式的撒谎（RH-19 的同一条纪律）。
  const anchor = buildStyleAnchor(config.translation.styleAnchor);
  if (anchor.truncated) {
    console.warn(`[Translator] 风格参照超出 ${STYLE_ANCHOR_MAX_TOKENS} token 上限，已按段落边界截断至 ${anchor.tokens} token`);
  }
  const system = buildTranslatorSystem({
    guide: config.translation.guide ?? DEFAULT_GUIDE,
    outputRule: PARAGRAPH_OUTPUT_RULE,
    ...(config.translation.styleAnchor ? { styleAnchor: config.translation.styleAnchor } : {}),
    termBlock: [
      // 追加序：仓库档案序即发现顺序，这里一个字都不排序（排一次就毁一次前缀缓存）
      injectTerms.map((t) => renderTermLine(t, personas)).join("\n"),
      // R1-3 禁翻词按本章原文过滤后并入同一段术语注入（恒等映射），与双关档案同一机制
      buildNoTranslateLines(dicts.noTranslate, src),
    ].filter(Boolean).join("\n"),
    prefBlock: await buildPreferenceBlock(ws, llm, config, chapterId, meta.volume, src),
    punBlock: buildChapterPunBlock(puns, src),
  });

  // user 全部是章节可变段：重译要求 → 原文（EX-08 起不再有概要与摘要前缀）
  const user = `${
    retryNote ? `【重译要求】以下为审校/Manager 反馈的问题，请针对性修正后重新输出全文：\n${retryNote}\n\n` : ""
  }【原文】（逐段翻译，保持 <paragraph> id 一致）\n${srcWire}`;

  const maxTokens = configuredMaxTokens(config, "translator");
  const call = {
    model: modelOverride ?? config.agents.translator?.model ?? "deepseek/deepseek-v4-pro",
    thinking: config.agents.translator?.thinking ?? "high",
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
  const budgetTokens = maxTokens ?? REGISTRY_DEFAULT_MAX_TOKENS;
  // 输出预算决定是否分批；ctxWindow 只做输入侧上限校验。
  const overOutputBudget = needsBatchTranslation(src.length, budgetTokens, call.thinking);
  const ctxWindow = config.translation.contextWindow ?? 131072;
  const overInputWindow = estTokensJa(system) + estTokensJa(user) > ctxWindow * INPUT_BUDGET_RATIO;

  const batchChars = Math.min(config.translation.batchChars ?? 2000, batchCharsForBudget(budgetTokens, call.thinking));
  // 章级重试预算：单发重试与分批内的全部降级共用（R0-5）
  const budget: GateRetryBudget = { left: GATE_RETRY_BUDGET };

  // ===== 工具通道的执行体（KA-4）=====
  //
  // 补救层在这里从「事后校验」变成「工具的执行体」：判定结果经 toolResult 回到模型
  // 眼前，第二轮的正文因此不会再用被拒的译法。执行体建在调用点而不是循环里——
  // 两轮循环本身不该认识术语仓库，它只管「几轮」。
  const toolKnown = new Set(allTerms.map((term) => term.ja));
  const toolTerms: FusedTerm[] = [];
  const toolVoices: RegisteredVoice[] = [];
  const toolDropped: Array<{ ja: string; reason: string }> = [];
  /** 登记动作发生过几次。整章一次都没有 = 模型没照做（哑火判据，见下方告警） */
  let registerCalls = 0;
  const toolSink = {
    execute: (args: Record<string, unknown>) => {
      registerCalls += 1;
      const result = validateRegisteredTerms(args, { source: src, known: toolKnown });
      for (const term of result.terms) {
        // 跨批去重：一章分多批时同一个词可能在两批里各登记一次
        if (toolKnown.has(term.ja)) continue;
        toolKnown.add(term.ja);
        toolTerms.push(term);
      }
      toolVoices.push(...result.voices);
      toolDropped.push(...result.dropped);
      if (result.failureReason) warn(`${chapterId}：${result.failureReason}`);
      return { text: renderToolResult(result) };
    },
  };
  const runBatches = (only?: ParagraphBlock[]) =>
    translateInBatches({
      ws,
      chapterId,
      // 分批路径与单发路径吃同一份规整后文本，否则同一章会因为走没走分批而译出两种源文
      sourceParas: only ?? wireParas,
      system,
      batchChars,
      llm,
      call,
      budget,
      toolSink,
      // 只补缺口时不写 checkpoint：checkpoint 是按「整章分批」的批次序号存的，
      // 拿一份缺口批次去覆盖它，续跑时会把整章的进度算错。
      ...(only ? { checkpoint: false } : {}),
    });

  const expectedIds = sourceParas.map((p) => p.id);
  let gateParas: ParagraphBlock[];
  if (overOutputBudget || overInputWindow) {
    gateParas = await runBatches();
  } else {
    try {
      gateParas = await translateWithGate(llm, call, system, user, expectedIds, toolSink);
    } catch (e) {
      if (isIncompleteNoText(e)) {
        // 未正常结束且无正文（TR-12）：思考吃光了整章的输出预算。原样重发只会
        // 原样再撞，降档是把用户选的档位偷偷换掉——切批才是对的退路：
        // 每批的可见输出小了，同档位下打草稿的量也跟着小（实测与本批规模成正比）。
        gateParas = await runBatches();
      } else if (!(e instanceof ParagraphGateFailure)) {
        throw e;
      } else if (looksTruncated(e.raw, expectedIds, e.incomplete)) {
        // 截断（TR-05）：原样重发必然再次截断，但**不必从零重来**。
        // 已完整闭合的段落是已经付过钱、而且合格的产物；扔掉它们重跑整章，
        // 正是 2026-08-12 那 380 秒的来源。段落协议给了精确无损的续接边界。
        const salvage = salvageTruncated(e.raw, expectedIds);
        if (salvage.kept.length === 0) {
          gateParas = await runBatches();
        } else {
          const missing = new Set(salvage.missing);
          const rest = await runBatches(wireParas.filter((p) => missing.has(p.id)));
          // 合并后按预期顺序排：顺序是正文的正确性，不是风格
          const merged = new Map([...salvage.kept, ...rest].map((p) => [p.id, p]));
          gateParas = expectedIds.map((id) => merged.get(id)).filter((p): p is ParagraphBlock => p !== undefined);
        }
      } else {
        // 受控重译一次（带门禁明细提醒），计入章级重试预算
        if (!spendRetry(budget)) throw budgetExhausted(e);
        const retryUser = `${user}\n\n【上次输出未通过段落校验】${e.message}\n请严格按 <paragraph> 结构重新输出全部段落（id/顺序/数量与原文一致）。`;
        gateParas = await translateWithGate(llm, call, system, retryUser, expectedIds, toolSink);
      }
    }
  }

  // L0 译后管线（R0-1 引号 → R1-1 译后字典）：落盘与【待审:】收割前统一处理，
  // 单发与分批共用这一个出口
  const quoteStyle = config.translation.quoteStyle ?? "zh";
  const styledParas = gateParas.map((p) => ({
    ...p,
    text: applyPostTransforms(p.text, { quoteStyle, postDict: dicts.postDict }),
  }));

  // R3-2 人改保护：作者手改过的段落保留原译文。v1 不改 wire——模型仍然翻了这些段，
  // 只是结果不落盘。从 wire 里剔除人改段能省 token，但会让上下文出现空洞，
  // 相邻段的语气衔接会跟着变差，收益不明；留待有实测再评估。
  const previous = await readChapterParagraphs(ws, chapterId);
  const humanById = new Map(
    (previous?.paragraphs ?? []).filter((p) => p.translatedBy === "human").map((p) => [p.id, p])
  );
  let preservedHumanParagraphs = 0;
  const merged: ChapterParagraph[] = sourceParas.map((sp, i) => {
    const human = humanById.get(sp.id);
    if (human) {
      preservedHumanParagraphs += 1;
      return { id: sp.id, type: sp.type, source: sp.text, translation: human.translation, translatedBy: "human" as const };
    }
    return { id: sp.id, type: sp.type, source: sp.text, translation: styledParas[i]?.text ?? "", translatedBy: "model" as const };
  });
  if (preservedHumanParagraphs > 0) {
    warn(`${chapterId}：${preservedHumanParagraphs} 个作者手改段落未被本次重译覆盖`);
  }
  // 权威段落 JSON + Markdown 投影（BQ-02：通过门禁才落盘）
  await writeChapterParagraphs(ws, chapterId, merged, { staging: config.translation.staging });
  const translation = paragraphsToText(styledParas);

  // 译者在通读语境时发现的新专名，预扫描按统计特征挑候选时读不出来。收割失败不影响译文，
  // 因此不阻断——但也不静默丢弃，落盘后可在确认队列里看到。
  let pendingTerms: PendingTerm[] = [];
  try {
    const known = new Set(allTerms.map((term) => term.ja));
    // 两条来源：模型主动标的【待审:】，以及代码从译文残留反推的（R4-2）。
    // 后者才是主力——实测模型在 6 个术语表外角色名出现 53 次的情况下写出 0 个标记。
    const leaked = collectLeakedTerms(
      merged.map((p) => ({ source: p.source, translation: p.translation })),
      dicts.noTranslate,
      chapterId
    );
    pendingTerms = await recordPendingTerms(ws, [...extractPendingTerms(translation, chapterId), ...leaked], known);
  } catch {
    pendingTerms = [];
  }
  // 融合提取的产出（KA-4/KA-5）：已在工具执行体里过完补救层并跨批去重，这里只汇总。
  // 补救层（原文逐字校验 + 累积词表去重）在 core/extract-fuse 的 validateTermObjects。
  const newTerms: FusedTerm[] = toolTerms;
  const droppedAll: Array<{ ja: string; reason: string }> = [...toolDropped];
  const hallucinationWarning = describeDropped(droppedAll as never, chapterId);
  if (hallucinationWarning) warn(hallucinationWarning);

  // EX-03 P2：「产出明显偏少」。实测有过一次调用烧掉 8189 输出 token 只回 1 个词，
  // 而其余章是 12–20 个。这类哑火在产出上与「本章确实没有新词」完全一样，
  // 不检出就永远不会被发现——作者只会在几十章之后奇怪词表怎么这么薄。
  //
  // 判据只用**指令有没有被执行**，不猜词该有几个：每章都要求有一次登记动作
  // （没有新词就回空 terms）。整章一次都没有 = 模型没照做，这是确定性事实。
  if (registerCalls === 0 && src.length >= MIN_CHARS_FOR_TERMS_EXPECTED) {
    warn(`${chapterId}：本章 ${src.length} 字，模型一次 register_terms 都没调用（应至少回空 terms）——本章提取增量为零，可能是哑火而不是真的没有新词`);
  }

  // 登记即注入（ADR-0008 / TP-2）：带译法的非双关词直写档案（provenance=model），
  // 下一章开工重读快照时立即进注入块——不再等作者确认。12 章实测证明等确认的结局
  // 是档案空转（87 卡悬置、注入块全程「（无）」、59% 登记为重复推导）。
  // 落档失败不阻断译文，但**必须出声**：静默失败就是注入块空转的重演。
  if (newTerms.length > 0) {
    try {
      const { notes } = await archiveRegisteredTerms(ws.root, chapterId, newTerms);
      // TP-3 晋升前置包含检查：包含关系在入档时就出声，不等几十章后改名才发现
      for (const note of notes) warn(`${chapterId}：${note}`);
    } catch (error) {
      warn(`${chapterId}：登记词落档失败，本章暂定词条未进注入块：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // 卡片队列只收**进不了档案**的词：双关（策略归作者裁量）与无译法的词。
  // 已落档的词不再建卡——它们的终审面是档案本身（provenance=model 的词条清单），
  // 同一个词又在档案又在卡片，两处状态迟早打架。
  const cardOnlyTerms = newTerms.filter((term) => term.type === "pun" || !term.zh);
  if (cardOnlyTerms.length > 0) {
    try {
      const recorded = await recordPendingTerms(
        ws,
        cardOnlyTerms.map((term) => ({
          ja: term.ja,
          zh: term.zh,
          type: term.type,
          // 模型写的那句说明是**梗的意思**，它最终会逐字印进正文的（译注: …）。
          // 从前它被写进 context（首现上下文），note 另编一句「译者在 ch001 …登记的新术语」——
          // 于是档案里的译注是一句关于软件自己的话，下一章照着它往正文里印。
          ...(term.note ? { note: term.note } : {}),
          context: firstOccurrence(src, term.ja),
          chapterId,
        })),
        new Set(allTerms.map((term) => term.ja)),
      );
      pendingTerms = [...pendingTerms, ...recorded];
    } catch (error) {
      warn(`${chapterId}：融合登记词落盘失败，本章 ${cardOnlyTerms.length} 个新词未入队：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // KA-6 止血：语气档案的确认卡通道还没重建（EX-07 拆掉旧产线，KA-4 只把词接到了下游），
  // ADR-0008 又明文禁止 voices 自动入档。通道建成前守住两条底线：不丢、出声。
  // 实测教训（2026-08-14 演示工作区）：模型认真填了两份带引证的档案，静默蒸发，零告警。
  if (toolVoices.length > 0) {
    try {
      const kept = await recordPendingVoices(ws, toolVoices, chapterId);
      if (kept.length > 0) {
        warn(`${chapterId}：${kept.length} 份语气档案已暂存 state/pending-voices.json——确认通道未建（KA-6），暂不入档、暂不注入`);
      }
    } catch (error) {
      warn(`${chapterId}：语气档案暂存失败，本章 ${toolVoices.length} 份档案丢失：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { translation, charCount: translation.length, pendingTerms, preservedHumanParagraphs, newTerms, newVoices: toolVoices };
}

interface BatchTranslateInput {
  ws: Workspace;
  chapterId: string;
  sourceParas: ParagraphBlock[];
  /** 与单发路径同一组装结果（一处真相） */
  system: string;
  batchChars: number;
  llm: TranslateLlm;
  call: { model: string; thinking: string; maxTokens?: number };
  /** 章级门禁重试预算（与单发路径共用同一计数器） */
  budget: GateRetryBudget;
  /** 工具通道执行体（KA-4），与单发路径共用同一个——跨批去重靠的就是它 */
  toolSink: ToolSink;
  /**
   * 是否读写分批 checkpoint（默认 true）。
   *
   * 续译缺口时必须关掉（TR-05）：checkpoint 是按「整章分批」的批次序号存的，
   * 拿一份只含缺口的批次去覆盖它，下次续跑会把整章的进度算错——
   * 表现是中间几段凭空消失，而状态上一切正常。
   */
  checkpoint?: boolean;
}

/**
 * 超长章切批翻译（G2）—— 按段落单元切批，逐批独立翻译，
 * 批间注入前批译文尾部 500 字衔接（同一章场景连续）。
 * 批次 checkpoint 落盘（state/batches/{chapterId}.json，原子写）——
 * 失败后重跑从未完成批继续（L2 批内级断点续跑，CONTEXT 决策）。
 */
async function translateInBatches(input: BatchTranslateInput): Promise<ParagraphBlock[]> {
  const { ws, chapterId, sourceParas, system, batchChars, llm, call, budget, toolSink } = input;
  const useCheckpoint = input.checkpoint !== false;
  const units = toTranslationUnits(sourceParas, batchChars);
  const batches = groupUnitsIntoBatches(units, batchChars);
  if (batches.length === 0) throw new Error(`切批失败: ${chapterId} 无有效内容`);

  // checkpoint 路径（新格式 paras: ParagraphBlock[][]；旧纯文本格式不兼容 → 从头）
  const cpDir = join(ws.root, "state", "batches");
  const cpPath = join(cpDir, `${chapterId}.json`);
  let done = 0;
  let paras: ParagraphBlock[][] = [];
  if (useCheckpoint && existsSync(cpPath)) {
    try {
      const cp = JSON.parse(await readFile(cpPath, "utf-8")) as { done: number; paras: ParagraphBlock[][] };
      if (Array.isArray(cp.paras) && Array.isArray(cp.paras[0])) {
        done = cp.done ?? 0;
        paras = cp.paras ?? [];
      }
    } catch {
      // checkpoint 损坏 → 从头开始
      done = 0;
      paras = [];
    }
  }

  // 前批衔接（从 checkpoint 已译部分取尾部）
  const lastPartTail = () => {
    const joined = paras.flat().map((p) => p.text).join("\n\n");
    return joined.length > 500 ? joined.slice(-500) : joined;
  };
  for (let i = done; i < batches.length; i++) {
    const batch = batches[i]!;
    // 二分/逐段单发的子批沿用同一批号与衔接上下文，只换 wire 里的段落集合
    const buildUser = (units: TranslationUnit[], gateNote?: string) => {
      const wire = paragraphsToXml(units.map((u) => ({ id: u.id, type: u.type, text: u.text })));
      const head = i > 0 ? `【前批衔接】前批译文尾部：
${lastPartTail()}

` : "";
      const body = `【第 ${i + 1}/${batches.length} 批】（逐段翻译，保持 <paragraph> id 一致）\n${wire}`;
      const note = gateNote
        ? `\n\n【上次输出未通过段落校验】${gateNote}\n请严格按 <paragraph> 结构重新输出全部段落（id/顺序/数量一致）。`
        : "";
      return `${head}${body}${note}`;
    };
    const gateParas = await translateUnitsWithLadder({ llm, call, system, budget, buildUser, toolSink }, batch);
    paras.push(gateParas);
    // checkpoint（原子写: tmp + rename）。续译缺口时整段跳过——见 BatchTranslateInput.checkpoint
    if (useCheckpoint) {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(cpDir, { recursive: true }));
      const tmp = `${cpPath}.tmp`;
      await writeFile(tmp, JSON.stringify({ done: i + 1, paras }), "utf-8");
      const { rename } = await import("node:fs/promises");
      await rename(tmp, cpPath);
    }
  }

  // 完成：清理 checkpoint。续译缺口时不能删——那是**整章**的进度，不归这次缺口管
  if (useCheckpoint) await import("node:fs/promises").then(({ rm }) => rm(cpPath, { force: true }));
  const all = mergeUnitsIntoParagraphs(sourceParas, units, paras.flat());
  // 全量顺序校验（防批次边界错位）
  const gate = gateTranslationOutput(paragraphsToXml(all), sourceParas.map((p) => p.id));
  if (!gate.ok) throw new ParagraphGateFailure(gate.errors);
  return all;
}
