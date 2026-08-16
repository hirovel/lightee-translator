/**
 * 术语状态的呈现判定（纯函数，无 DOM）。
 *
 * 术语状态是三态：未提取 / 待确认 N 项 / 已确认。徽标此前压成了两态
 * （`pending > 0 ? N : "✓"`），于是从未提取过的工作区——待确认自然是 0——被显示成 ✓。
 * 用户看到对勾、旁边却写着「未开始」，就是这个压缩造成的：
 * **「没有待确认项」不等于「已完成」**，零值在这里有两种截然不同的含义。
 */

/** 工作区级术语状态。`extracting` 是渲染层的本地态，提取进行中由进度事件驱动 */
export type TermStatus = "not-extracted" | "extracting" | "pending" | "confirmed" | (string & {});

export type BadgeTone = "idle" | "busy" | "warn" | "ok";

export interface TermBadgeView {
  text: string;
  tone: BadgeTone;
  title: string;
}

export function termBadgeView(status: TermStatus, pendingCount: number): TermBadgeView {
  if (status === "extracting") return { text: "…", tone: "busy", title: "正在提取术语" };
  if (pendingCount > 0) return { text: String(pendingCount), tone: "warn", title: `${pendingCount} 项候选术语待确认` };
  if (status === "confirmed") return { text: "✓", tone: "ok", title: "术语已确认" };
  // pending 但计数为 0：会话尚未产出卡片，仍不算完成
  return { text: "–", tone: "idle", title: "尚未扫描术语" };
}

/** 侧栏术语表为空时的说明。空列表只留一片空白，用户无从判断是没有还是没跑过 */
export function termListEmptyText(status: TermStatus): string {
  if (status === "extracting") return "正在提取术语，完成后在此列出。";
  if (status === "confirmed") return "本工作区暂无已确认术语。";
  // EX-07 之后没有「扫描术语」这个动作了——译前提取阶段已经退役，术语是边翻边登记的。
  // 指着一个不存在的按钮让人去点，比不解释更糟。
  return "还没有术语。开始翻译后，译者会把这一章的人名与专有名词登记成卡片，确认过的列在这里。";
}
