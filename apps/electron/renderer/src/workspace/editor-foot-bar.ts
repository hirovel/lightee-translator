/**
 * 章节编辑器底栏的标记生成（纯函数，无 DOM）。
 *
 * 三段固定分工，按阅读顺序排：左边身份（哪一章、多少段）、中间键盘参考、右边保存态。
 *
 * 保存态**常驻**。从前它是 display:none↔inline 来回切的，两个后果：一是它一出现
 * 就把同排的东西挤开，每次自动保存整条 bar 抖一下；二是「现在到底存没存」只在存完
 * 那两秒里能看见，其余时间这一格是空的。常驻之后位置固定，也随时答得上话。
 *
 * 键盘那列是唯一允许被牺牲的——容器窄到放不下时逐级摘标签、再摘整组，而不是换行。
 * 换行会把 38px 的状态条顶成两行，文字压到正文上。
 *
 * 拆成独立模块，是因为段数那格要被外部按选择器改写。标记与选择器分居两处时它们会
 * 各走各的：`.efoot-rule` 分隔线插进来之后，「第一个 span」就从段数变成了分隔线，
 * 而没有任何东西拦得住——写进 1px 宽竖线里的文字会溢出来盖在真正的段数上（重影）。
 * 现在两者同住一个文件，并由 editor-foot-bar.test.ts 一起钉死。
 */
import { escapeHtml } from "./html.js";

/** 底栏键盘参考里的一个键组。`optional` 的那组在窄容器里先被摘掉。
 *  不带 title：键帽旁边已经写着这组键干什么，悬停再弹一遍是同一句话说两次。 */
export interface FootKey {
  keys: string[];
  label: string;
  optional?: boolean;
}

export interface FootBarInput {
  chapterId: string;
  /** 身份那格的第二段，如「125 段」 */
  meta: string;
  stateId: string;
  stateLabel: string;
  keys: FootKey[];
}

/** 段数那格的唯一定位方式。改写它的代码一律用这个常量，不要另写选择器。 */
export const FOOT_COUNT_SELECTOR = ".continuous-editor-foot .efoot-count";

export function editorFootBar(input: FootBarInput): string {
  const keys = input.keys
    .map((key) => {
      const caps = key.keys.map((cap) => `<kbd>${escapeHtml(cap)}</kbd>`).join("");
      return `<span class="efoot-key"${key.optional ? " data-optional" : ""}>${caps}<span class="efoot-label">${escapeHtml(key.label)}</span></span>`;
    })
    .join("");
  return `<div class="continuous-editor-foot"><span class="editor-foot-meta"><strong>${escapeHtml(input.chapterId)}</strong><span class="efoot-rule" aria-hidden="true"></span><span class="efoot-count">${escapeHtml(input.meta)}</span></span><span class="editor-foot-shortcut">${keys}</span><span id="${escapeHtml(input.stateId)}" class="save-hint" data-tone="idle" aria-live="polite">${escapeHtml(input.stateLabel)}</span></div>`;
}
