/**
 * 「本章是否有作者可见的日文原文」判定（RH-05 / M-8）。
 *
 * renderer 用它决定渲染编辑器还是空原文引导；主进程翻译门禁用等价规则
 * （`hasTranslatableBody`，以 canonical 段落类型为准）。两侧允许细微差异——
 * 主进程是权威，renderer 只决定显示什么。
 *
 * 判据是**逐行**的：段落里只要有一行去空白后非空且不以 `#` 开头，就算有原文。
 * 逐行而不是看整段，是因为 `# 标题` + 单换行 + 正文仍是同一个段落。
 */
export function hasBodyLine(text: string): boolean {
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
}

export function hasAuthorVisibleSource(paragraphs: ReadonlyArray<{ source: string }>): boolean {
  return paragraphs.some((paragraph) => hasBodyLine(paragraph.source));
}
