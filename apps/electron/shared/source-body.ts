/**
 * 「本章有可翻译正文」的判定（RH-05 / DEF-05）。
 *
 * 单独成模是因为它同时被编排（翻译前置门禁）和 renderer 的空原文引导参照，
 * 判据只能有一份——两侧对「什么算正文」的理解一旦分叉，用户就会看到
 * 「界面说这章是空的，点翻译却真的跑了一轮 LLM」。
 */
import { buildParagraphs } from "@lightee/engine";

/**
 * 以 canonical 段落为准——那才是真正被送去翻译的单位：存在至少一个非
 * heading/separator/image 类型、且去空白后非空的段落。额外排除 `#` 前缀的裸段落
 * （`#无空格标题` 未被 `detectParagraphType` 识别为 heading，但语义上仍是标题）。
 *
 * 原实现按 `split(/\s+/)` 切**词**：`# 新章节` → `["#", "新章节"]`，只有裸 `#` 被过滤，
 * 空章节因此被判定为「有正文」并真的跑了一轮 LLM。
 */
export function hasTranslatableBody(sourceText: string): boolean {
  return buildParagraphs(sourceText).some((paragraph) => {
    if (paragraph.type === "separator" || paragraph.type === "image") return false;
    return hasBodyLine(paragraph.text);
  });
}

/**
 * 段落内是否存在「正文行」：去空白后非空、且不是 `#` 开头的标题行。
 *
 * 逐行判定而不是只看段落首行/整体类型：段落可能是 `# 标题` + 换行 + 正文的组合
 * （单换行不构成段落分隔），此时段落类型是 heading 但确实含正文。
 */
function hasBodyLine(text: string): boolean {
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
}
