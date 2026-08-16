/**
 * 段落 canonical 模型与 LLM wire protocol（BQ-01）。
 *
 * 设计依据（docs/specs/backend-quality-closure.md §2.5）：
 * - 源文件不直接交给模型猜空行；内部权威结构是 { id, type, text }。
 * - 空行规则：canonical 统一 LF；连续空白行归并为单个段落分隔 `\n\n`；
 *   纯空白不生成段落 ID。
 * - LLM wire protocol 用段落级轻量 XML，只约束段落边界，不约束段内句子。
 * - 标签只在 LLM 请求/响应中出现；写入 Markdown/UI 前剥离。
 *
 * 本模块只负责规范化、切段、类型检测、XML 序列化/解析和顺序校验；
 * “拒绝写入/门禁/局部 patch”在 BQ-02（paragraph-gate-and-patches）实现。
 * type 检测是启发式，仅供 UI/审校提示；段落 ID 门禁不依赖 type 分类。
 */

export type ParagraphType = "heading" | "body" | "separator" | "image" | "note";

export interface ParagraphBlock {
  /** 稳定 ID，如 p0001（顺序生成） */
  id: string;
  type: ParagraphType;
  /** 段内文本（首尾空白行已去除；段内软换行保留） */
  text: string;
}

export type ParagraphWireErrorCode =
  | "malformed"
  | "duplicate"
  | "missing"
  | "out_of_order"
  | "unknown_type"
  | "count_mismatch"
  | "empty";

export interface ParagraphWireError {
  code: ParagraphWireErrorCode;
  message: string;
}

function err(code: ParagraphWireErrorCode, message: string): ParagraphWireError {
  return { code, message };
}

// ===== 空行 / 换行规范化 =====

/**
 * 统一换行与空行：
 * - CRLF/CR → LF
 * - 行尾空白（空格/Tab 后跟换行）去除
 * - 连续空白行（\n{3,}）→ 单一段落分隔 \n\n
 * - 首尾空行去除
 * 保留段落内软换行（单个 \n）。
 */
export function normalizeParagraphText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

/**
 * 按段落分隔切分；过滤纯空白块；去除每段首尾空白行。
 * 输入先经 normalizeParagraphText。
 */
export function splitParagraphs(text: string): string[] {
  /**
   * 切段后段落首尾所有空白（含空格/Tab）去除；纯空白块过滤。
   * 注意：normalizeParagraphText 只统一换行/空行，不 trim 段落内容——
   * 段落内部缩进可能是有意的，段首尾空白在切段时处理。
   */
  return normalizeParagraphText(text)
    .split(/\n{2,}/)
    .map((part) => part.replace(/^\s+|\s+$/g, ""))
    .filter((part) => part.length > 0);
}

// ===== 段落类型检测（启发式，保守） =====

/** 场景分隔符：独立一行，只含分隔符号（与 core/batch 的 SEPARATOR_RE 一致，并补充 U+2015 横线） */
const SEPARATOR_RE = /^\s*(?:[*＊]{3,}|[-─―—]{3,}|~{3,}|・{5,}|[○◯]{3,})\s*$/;
/** 插图标记段：[插图: ...] 或 [image ...]（整段） */
const IMAGE_RE = /^\s*\[(?:插图|image)[^\]]*\]\s*$/;
/** Markdown 标题：# 前缀 */
const HEADING_MD_RE = /^\s*#+\s+/;
/** 日轻章节标题启发式：第X話/章 开头，且无句末标点，且短 */
const HEADING_TITLE_RE = /^第[0-9０-９一二三四五六七八九十百千万]+[話章话]\s?/;

export function detectParagraphType(text: string): ParagraphType {
  const t = text.trim();
  if (!t) return "body";
  if (SEPARATOR_RE.test(t)) return "separator";
  if (IMAGE_RE.test(t)) return "image";
  if (HEADING_MD_RE.test(t)) return "heading";
  if (HEADING_TITLE_RE.test(t) && !/[。．！？!?]/u.test(t) && t.length <= 60) return "heading";
  return "body";
}

// ===== canonical 段落构建 =====

/**
 * 从章节文本构建 canonical 段落列表（ID 按顺序 p0001...）。
 * 空段落（纯空白）不生成 ID。
 */
export function buildParagraphs(text: string): ParagraphBlock[] {
  const parts = splitParagraphs(text);
  return parts.map((part, index) => ({
    id: `p${String(index + 1).padStart(4, "0")}`,
    type: detectParagraphType(part),
    text: part,
  }));
}

// ===== XML wire protocol =====

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

/**
 * 一趟扫描还原实体：链式 replace 会让先还原出的字符与后续文本重新组成实体、被二次解释
 * （`&amp;` 放在哪一步都只是把风险挪到另一个实体上）。单次正则保证每个实体只解释一次。
 */
export function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (match, name: string) => XML_ENTITIES[name] ?? match);
}

/** 序列化段落为 wire 文本（每段一行 <paragraph>） */
export function paragraphsToXml(paragraphs: ReadonlyArray<ParagraphBlock>): string {
  return paragraphs
    .map((p) => `<paragraph id="${p.id}" type="${p.type}">${escapeXml(p.text)}</paragraph>`)
    .join("\n");
}

export interface ParagraphsParseResult {
  paragraphs: ParagraphBlock[];
  /** 宽松解析出的结构错误（重复 ID / 未知 type / 未闭合等） */
  errors: ParagraphWireError[];
  /** 前置剥离掉的赘语字符数（供日志观察模型的寒暄/尾注习惯） */
  stripped: { prefix: number; suffix: number };
}

/**
 * 解析模型返回的 wire 文本为段落列表。
 * - 兼容外层 ``` / ```xml 代码块包裹。
 * - 前置剥离首个 `<paragraph` 之前与最后一个 `</paragraph>` 之后的赘语（R0-5）：
 *   「好的，以下是翻译：」这类寒暄与尾注不参与解析，剥离量记入 stripped。
 * - 忽略标签之间的非标签文本（模型可能附带注释）。
 * - 重复 ID、未知 type、未闭合标签进入 errors；不 throw（由 BQ-02 门禁决定处理）。
 */
export function parseParagraphsXml(xml: string): ParagraphsParseResult {
  let body = xml.trim();
  body = body.replace(/^```(?:xml)?\s*/i, "").replace(/\s*```$/, "");
  const stripped = { prefix: 0, suffix: 0 };
  const firstOpen = body.indexOf("<paragraph");
  if (firstOpen > 0) {
    stripped.prefix = firstOpen;
    body = body.slice(firstOpen);
  }
  // 无闭合标签时不剥尾：截断输出的残段留给门禁的结构修复去判断。
  const lastClose = body.lastIndexOf("</paragraph>");
  if (lastClose >= 0) {
    const tail = lastClose + "</paragraph>".length;
    stripped.suffix = body.length - tail;
    body = body.slice(0, tail);
  }
  if (!body.trim()) {
    return { paragraphs: [], errors: [err("empty", "空响应，无任何段落")], stripped };
  }
  if (firstOpen < 0) {
    return { paragraphs: [], errors: [err("empty", "响应中没有任何 <paragraph> 段落")], stripped };
  }

  const paragraphs: ParagraphBlock[] = [];
  const errors: ParagraphWireError[] = [];
  const ids = new Set<string>();
  let cursor = 0;

  while (cursor < body.length) {
    const open = body.indexOf("<paragraph", cursor);
    if (open < 0) break;
    const tagEnd = body.indexOf(">", open);
    if (tagEnd < 0) {
      errors.push(err("malformed", "未闭合的 <paragraph 标签"));
      break;
    }
    const attrs = body.slice(open + "<paragraph".length, tagEnd);
    const idMatch = /id="([^"]*)"/.exec(attrs);
    const typeMatch = /type="([^"]*)"/.exec(attrs);
    if (!idMatch) {
      errors.push(err("malformed", `缺少 id 属性: ${attrs.trim().slice(0, 40)}`));
      cursor = tagEnd + 1;
      continue;
    }
    const id = idMatch[1]!;
    const type = (typeMatch?.[1] ?? "body") as ParagraphType;
    if (!["heading", "body", "separator", "image", "note"].includes(type)) {
      errors.push(err("unknown_type", `未知段落类型: ${type}（段落 ${id}）`));
    }
    const close = body.indexOf("</paragraph>", tagEnd);
    if (close < 0) {
      errors.push(err("malformed", `段落 ${id} 缺少闭合标签`));
      break;
    }
    const text = unescapeXml(body.slice(tagEnd + 1, close)).replace(/^\n+|\n+$/g, "");
    if (ids.has(id)) errors.push(err("duplicate", `重复段落 ID: ${id}`));
    ids.add(id);
    paragraphs.push({ id, type, text });
    cursor = close + "</paragraph>".length;
  }

  return { paragraphs, errors, stripped };
}

/**
 * 严格顺序校验（BQ-02 门禁的核心判定）：
 * 期望 ID 列表 = 源 canonical 段落 ID。
 * - 数量不符 → count_mismatch
 * - 缺少 ID → missing
 * - 集合一致但顺序不同 → out_of_order
 */
export function validateParagraphOrder(
  parsed: ReadonlyArray<ParagraphBlock>,
  expected: ReadonlyArray<string>
): ParagraphWireError[] {
  const errors: ParagraphWireError[] = [];
  const actual = parsed.map((p) => p.id);

  if (actual.length !== expected.length) {
    errors.push(err("count_mismatch", `段落数不符: 期望 ${expected.length}, 实际 ${actual.length}`));
  }
  const missing = expected.filter((id) => !actual.includes(id));
  if (missing.length > 0) {
    errors.push(err("missing", `缺失段落: ${missing.join(", ")}`));
  }
  if (actual.length === expected.length && missing.length === 0) {
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) {
        errors.push(err("out_of_order", `段落顺序不符: 位置 ${i + 1} 期望 ${expected[i]}, 实际 ${actual[i]}`));
        break;
      }
    }
  }
  return errors;
}

/** 从段落列表生成纯文本（\n\n 分隔）——写入 Markdown/UI 前剥离标签 */
export function paragraphsToText(paragraphs: ReadonlyArray<ParagraphBlock>): string {
  return paragraphs.map((p) => p.text).join("\n\n");
}

/**
 * 把 `join("\n\n")` 投影中的 1-based 行号映射回段落下标（{@link paragraphsToText} 的逆运算）。
 *
 * 投影里每两段之间有一个空分隔行，它**不属于任何段落**：命中分隔行、行号越界、
 * 行号非正整数一律返回 -1。审校问题定位不到段落时宁可显式降级（整章重译/人工），
 * 也不能落到相邻段上——错位修订会原子覆盖无关段落（DEF-03）。
 */
export function paragraphIndexForProjectedLine(texts: ReadonlyArray<string>, line: number): number {
  if (!Number.isInteger(line) || line < 1) return -1;
  let cursor = 0; // 已经消耗掉的行数
  for (let index = 0; index < texts.length; index++) {
    const lineCount = (texts[index] ?? "").split("\n").length;
    if (line <= cursor + lineCount) return index;
    cursor += lineCount;
    if (index < texts.length - 1) {
      if (line === cursor + 1) return -1; // 段间分隔空行
      cursor += 1;
    }
  }
  return -1;
}
