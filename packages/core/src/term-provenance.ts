/**
 * 术语 provenance（ADR-0008）：这条词条的译法是谁定的。
 *
 * - `"model"`  —— 暂定词条：模型登记后**立即生效**（进档案、进注入块），未经作者终审。
 * - `"author"` —— 作者终审过（确认/改译/手工创建）。
 *
 * ## 与旧闸门语义（pending / status:"pending_review"）的关系：正交，互不推导
 *
 * `pending` 说的是「**不生效**，等确认」——ADR-0008 已废除的闸门模型；
 * `provenance` 说的是「**已生效**，谁拍的板」。注入路径对两者都不过滤：
 * 12 章实测（evidence-1786585063380）证明过滤式闸门的结局是档案空转、
 * 注入块全程「（无）」、跨章一致性无机制可依。
 *
 * ## 缺省 = author 的理由
 *
 * 存量档案里的每一条都是作者在旧闸门下逐条确认过的。缺省若为 model，
 * 升级瞬间全部存量会被错标成「未终审」，作者面对一堵自己早就审过的卡片墙——
 * 宁可少标暂定，不可把作者定稿降级。
 */

export type TermProvenance = "model" | "author";

export const PROVENANCE_FIELD = "provenance";

/** 判读词条的 provenance。缺失或认不出的值一律按 author（见模块头）。 */
export function termProvenance(entry: Record<string, unknown>): TermProvenance {
  return entry[PROVENANCE_FIELD] === "model" ? "model" : "author";
}

/** 盖章（不改原对象——仓库全线 clone 纪律）。终审翻面就是再盖一次 author。 */
export function withProvenance<T extends Record<string, unknown>>(entry: T, provenance: TermProvenance): T & { provenance: TermProvenance } {
  return { ...entry, [PROVENANCE_FIELD]: provenance };
}
