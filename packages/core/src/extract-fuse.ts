/**
 * 融合提取的 L0 补救层（EX-04 → KA-5）—— 译文与提取增量在同一次调用里产出。
 *
 * ## 通道演进
 *
 * EX-04 用 `===TERMS===` 尾块运输增量：译文走段落协议，增量跟在哨兵之后。
 * KA-5 把运输层换成 `register_terms` 工具调用（服务商按 schema 交付结构），
 * 尾块全家已删除。**融合本身没变**——增量仍在翻译的同一次阅读里产出（ADR-0007），
 * 变的只是它怎么被送回来。
 *
 * 工具通道比尾块强在两处，都是实测：
 *  1. 参数由服务商按 schema 校验，不再需要从可能被截断的文本里打捞 JSON
 *  2. L0 的判定可以经 toolResult **回到模型眼前**，被拒的译法不会再出现在正文里
 *
 * ## 分通道的硬要求（不变）
 *
 * 译文是花了大钱的主产物，增量是同一次阅读的附带品。因此**增量的任何问题都不得连累译文**：
 * 参数不合格、被拒、缺字段——一律只丢增量，译文照常入盘。EX-03 实测这不是杞人忧天：
 * 一次调用烧了 8,189 输出 token 只回了 1 个词，而其余章是 12–20 个。
 *
 * ## 补救层（L0）在这里做什么
 *
 * 只做确定性验证，不做发现：`ja` 必须逐字出现在本章原文里、不与累积词表重复、
 * 字段完整。EX-03 实测直读的幻觉率是 0，所以这层是第二道保险而不是唯一防线——
 * 但「模型说什么不算数，原文说了才算」这条必须由代码保证，不能靠提示词自觉。
 */

/**
 * 完整的 输入 → 输出 样例（TR-06）。
 *
 * ## 为什么散文规则不够
 *
 * 真实跑批读出来的思考内容里，炸掉的那些调用**平均 8.3 处**在纠结输出格式
 * （正常的只有 0.9），末尾几百字符几乎全在自问格式细节。规则都写了，但只写成散文，
 * 模型每次都要重新推导一遍。一个一字不差的样例把这件事变成照抄。
 *
 * ## 为什么放在这里而不是拼在调用点
 *
 * 它必须落在**静态前缀**里：对每一章都相同，才进得了前缀缓存边界（EX-05，
 * 实测命中 74%；KA-4 三章实测缓存读 53120），边际成本≈0。
 * 拼在可变段里会把缓存打碎，样例反而变成净亏。
 *
 * ## 自检
 *
 * `tr06-prompt-example.test.ts` 把 `output` 真的喂给段落门禁，要求零错误——
 * **给模型看一个我们自己都解析不了的样例，比不给样例更糟**。
 * 术语登记不再出现在样例里：工具的 schema 就是它的格式说明书（KA-5）。
 *
 * 文本是为本样例专门编写的，不取自任何作品。
 */
/**
 * 输出结构的完整样例。它示范的是**结构**：id 一致、一一对应、不加多余属性。
 *
 * ## 为什么样例里一个专名都没有
 *
 * 原来的样例用的是虚构奇幻设定（一个角色名 + 一个要塞名）。实测代价是**泄漏**：
 * EX-10 的 fused 臂产出的样例泄漏词里，前两个正是样例自己的那两个专名——
 * 模型把 prompt 示范里的名字当成了本章术语登记出来。
 *
 * 样例要教的是结构，专名对这个目的零贡献，却把两个不存在于本书的词塞进了
 * 模型的工作集。所以现在这两段**一个专有名词都不含**：一句对话、一句叙述，
 * 结构该示范的全都示范到了，可被误认成术语的东西一个也没有。
 *
 * 结构约束用样例而不用散文的理由不变：它在静态前缀里、一次性成本，
 * 而"用文字描述结构"要写五六条否定句——那正是 KA-5 刚从术语通道里拆掉的东西。
 */
export const FUSED_EXAMPLE = {
  ids: ["p0001", "p0002"] as const,
  source: "「もう一度だけ、聞いてもいい？」\n\n少女は窓の外を見つめたまま、静かに頷いた。",
  input: [
    '<paragraph id="p0001">「もう一度だけ、聞いてもいい？」</paragraph>',
    '<paragraph id="p0002">少女は窓の外を見つめたまま、静かに頷いた。</paragraph>',
  ].join("\n"),
  output: [
    '<paragraph id="p0001">「我能再问一次吗？」</paragraph>',
    '<paragraph id="p0002">少女依旧望着窗外，静静地点了点头。</paragraph>',
  ].join("\n"),
} as const;

/**
 * 词条类型。**它不是分类练习，它决定这条词落进哪个档案**
 * （见 `pending-terms.ts` 的 `cardTypeFor`）：person → names、pun → puns、其余 → terms。
 *
 * `pun` 是本轮补的。单章实测里模型把一个谐音昵称正确识别、正确取舍，却只能登记成
 * person——因为枚举里没有 pun。而双关档案是「后续章节自动带上译注」与
 * `pun_note_missing` 检查的**唯一入口**，进不去等于这条链断在第一步。
 */
export type FusedTermType = "person" | "place" | "org" | "title" | "item" | "world" | "pun" | "other";

export interface FusedTerm {
  ja: string;
  zh: string;
  type: FusedTermType;
  note?: string;
}

/** 被补救层拦下的条目。**必须外传**：静默丢弃与「本章确实没有新词」在产出上完全一样。 */
export interface DroppedTerm {
  ja: string;
  reason: "not_in_source" | "known" | "duplicate" | "no_zh" | "too_long" | "malformed";
}

export interface ParseFusedOptions {
  /** 本章原文。`ja` 必须逐字出现在其中，否则丢弃 */
  source: string;
  /** 累积词表已有的 ja（EX-05 逐章增长）。重复的不再入列 */
  known?: ReadonlySet<string>;
}

/** 专名长度上限：超过这个长度的多半是把整句话当成了词 */
const MAX_JA_CHARS = 30;

const TYPES = new Set<FusedTermType>(["person", "place", "org", "title", "item", "world", "pun", "other"]);

/**
 * 补救层（L0）的**唯一实现**：模型报的词项 → 可信词项 + 丢弃清单。
 *
 * 判定顺序有意如此：**幻觉判定排在去重之前**——一个既是幻觉又重复的词，
 * 报「幻觉」比报「重复」有用得多。
 *
 * KA-5 之前这里有两条入口（尾块打捞 / 工具参数），规则必须逐字相同，
 * 靠一份共享实现保证。尾块通道删除后只剩工具参数一条，但这个函数保持独立——
 * 它是「模型说什么不算数，原文说了才算」的落点，与运输层无关。
 */
export function validateTermObjects(objects: ReadonlyArray<unknown>, options: ParseFusedOptions): { terms: FusedTerm[]; dropped: DroppedTerm[] } {
  const terms: FusedTerm[] = [];
  const dropped: DroppedTerm[] = [];
  const seen = new Set<string>();
  for (const raw of objects) {
    const record = raw as Record<string, unknown>;
    const ja = typeof record.ja === "string" ? record.ja.trim() : "";
    if (!ja) { dropped.push({ ja: "", reason: "malformed" }); continue; }
    if (ja.length > MAX_JA_CHARS) { dropped.push({ ja, reason: "too_long" }); continue; }
    const zh = typeof record.zh === "string" ? record.zh.trim() : "";
    if (!zh) { dropped.push({ ja, reason: "no_zh" }); continue; }
    // 补救层的核心一条：原文说了才算
    if (!options.source.includes(ja)) { dropped.push({ ja, reason: "not_in_source" }); continue; }
    if (options.known?.has(ja)) { dropped.push({ ja, reason: "known" }); continue; }
    if (seen.has(ja)) { dropped.push({ ja, reason: "duplicate" }); continue; }
    seen.add(ja);
    const type = typeof record.type === "string" && TYPES.has(record.type as FusedTermType)
      ? record.type as FusedTermType
      : "other";
    const note = typeof record.note === "string" && record.note.trim() ? record.note.trim() : undefined;
    terms.push({ ja, zh, type, ...(note ? { note } : {}) });
  }
  return { terms, dropped };
}

/**
 * 补救层的告警文案。丢弃必须说出来，但**不能反过来制造假警报**：
 * 只在真的丢过东西时才返回文案（IV 批 json-salvage 的教训——修静默失败时
 * 很容易顺手造出「没失败也报警」）。
 */
export function describeDropped(dropped: ReadonlyArray<DroppedTerm>, chapterId: string): string | undefined {
  const hallucinated = dropped.filter((item) => item.reason === "not_in_source");
  if (hallucinated.length === 0) return undefined;
  return `${chapterId} 有 ${hallucinated.length} 个登记词在本章原文里找不到，已丢弃：${hallucinated.slice(0, 5).map((item) => item.ja).join("、")}`;
}
