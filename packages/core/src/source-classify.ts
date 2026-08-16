/**
 * source-classify —— 证据来源可信度分类（域名/标题启发式）。
 *
 * 设计（2026-07-31 确认）:
 *   official > community > unknown > machine（机翻站降权）
 *   弱启发式 + LLM 兜底（决策 prompt 要求标注证据强度）
 */

import type { EvidenceSourceType } from "./evidence-card.js";

/** 已知机翻/低质来源域名片段（可扩展） */
const MACHINE_DOMAINS = [
  "auto-novel",
  "mtlnovel",
  "lnmtl",
  "novelupdates",
  "justlightnovels",
  "ranobes",
  "novelhall",
  "1kings",
];

/** 社区/百科/论坛域名片段 */
const COMMUNITY_DOMAINS = [
  "wikipedia",
  "wiki",
  "zhihu",
  "bilibili",
  "b23.tv",
  "tieba",
  "baidu",
  "douban",
  "reddit",
  "baka-tsuki",
  "syosetu",
  "kakuyomu",
  "forum",
  "bbs",
  "note.com",
  "pixiv",
];

/** 官方/出版社/书店域名片段 */
const OFFICIAL_DOMAINS = [
  "kadokawa",
  "mf-bunko",
  "dengeki",
  "famitsu",
  "kawakami-books",
  "official",
  "over-lap",
  "hobbyjapan",
  "sbcr",
  "shueisha",
  "kodansha",
  "square-enix",
  "yenpress",
  "j-novel",
];

/** 标题中的机翻/官方信号 */
const MACHINE_TITLE = /机翻|机器翻译|mtl|ai翻译/i;
const OFFICIAL_TITLE = /官方|正版|中文版|简体|繁中|授权/i;

/** 分类证据来源（弱启发式；无法判定返回 unknown，LLM 兜底） */
export function classifySource(url: string, title = ""): EvidenceSourceType {
  const lower = url.toLowerCase();

  if (MACHINE_DOMAINS.some((d) => lower.includes(d)) || MACHINE_TITLE.test(title)) {
    return "machine";
  }
  if (OFFICIAL_DOMAINS.some((d) => lower.includes(d)) || OFFICIAL_TITLE.test(title)) {
    return "official";
  }
  if (COMMUNITY_DOMAINS.some((d) => lower.includes(d))) {
    return "community";
  }
  return "unknown";
}
