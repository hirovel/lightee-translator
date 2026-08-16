/**
 * 正文增量的段落剥离器。
 *
 * 翻译的 wire 是段落协议（BQ-02）：`<paragraph id="p0001">译文</paragraph>`。
 * 把 `text_delta` 原样流给渲染层，用户看到的是一串 XML 标签——那不叫"看到译文"。
 * 这里把标签剥掉，只放出**段内文本**，并告诉下游它属于哪一段。
 *
 * ## 为什么必须是增量的
 *
 * 标签会被切在**任意位置**：`<parag` / `raph id="p00` / `01">` 三个 delta 是合法的到达方式。
 * 一次性正则跑不了流。所以这里维持一个待定缓冲，只在能确定「这一段不可能是标签的一部分」
 * 时才放出去——宁可晚放几十毫秒，也不能把半个标签当译文吐出来。
 *
 * ## 判据：末尾的 `<` 一律扣住
 *
 * 任何 `<` 都可能是 `</paragraph>` 的开头。所以放出文本时，**最后一个未闭合的 `<`
 * 及其之后的内容一律留在缓冲里**，等下一个 delta 把它补全。这条规则很笨，
 * 但它是唯一不需要预测下一个字符的规则——而预测下一个字符正是流式解析出错的来源。
 *
 * ## 红线
 *
 * 这里流的是**译文正文**。只走进程内 → 渲染层，不得进 usage.jsonl 与 AppLog。
 */

/** 剥离出的一小段正文。`paragraphId` 为空表示标签还没到（罕见：模型先吐了裸文本）。 */
export interface ParagraphChunk {
  paragraphId: string;
  text: string;
}

/** `<paragraph id="p0001">`：属性顺序与引号形态照生产 wire，多余属性不接受（门禁也不接受）。 */
const OPEN_TAG = /<paragraph\s+id="([^"]*)"\s*>/i;
const CLOSE_TAG = "</paragraph>";

/**
 * 剥掉尾部**可能是标签开头**的残片。
 *
 * 判据必须窄：正文里合法地出现 `<`（「a < b」）时不能把后面的字吃掉。所以只在
 * 尾部那截是 `</paragraph>` 或 `<paragraph …` 的**真前缀**时才丢——
 * 「说到一半</para」丢掉 `</para`，「a < b 成立」原样保留。
 */
function stripDanglingTag(text: string): string {
  const at = text.lastIndexOf("<");
  if (at < 0) return text;
  const tail = text.slice(at).toLowerCase();
  const looksLikeTag = CLOSE_TAG.startsWith(tail) || "<paragraph".startsWith(tail) || /^<paragraph\b/.test(tail);
  return looksLikeTag ? text.slice(0, at) : text;
}

export class ParagraphTextStream {
  /** 还没能确定归属的原始字符 */
  private pending = "";
  /** 当前正在收的段落 id；空串表示还没进入任何段落 */
  private currentId = "";
  private inside = false;

  /**
   * 吃进一段原始增量，吐出**可以安全显示**的正文片段。
   *
   * 返回数组而不是单值：一个 delta 可能横跨多个段落（模型一次吐出好几段）。
   */
  push(delta: string): ParagraphChunk[] {
    if (!delta) return [];
    this.pending += delta;
    const out: ParagraphChunk[] = [];

    // 每一轮要么消费掉一个完整边界，要么放出一段安全文本后结束——不会空转
    for (;;) {
      if (!this.inside) {
        const open = OPEN_TAG.exec(this.pending);
        if (!open) {
          // 没有开标签。段落之间只有换行与空白，全部丢弃；但要留住可能的半个标签。
          this.pending = this.holdBack(this.pending).held;
          return out;
        }
        this.currentId = open[1] ?? "";
        this.inside = true;
        this.pending = this.pending.slice(open.index + open[0].length);
        continue;
      }

      const close = this.pending.indexOf(CLOSE_TAG);
      if (close >= 0) {
        const text = this.pending.slice(0, close);
        if (text) out.push({ paragraphId: this.currentId, text });
        this.pending = this.pending.slice(close + CLOSE_TAG.length);
        this.inside = false;
        this.currentId = "";
        continue;
      }

      // 段内，闭标签还没到：放出安全部分，扣住可能的半个标签
      const { safe, held } = this.holdBack(this.pending);
      if (safe) out.push({ paragraphId: this.currentId, text: safe });
      this.pending = held;
      return out;
    }
  }

  /**
   * 切出「肯定不是标签一部分」的前缀。
   *
   * 从最后一个 `<` 处切：它之后的一切都可能是 `</paragraph>` 或 `<paragraph …>` 的残片。
   * 没有 `<` 就整段都安全。
   */
  private holdBack(text: string): { safe: string; held: string } {
    const at = text.lastIndexOf("<");
    if (at < 0) return { safe: text, held: "" };
    return { safe: text.slice(0, at), held: text.slice(at) };
  }

  /**
   * 收尾：把缓冲里剩下的东西交出去。
   *
   * 只在**段内**才交——段外的残留是标签碎片或空白，放出去就是往译文里掺垃圾。
   * 段内的残留则是真的译文（模型被截断时闭标签永远不会来），扔掉才是丢数据。
   *
   * 但段内的残留里**仍可能扣着半个标签**：`说到一半</para` 这种。截断恰好落在
   * 闭标签中间时就是这个形状，而 `</para` 不是译文。所以交之前再剥一次：
   * 只有当扣住的那截**确实可能是标签**时才丢弃它，否则（正文里的一个 `<`）照常交出。
   */
  finish(): ParagraphChunk[] {
    const rest = this.pending;
    this.pending = "";
    const id = this.currentId;
    const wasInside = this.inside;
    this.inside = false;
    this.currentId = "";
    if (!wasInside) return [];
    const text = stripDanglingTag(rest);
    return text.trim() ? [{ paragraphId: id, text }] : [];
  }
}
