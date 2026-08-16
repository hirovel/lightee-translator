/**
 * 翻译进行中的**活动位置**。
 *
 * ## 它修的是什么
 *
 * 章节头那格进度数的是 `content.translation` 里非空的段——那是**落盘后**的内容。
 * 实测（runs/flow-1786584396492，SSR26 ch001）：整章 250 秒里 `translate.progress`
 * 一共只发了 3 条，全是 0% 或 100%。也就是说进度条在 250 秒里一动不动，然后跳满。
 *
 * 而逐段位置其实**早就在通道里**：`agent.text` 每段都带 `paragraphId`（KA-5 那一票加的），
 * 只是没有人用它。这里就是用它。
 *
 * ## 为什么不直接算进「已译」
 *
 * 流出来的段**没落盘、也没过段落门禁**——门禁不过是要重来的。把它算进「已译」
 * 只是把「进度条不动」换成「进度条撒谎」，而后者更难发现。所以这里给的是
 * 一个**写明了是「正在写」**的位置，文案里带着「落盘后才计入已译」。
 *
 * 纯函数、不碰 DOM：渲染层的 vitest 跑在无 DOM 的 node 环境，能钉死的只有这一层。
 */

export interface LiveProgressInput {
  /** 最近一次 `agent.text` 的段落 id，形如 `p0119`；没有正文流时为空串 */
  paragraphId: string;
  /**
   * 这个 id 在本章段落表里的实际位次（1-based）。查不到就不传。
   *
   * 段落 id 是**身份不是序号**：作者在中间插一段拿到的是 `p0126`，位置却在第 2。
   * 从 id 里解析编号只在「一次成型、没人动过结构」的章节上成立，那个前提不由任何东西保证。
   * 有位次就用位次，`parseParagraphIndex` 退回成认不出时的兜底。
   */
  index?: number;
  /** 本章总段数（来自 `chapter.load` 的段落表） */
  total: number;
  /** 章节工作流状态 */
  state: string;
  /** 正文流是否还在进行（`agent.text` 的 `done` 取反） */
  running: boolean;
}

export interface LiveProgress {
  position: number;
  total: number;
  percent: number;
  value: string;
  detail: string;
}

/** `p0119` → 119。认不出就返回 0——**不猜**。 */
function parseParagraphIndex(paragraphId: string): number {
  const matched = /^p(\d+)$/.exec(paragraphId.trim());
  if (!matched) return 0;
  const index = Number(matched[1]);
  return Number.isFinite(index) && index > 0 ? index : 0;
}

/**
 * 算出「正在写第几段」。任何一个前提不成立就返回 `null`——
 * 宁可这一格不显示，也不显示一个编出来的进度。
 */
export function liveWritingPosition(input: LiveProgressInput): LiveProgress | null {
  if (input.state === "approved") return null;
  if (input.total <= 0) return null;
  const raw = input.index && input.index > 0 ? input.index : parseParagraphIndex(input.paragraphId);
  if (raw <= 0) return null;
  // 夹紧：段号超出总段数时显示 130/125 是自相矛盾的，读的人只会以为哪里坏了
  const position = Math.min(raw, input.total);
  // 向下取整而不是四舍五入：124/125 = 99.2%，进位成 100% 会让人以为已经写完
  const percent = Math.floor((position / input.total) * 100);
  return {
    position,
    total: input.total,
    percent,
    value: `${position}/${input.total}`,
    // 流停了但还没落盘是一个真实的中间态。抹掉它（返回 null）会让这一格
    // 从 120 掉回 0——看起来像坏了，而实际上什么都没坏。
    detail: input.running
      ? `正在写第 ${position} 段 · 落盘后才计入已译`
      : `已写完 ${position} 段 · 正在落盘`,
  };
}
