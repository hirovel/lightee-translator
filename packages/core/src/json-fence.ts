/**
 * 剥离 LLM 响应外层的 Markdown 代码围栏。
 *
 * 模型会时不时把 JSON 包进围栏里——同一个提示、同一个模型，两次调用的形态就可能不同。
 * 因此凡是解析 LLM 响应的入口都必须先过这一步：靠「修复重问」兜住格式问题能拿到正确结果，
 * 但要多付一次调用，在动辄十几秒的链路上是白花的钱。
 *
 * 只处理**首尾成对包裹**的情形。正文里出现的围栏、或只有开头没有结尾的残缺输出一律原样返回，
 * 交给解析器如实报错——猜测性地裁剪比解析失败更危险。
 */
const WRAPPED = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

export function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const wrapped = WRAPPED.exec(trimmed);
  return (wrapped?.[1] ?? trimmed).trim();
}

const SNIPPET_LENGTH = 200;

export class JsonPayloadError extends Error {
  constructor(reason: string, readonly snippet: string) {
    super(`${reason}；原始片段前 ${SNIPPET_LENGTH} 字符：${snippet}`);
    this.name = "JsonPayloadError";
  }
}

/** 从首个 `{` 或 `[` 切到末个 `}` 或 `]`，去掉模型常附带的解说文字。 */
function sliceBrackets(text: string): string | null {
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0);
  const ends = [text.lastIndexOf("}"), text.lastIndexOf("]")];
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const end = Math.max(...ends);
  if (end <= start) return null;
  return text.slice(start, end + 1);
}

/** 去掉对象/数组结尾的多余逗号。仅在直接解析失败后才启用，避免伤到字符串正文里的逗号。 */
function dropTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * LLM 响应的唯一 JSON 提取入口。
 *
 * 顺序：剥成对围栏 → 直接解析 → 大括号/方括号切片 → 去尾逗号。前一步能解析就不做后一步，
 * 修复动作只在必要时施加，字符串正文里的逗号和括号因此不会被误改。
 *
 * 全部手段用尽仍解析不了时抛 {@link JsonPayloadError}——静默返回 null 会让上游把
 * 「模型没给结果」和「模型给了空结果」混为一谈，这正是 PL-24 要消灭的失败模式。
 */
export function extractJsonPayload(raw: string): unknown {
  const snippet = raw.slice(0, SNIPPET_LENGTH);
  const stripped = stripJsonFence(raw);
  if (!stripped) throw new JsonPayloadError("响应为空", snippet);
  for (const candidate of [stripped, sliceBrackets(stripped)]) {
    if (!candidate) continue;
    for (const text of [candidate, dropTrailingCommas(candidate)]) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        continue;
      }
    }
  }
  throw new JsonPayloadError("响应不含可解析的 JSON", snippet);
}
