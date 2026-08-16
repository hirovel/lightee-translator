/**
 * 术语注入行的渲染（EX-05 之后本模块只剩这一件事）。
 *
 * 原来这里是 R2-1 的**术语表快照冻结**：把全书术语表钉进 system 静态前缀，
 * 之后的新增走章节可变段，矛盾或增量堆积时「重钉」。它的前提是**表在翻译期间基本不变**。
 * 融合提取（EX-04）把这个前提推翻了——表每翻一章就长几行。
 *
 * 取而代之的是更简单的东西：**累积词表，发现顺序追加，永不重排**。
 * 第 N 章的注入块天然是第 N-1 章的字节级前缀，缓存一路命中，也不需要「重钉」这个概念。
 * 改名会让前缀失效一次，但改名是低频动作（且由 EX-06 追溯改名统一处理）。
 */

import { personaSuffix, type Persona } from "./persona.ts";

/** 单条术语的注入行（人设合流后的唯一写法，主翻与局部修订共用） */
export function renderTermLine(
  term: { ja: string; zh: string },
  personas?: ReadonlyMap<string, Persona>
): string {
  return `- ${term.ja} → ${term.zh}${personaSuffix(personas?.get(term.ja))}`;
}
