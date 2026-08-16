/**
 * 人设合流（R2-2）—— 语气档案与人名条目在**注入层**合成一行。
 *
 * 问题：角色的译法在 names 档案，说话方式在 voice 档案，两份分别注入时模型要自己把
 * 「桧山灯 → 桧山灯」和「桧山灯：随意体、自称私」对上号。赛道的老毛病——代词错、性别错、
 * 敬语层级串——大多出在这个对不上号的缝里。合成一行就没有缝。
 *
 * 与计划的差异：计划要做一次「voice → names.persona」的快照迁移。这里改为**读时推导**：
 * `names[].persona` 是作者权威覆盖层，缺什么就用 voice 档案的投影补什么。理由是迁移会在
 * 翻译热路径上引入一次带锁的仓库写，并且让同一份事实有两个落盘位置；推导取得同样的注入效果，
 * 且 voice 档案继续作为唯一证据源（带 block 引用）。
 */

export interface Persona {
  /**
   * 性别（female / male / unknown）。
   *
   * 这是全表最值钱的一个字段：SSR26 实测一章里中文参考译文用了 10 次「她」、0 次「他」，
   * 而日文原文的第三人称代词出现 **0 次**（两处 `彼` 都是 `彼氏` 的一部分）。
   * 也就是说这 10 个「她」全部来自模型推断，且「他/她」都是合法中文，
   * 机械检查抓不到——只有读的人会觉得别扭。一个字的注入把它从猜变成查表。
   */
  gender?: string;
  /** 作者填写：身份或与主角的关系 */
  role?: string;
  /** 语体：polite=敬体 · plain=随意体 · mixed=混合（混合不注入） */
  register?: string;
  /** 日文自称（voice 档案的 selfRefJa） */
  selfRefJa?: string;
  /** 中文自称译法 */
  selfRefZh?: string;
  // addressing（如何称呼他人）已移除：称呼在日轻里是「A 怎么叫 B」的二元关系，
  // 塞进角色身上的单值字段表达不了，留着只会诱导人填一个必然片面的值。
  // 真要做得另设「称呼对」结构。
}

const REGISTER_LABEL: Record<string, string> = {
  polite: "敬体",
  plain: "随意体",
  // mixed 不进表：写进去等于告诉模型「有时这样有时那样」，白占 token 且不构成约束
};

/** 性别只认规范值：模型偶尔会写「女性」「女の子」，落到注入行里就成了噪声 */
const GENDER_LABEL: Record<string, string> = { female: "女", male: "男" };

/**
 * 人设 → 注入行后缀。空人设返回空串，注入行退化成原来的 `- ja → zh`。
 * 字段顺序固定（性别 → 身份 → 语体 → 自称 → 称呼），同一份人设永远渲染成同一字节串——
 * 冻结前缀（R2-1）靠这一点保持缓存有效。
 */
export function personaSuffix(persona?: Persona): string {
  if (!persona) return "";
  const parts: string[] = [];
  const gender = persona.gender ? GENDER_LABEL[persona.gender.trim()] : undefined;
  if (gender) parts.push(gender);
  if (persona.role?.trim()) parts.push(persona.role.trim());
  const register = persona.register ? REGISTER_LABEL[persona.register] : undefined;
  if (register) parts.push(register);
  const ja = persona.selfRefJa?.trim();
  const zh = persona.selfRefZh?.trim();
  // 只有日文自称时不补中文：编一个译法出来，模型会当成作者确认过的译法照用
  if (ja) parts.push(`自称：${zh ? `${ja}→${zh}` : ja}`);
  return parts.length === 0 ? "" : `（${parts.join("，")}）`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function personaFromVoice(entry: Record<string, unknown>): Persona {
  const persona: Persona = {};
  const gender = str(entry.gender);
  if (gender) persona.gender = gender;
  const register = str(entry.politeStyle) ?? str(entry.register);
  if (register) persona.register = register;
  const selfRefJa = str(entry.selfRefJa);
  if (selfRefJa) persona.selfRefJa = selfRefJa;
  const selfRefZh = str(entry.selfRefZh);
  if (selfRefZh) persona.selfRefZh = selfRefZh;
  return persona;
}

/**
 * 合成注入用人设表（键 = 人名条目的 ja）。
 *
 * 只为**已经在 names 档案里的角色**产出人设：注入面跟着术语走，
 * 语气档案里有而人名档案里没有的角色，本来就不会出现在术语注入里。
 */
export function resolvePersonas(archives: {
  names?: ReadonlyArray<Record<string, unknown>>;
  voice?: ReadonlyArray<Record<string, unknown>>;
}): Map<string, Persona> {
  const names = archives.names ?? [];
  const byName = new Map<string, Persona>();
  const voiceByCharacter = new Map<string, Record<string, unknown>>();
  for (const entry of archives.voice ?? []) {
    const character = str(entry.character);
    if (!character) continue;
    // 同一角色多条语气记录：先到先得，后来的只补空缺，避免后一条整体盖掉前一条
    const existing = voiceByCharacter.get(character);
    voiceByCharacter.set(character, existing ? { ...entry, ...existing } : entry);
  }

  for (const entry of names) {
    const ja = str(entry.ja);
    if (!ja) continue;
    const voice = voiceByCharacter.get(ja);
    const override = asRecord(entry.persona);
    const projected = voice ? personaFromVoice(voice) : {};
    const authored: Persona = {};
    if (override) {
      for (const key of ["gender", "role", "register", "selfRefJa", "selfRefZh"] as const) {
        const value = str(override[key]);
        if (value) authored[key] = value;
      }
    }
    // 逐字段覆盖：作者只填了性别时，语体与自称仍然沿用语气档案的观察结果
    const merged: Persona = { ...projected, ...authored };
    if (Object.keys(merged).length > 0) byName.set(ja, merged);
  }
  return byName;
}
