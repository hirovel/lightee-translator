/**
 * `register_terms` 工具通道（KA-4）—— 术语与语气档案卡的产出改走工具参数。
 *
 * ## 为什么从围栏换成工具
 *
 * `===TERMS===` 是我们**手搓**的一套协议：一个哨兵串、一段 JSON、七条否定指令
 * （「之前只放译文」「之后只放这个 JSON」「不要有其他内容」…）。真实跑批读出来的
 * 思考内容里，炸掉的调用平均 8.3 处在纠结这套格式（正常的只有 0.9）——JSON 紧凑
 * 还是多行、哨兵前有没有空行、要不要加 ``` 围栏。规则都写了，模型每次仍要重新推导。
 *
 * 工具 schema 把这件事从「说服模型遵守」变成「服务商保证形状」。配上
 * `constrainedSampling: {type:"json_schema", strict}` 之后，不合形状的参数在解码层面
 * 就产生不出来——七条否定指令随之归零。
 *
 * ## 为什么补救层成了工具的执行体
 *
 * 这是本次改动里最要紧的一条。融合式提取下，术语与正文**同时**产出，L0 事后校验，
 * 冲突只能靠追溯改名补；而模型**永远不知道自己报的词被拒了**。
 *
 * 改成两轮之后，L0 的判定结果作为 `toolResult` 回到模型眼前：「『塞拉菲娜』不在本章
 * 原文中，已丢弃」。第二轮的正文因此不会再用那个词。EX-10 里 fused 臂产出的三个
 * 样例泄漏词（塞拉菲娜/林德布鲁姆要塞/「原文形态」）正是这一类——它们当时被 L0 拦下了，
 * 但正文里已经用上了。
 *
 * 补救层的角色没有变大：它仍然**不生产候选**（CONTEXT.md 的定义），只是多了一个
 * 「把判定说回去」的动作。
 *
 * ## strict 模式对 schema 的硬要求
 *
 * OpenAI 系的 strict 要求 `additionalProperties: false` 且**每个属性都在 `required` 里**。
 * 可选字段只能写成 `"type": ["string","null"]`——所以下面 `note` / `quirk` / `zhStrategy`
 * 是可空而不是可缺。这不是啰嗦，是 strict 生效的前提。
 */

import type { Tool } from "@earendil-works/pi-ai";
import { validateTermObjects, type DroppedTerm, type FusedTerm } from "@lightee/core/extract-fuse";

/**
 * 语气档案卡（CONTEXT.md：Voice Profile Card）。
 *
 * 字段照 CONTEXT.md 的定义取：自称、口癖、性别、语体、中文策略、章节出处引文。
 * **存储形态即注入形态**——这里的形状就是将来注入 prompt 的形状，不另做一次转换。
 *
 * 为什么和术语并进同一个工具：模型在**同一段思考**里同时得出这两样（EX-10 的思考
 * 文本里，辨认角色语气与辨认专名是交织的）。拆成两个工具等于要求它把一次判断说两遍。
 */
export interface RegisteredVoice {
  /** 角色名。用本章原文里的形态，与 terms 的 ja 对得上 */
  character: string;
  /** 自称（原文形态，如 わたくし / 俺 / 私） */
  selfRef: string;
  /** 语体：敬体 / 简体 / 混合 */
  register: "敬体" | "简体" | "混合";
  /** 性别（模型判断不出时为 null，不猜） */
  gender: "男" | "女" | "其他" | null;
  /** 口癖（没有就是 null，不要为了填满而编） */
  quirk: string | null;
  /** 中文策略：这个角色的中文该怎么写 */
  zhStrategy: string | null;
  /** 本章原文引文一句。**它是这张卡的证据**，没有引文的卡等于没有出处 */
  evidence: string;
}

export interface RegisterTermsResult {
  terms: FusedTerm[];
  voices: RegisteredVoice[];
  dropped: DroppedTerm[];
  /** 语气卡被丢弃的原因（角色名不在原文里 / 引文不在原文里） */
  droppedVoices: Array<{ character: string; reason: "not_in_source" | "evidence_not_in_source" | "malformed" }>;
  /** 参数整体不可用时的人话一句。**空数组 + 无 reason = 本章确实没有新词** */
  failureReason?: string;
}

// 与 core 的 FusedTermType 一一对应。这个枚举进 schema，是模型能填的全集——
// core 那边加了类型而这里没跟上，模型就永远填不出那个值。
const TERM_TYPES = ["person", "place", "org", "title", "item", "world", "pun", "other"] as const;
const REGISTERS = ["敬体", "简体", "混合"] as const;
const GENDERS = ["男", "女", "其他"] as const;

/**
 * 工具定义。`description` 承担了原来 `FUSED_EXTRACTION_RULE` 的**判据**部分，
 * 但**不再承担格式部分**——格式由 schema 保证。
 *
 * 判据句一字未改（「换一个译者会不会译得不一样」）：EX-03/EX-10 实测它有效，
 * 准确率约 98%，没有理由在换通道时顺手改写它。
 */
export const REGISTER_TERMS_TOOL: Tool = {
  name: "register_terms",
  description: [
    "登记本章出现的、后续章节必须沿用同一译法的专有名词，以及本章可辨识的角色语气。",
    "唯一判据：换一个译者会不会译得不一样？会 → 登记；不会 → 不登记。",
    "登记：人物名（全名/简称/昵称/家名各算一条）、地名、组织、称号、神祇、关键道具、世界观专名。",
    "不登记：日常词汇，以及任何译者都会译成同一个词的一般外来语（ゲーム→游戏、レベル→等级 这类）。",
    "复合专名给完整形态（「星の乙女」是一个词，不要拆成「星」和「乙女」）。",
    "ja 必须逐字出现在本章原文中，拿不准就不登记。",
    // 单章实测：模型把一个谐音昵称正确识别、正确取舍，却登记成了 person。
    // type 不是分类练习，它决定这条词进哪个档案——而 pun 档案是译注检查与
    // 后续章节双关注入的唯一入口，登记成 person 等于让这条链断在第一步。
    "译法依赖读音或字形玩梗的词（谐音昵称、双关绰号），type 填 pun，不要填 person——",
    "它决定这条词进不进双关档案，而双关档案是后续章节自动带上译注的唯一依据。",
    "本章没有新词时，terms 传空数组即可——这是有效答案。",
  ].join("\n"),
  // 服务商侧的硬约束。不支持 strict 的 provider 会静默降级为普通函数工具（prefer），
  // 而不是整次调用失败——通道可用性优先于形状保证。
  constrainedSampling: { type: "json_schema", strict: "prefer" },
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["terms", "voices"],
    properties: {
      terms: {
        type: "array",
        description: "本章新出现的专有名词",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ja", "zh", "type", "note"],
          properties: {
            ja: { type: "string", description: "原文形态，必须逐字见于本章原文" },
            zh: { type: "string", description: "中文译法" },
            type: { type: "string", enum: [...TERM_TYPES] },
            note: {
              type: ["string", "null"],
              // pun 的 note 不是备注，它**就是印给读者看的译注正文**：确认后进双关档案，
              // 后续章节遇到这个词时会照着它写成（译注: …）。说明写成「本章登记的新术语」
              // 这类关于流程的话，读者就会在正文里读到那句话。
              description: "一句话说明这个词是什么。type 为 pun 时，这句话会作为译注原样印给读者，写清梗在哪里；不需要译注就传 null",
            },
          },
        },
      },
      voices: {
        type: "array",
        description: "本章能辨认出语气的角色。辨认不出就传空数组，不要为了填满而编。",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["character", "selfRef", "register", "gender", "quirk", "zhStrategy", "evidence"],
          properties: {
            character: { type: "string", description: "角色名，用本章原文里的形态" },
            selfRef: { type: "string", description: "自称的原文形态" },
            register: { type: "string", enum: [...REGISTERS] },
            gender: { type: ["string", "null"], enum: [...GENDERS, null], description: "判断不出就传 null" },
            quirk: { type: ["string", "null"], description: "口癖；没有就传 null" },
            zhStrategy: { type: ["string", "null"], description: "这个角色的中文该怎么写" },
            evidence: { type: "string", description: "本章原文引文一句，作为这张卡的出处" },
          },
        },
      },
    },
  } as never,
};

export interface ValidateRegisteredOptions {
  /** 本章原文。ja 与引文都必须逐字出现在其中 */
  source: string;
  /** 累积词表已有的 ja（EX-05 逐章增长）。重复的不再入列 */
  known?: ReadonlySet<string>;
}

/**
 * 补救层（L0）对工具参数的判定。
 *
 * 术语部分直接调 `validateTermObjects`——**不重写规则**。schema 管形状，
 * 这里管事实：「这个词是否真的在原文里」是 schema 永远回答不了的问题。
 *
 * 语气卡按同一条纪律：角色名与引文都要逐字见于原文。一张引文编出来的卡，
 * 比没有卡更糟——它会以「有出处」的样子进档案。
 */
export function validateRegisteredTerms(args: unknown, options: ValidateRegisteredOptions): RegisterTermsResult {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { terms: [], voices: [], dropped: [], droppedVoices: [], failureReason: "工具参数不是对象" };
  }
  const record = args as { terms?: unknown; voices?: unknown };
  const termObjects = Array.isArray(record.terms) ? record.terms : [];
  const { terms, dropped } = validateTermObjects(termObjects, options);

  const voices: RegisteredVoice[] = [];
  const droppedVoices: RegisterTermsResult["droppedVoices"] = [];
  const seenCharacters = new Set<string>();
  for (const raw of Array.isArray(record.voices) ? record.voices : []) {
    if (!raw || typeof raw !== "object") { droppedVoices.push({ character: "", reason: "malformed" }); continue; }
    const v = raw as Record<string, unknown>;
    const character = typeof v.character === "string" ? v.character.trim() : "";
    const evidence = typeof v.evidence === "string" ? v.evidence.trim() : "";
    if (!character || !evidence) { droppedVoices.push({ character, reason: "malformed" }); continue; }
    if (!options.source.includes(character)) { droppedVoices.push({ character, reason: "not_in_source" }); continue; }
    if (!options.source.includes(evidence)) { droppedVoices.push({ character, reason: "evidence_not_in_source" }); continue; }
    if (seenCharacters.has(character)) continue;
    seenCharacters.add(character);
    const register = typeof v.register === "string" && (REGISTERS as readonly string[]).includes(v.register)
      ? v.register as RegisteredVoice["register"]
      : "混合";
    const gender = typeof v.gender === "string" && (GENDERS as readonly string[]).includes(v.gender)
      ? v.gender as NonNullable<RegisteredVoice["gender"]>
      : null;
    const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
    voices.push({
      character,
      selfRef: text(v.selfRef) ?? "",
      register,
      gender,
      quirk: text(v.quirk),
      zhStrategy: text(v.zhStrategy),
      evidence,
    });
  }
  return { terms, voices, dropped, droppedVoices };
}

/** 丢弃原因 → 给模型看的人话。词表是给人读的，这段是给模型读的，用词要能被模型用上 */
const DROP_REASON_TEXT: Record<DroppedTerm["reason"], string> = {
  not_in_source: "不在本章原文中",
  known: "已在累积词表中",
  duplicate: "本次重复登记",
  no_zh: "缺中文译法",
  too_long: "过长，多半是把整句当成了词",
  malformed: "字段不完整",
};

/**
 * 工具执行结果 → 回给模型的文本（`toolResult` 的 content）。
 *
 * **这段文字是本次改动的全部意义所在**：它让模型在写正文之前知道哪些词被拒了。
 * 因此丢弃项要**逐条列出并说明原因**，不能只给一个数字——「3 条被丢弃」帮不了它，
 * 「『塞拉菲娜』不在本章原文中」才能让它不在正文里用那个词。
 *
 * 长度有意克制：这段会进第二轮的输入，且每章都不同（进不了前缀缓存）。
 * 丢弃项最多列 10 条——超过 10 条说明模型这一轮整体跑偏了，逐条列举也救不回来。
 */
export function renderToolResult(result: RegisterTermsResult): string {
  if (result.failureReason) return `登记失败：${result.failureReason}。本章按无新词继续。`;
  const lines: string[] = [];
  lines.push(`已登记术语 ${result.terms.length} 条、语气档案 ${result.voices.length} 张。`);
  if (result.terms.length > 0) {
    lines.push(`采纳的译法（正文中必须沿用）：${result.terms.map((t) => `${t.ja}→${t.zh}`).join("、")}`);
  }
  if (result.dropped.length > 0) {
    const shown = result.dropped.slice(0, 10);
    lines.push(`以下未采纳，正文中不要使用这些译法：`);
    for (const item of shown) lines.push(`- ${item.ja || "(空)"}：${DROP_REASON_TEXT[item.reason]}`);
    if (result.dropped.length > shown.length) lines.push(`- 另有 ${result.dropped.length - shown.length} 条未列出`);
  }
  if (result.droppedVoices.length > 0) {
    lines.push(`语气档案未采纳 ${result.droppedVoices.length} 张（角色名或引文不在本章原文中）。`);
  }
  lines.push("现在输出译文正文。");
  return lines.join("\n");
}
