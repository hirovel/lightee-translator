/**
 * archive-registry —— 声明式档案注册表（决策点模式 D2/D3/D4 的元数据）。
 *
 * 设计（2026-07-31）:
 *   新增档案类型 = 注册一条（file/cardKind/format/check），
 *   检测/确认/注入/审校四步自动支持，不改 confirm-session/translator-context/reviewer。
 *   已有 4 档案（names/terms/voice/onomatopoeia）+ puns 新注册。
 */

// ===== 类型 =====
export type ArchiveKind = "select" | "confirm";

export interface ArchiveEntry {
  ja: string;
  zh?: string;
  reading?: string;
  note?: string;
  [key: string]: unknown;
}

export interface ArchiveType {
  type: string;
  /** 档案文件名（terminology/ 下） */
  file: string;
  /** 卡片交互类型: select=候选选择 · confirm=真伪确认 */
  cardKind: ArchiveKind;
  /** D3 注入格式: 档案项 → prompt 行 */
  format: (entry: ArchiveEntry) => string;
  /** D4 存在性检查: 译文是否满足该档案项 */
  check: (translation: string, entry: ArchiveEntry) => boolean;
}

// ===== 注册表 =====
/** 默认存在性检查：译文含 zh 译法 */
function zhPresent(translation: string, entry: ArchiveEntry): boolean {
  const zh = entry.zh;
  if (!zh) return true;
  return translation.includes(zh);
}

/** 译注标记的两种写法（全角冒号 / 半角冒号），产出侧与检查侧共用这一份 */
const NOTE_MARKS = ["（译注:", "（译注："] as const;

/**
 * 译注是否落在译法**同一行**里。
 *
 * 从前判据是「整章任何位置出现过（译注:」——于是第 3 段有一条别的梗的译注，
 * 就能让本章所有梗的检查全部通过。这类检查比没有检查更糟：它给出的是绿灯，
 * 而它根本没看在意的那个位置。
 *
 * 用行而不用固定字符数：段落是权威单位，译文按段成行，同一行即同一段。
 */
function hasNoteNear(translation: string, zh: string | undefined): boolean {
  if (!zh) return NOTE_MARKS.some((mark) => translation.includes(mark));
  return translation
    .split("\n")
    .some((line) => line.includes(zh) && NOTE_MARKS.some((mark) => line.includes(mark)));
}

export const ARCHIVES: Record<string, ArchiveType> = {
  names: {
    type: "names",
    file: "names.json",
    cardKind: "select",
    format: (e) => `- ${e.ja}${e.reading ? `（${e.reading}）` : ""} → ${e.zh ?? "?"}（名字）`,
    check: zhPresent,
  },
  terms: {
    type: "terms",
    file: "terms.json",
    cardKind: "select",
    format: (e) => `- ${e.ja} → ${e.zh ?? "?"}（术语）`,
    check: zhPresent,
  },
  voice: {
    type: "voice",
    file: "voice.json",
    cardKind: "select",
    format: (e) => `- ${e.ja} → ${e.zh ?? "?"}（语气，角色 ${String(e.character_id ?? "?")}）`,
    check: zhPresent,
  },
  onomatopoeia: {
    type: "onomatopoeia",
    file: "onomatopoeia.json",
    cardKind: "select",
    format: (e) => `- ${e.ja} → ${e.zh ?? "?"}（拟声词）`,
    check: zhPresent,
  },
  puns: {
    type: "puns",
    file: "puns.json",
    cardKind: "confirm",
    format: (e) => {
      const note = typeof e.note === "string" ? e.note.trim() : "";
      // 译注留空是有含义的一档：这个梗只要译法统一，不加译注。
      // 从前留空时会印出「译注「（作者确认的处理方案）」」——一句冒充作者决定的占位文本。
      return note
        ? `- ${e.ja} → 译「${e.zh ?? "?"}」，译注「${note}」`
        : `- ${e.ja} → 译「${e.zh ?? "?"}」（不加译注）`;
    },
    check: (translation, entry) => {
      const zh = entry.zh;
      const hasZh = !zh || translation.includes(zh);
      const note = typeof entry.note === "string" ? entry.note.trim() : "";
      // 译注留空 → 只要求译法统一。界面上一直是这么写的（「把译注留空，这条就不再出现」），
      // 而检查从来没看过这个字段，于是那句话是假的。
      if (!note) return hasZh;
      return hasZh && hasNoteNear(translation, zh);
    },
  },
};

// ===== 工具 =====
/** D3: 档案 → prompt 行 */
export function archiveEntryToPrompt(type: string, entry: ArchiveEntry): string {
  const a = ARCHIVES[type];
  if (!a) throw new Error(`未知档案类型: ${type}`);
  return a.format(entry);
}

/** D4: 单档案项存在性检查 */
export function checkArchiveAdherence(
  type: string,
  translation: string,
  entry: ArchiveEntry
): boolean {
  const a = ARCHIVES[type];
  if (!a) return true;
  return a.check(translation, entry);
}
