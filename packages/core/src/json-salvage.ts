/**
 * LLM JSON 数组的容错打捞。
 *
 * 真实模型的返回有两种常见杂质：外面裹一层 markdown 围栏，以及**被 max tokens 从中间切断**。
 * 后者尤其贵——整本书的术语提取跑了 401 秒，只因最后一个对象没写完、末尾缺一个 `]`，
 * 朴素的 `indexOf("[") / lastIndexOf("]")` 就把已经完整的几十个对象连同整次开销一起丢掉。
 *
 * 这份实现按括号深度逐个切出**完整**对象，未闭合的尾巴直接丢弃。
 *
 * 它是全库解析 LLM 数组响应的唯一入口。此前 terminologist-decide 与 terminologist-rounds
 * 各有一份，后者是朴素版，而它的注释宣称自己跟前者一样——注释不会被任何东西检查，
 * 于是这个谎话活到了真实全书跑批那天。收敛到一处之后，等价由结构保证。
 */

/** 剥掉 markdown 围栏与尾逗号；不改动正文。 */
function cleanEnvelope(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/,\s*([\]}])/g, "$1");
}

/**
 * 从可能带围栏、可能被截断的文本里切出完整的顶层对象字面量。
 * 找不到数组起点或一个完整对象都没有时返回空数组，由调用方决定怎么报。
 */
export function extractJsonObjects(text: string): string[] {
  const cleaned = cleanEnvelope(text);
  const start = cleaned.indexOf("[");
  if (start < 0) return [];
  const block = cleaned.slice(start);
  const objects: string[] = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (inStr) {
      // 字符串里的 } ] 不参与结构判定——否则译文里一个右括号就能把解析带偏
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) objStart = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) { objects.push(block.slice(objStart, i + 1)); objStart = -1; }
    } else if (ch === "]" && depth === 0 && objStart < 0) {
      break; // 数组结束
    }
  }
  return objects;
}

/** 文本里是否含一个明确写出来的空数组 `[]`。 */
const EMPTY_ARRAY = /\[\s*\]/;

/**
 * 打捞成 JSON 对象数组。一个完整对象都捞不到才抛——
 * 那种情况才是真的「模型没给数组」，而不是「给了但没写完」。
 *
 * 但「捞不到对象」有两种，必须分开：
 *  - 模型明确回了 `[]` —— 这是**有效答案**（「本章没有拟声词」），返回空数组。
 *  - 文本里根本没有数组 —— 才是解析失败，抛。
 *
 * 混为一谈的代价是反向的：`optional()` 会把模型答对的那次报成「未完成」，
 * 作者读到一条根本不存在的故障。修静默失败时很容易顺手造出这种假警报。
 */
export function salvageJsonArray(text: string): Array<Record<string, unknown>> {
  const objects = extractJsonObjects(text);
  if (objects.length === 0) {
    if (EMPTY_ARRAY.test(cleanEnvelope(text))) return [];
    throw new Error(`LLM 响应无 JSON 数组: ${text.slice(0, 100)}`);
  }
  const parsed: Array<Record<string, unknown>> = [];
  for (const object of objects) {
    // 单个对象自身畸形时跳过它，不牵连其余——同样是「别为一颗老鼠屎倒掉整锅汤」。
    try { parsed.push(JSON.parse(object) as Record<string, unknown>); } catch { /* 丢弃这一个 */ }
  }
  if (parsed.length === 0) throw new Error(`LLM 响应无可解析对象: ${text.slice(0, 100)}`);
  return parsed;
}
