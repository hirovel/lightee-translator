/**
 * 作者自然语言偏好编译器（BQ-04）。
 *
 * 设计（docs/specs/backend-quality-closure.md §2.6）：
 * - 作者只输入自然语言；原文永久保存，LLM 编译成版本化结构化 profile。
 * - 原文文件不可被编译器覆盖；编译失败保留原文并标记过期，不污染译文。
 * - 规则分 constraint（硬）/ preference（软）/ reference（示例）。
 * - 作用域 book / volume / chapter / character / scene。
 * - 低置信度、作用域不明、冲突进入 unresolved/conflicts，交由 UI 确认（BQ-06）。
 * - 优先级：准确性/结构 > 术语表 > constraint > voice > preference/reference > 默认指南。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "@lightee/core/atomic-fs";
import { TerminologyRepository } from "@lightee/core/terminology-repository";
import type { Workspace } from "./workspace.ts";

// ===== 类型 =====

export type PreferenceKind = "constraint" | "preference" | "reference";
export type PreferenceScopeKind = "book" | "volume" | "chapter" | "character" | "scene";

export interface PreferenceScope {
  kind: PreferenceScopeKind;
  value?: string;
}

export interface PreferenceRule {
  id: string;
  scope: PreferenceScope;
  kind: PreferenceKind;
  rule: string;
  confidence: number;
  examples?: { preferred?: string[]; avoid?: string[] };
}

export interface PreferenceUnresolved {
  raw: string;
  reason: string;
}

export interface PreferenceConflict {
  a: string;
  b: string;
  reason: string;
}

export interface PreferenceProfile {
  profileVersion: number;
  /** 原文 hash（sha256 前 12 位） */
  sourceHash: string;
  sourceRevision: number;
  generatedAt: string;
  rules: PreferenceRule[];
  unresolved: PreferenceUnresolved[];
  conflicts: PreferenceConflict[];
}

export interface AuthorPreferencesFile {
  revision: number;
  text: string;
  updatedAt: number;
}

// ===== 路径 =====

export function authorPreferencesRawPath(ws: Workspace): string {
  return join(ws.root, "state", "author-preferences.md");
}

export function authorPreferencesProfilePath(ws: Workspace): string {
  return join(ws.root, "state", "author-preferences.json");
}

export function readAuthorPreferences(ws: Workspace): string | null {
  const path = authorPreferencesRawPath(ws);
  if (!existsSync(path)) return null;
  try {
    return readFileSyncUtf8(path);
  } catch {
    return null;
  }
}

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, "utf-8");
}

// ===== 编译 =====

export interface PreferenceCompilerLlm {
  complete: (system: string, user: string) => Promise<string>;
}

const COMPILER_SYSTEM = `你是轻小译的偏好编译器（Preference Compiler）。把作者用自然语言表达的翻译偏好整理为结构化规则，供译官与审校者使用。

分类（kind）：
- constraint：硬规则（固定译法、禁用词、明确本地化要求）——违反可阻止交付
- preference：软偏好（风格倾向、语气方向）——仅供参考或局部修订
- reference：示例风格（作者给出的示例段落/台词）——只用于风格判断

作用域（scope.kind）：book（全书）/ volume（卷）/ chapter（章节）/ character（角色）/ scene（场景）；value 填具体值（如角色名）。

规则要求：
- rule 用一句话明确描述，机器可判定。
- 明确的「固定译法」「不要使用某词」→ constraint；「更自然」「更流畅」「有撒娇感」→ preference；示例台词 → reference。
- 无法唯一解释、作用域不明、语义矛盾 → 放 unresolved。
- 规则之间互相矛盾，或与提供的术语表冲突 → 放 conflicts（a/b 用规则序号或 "terminology"）。
- 每条规则给 confidence 0.0-1.0。

仅输出严格 JSON，无其他内容。`;

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
}

/** 编译作者偏好原文 → profile（LLM 输出 + 代码校验 + 冲突登记） */
export async function compilePreferences(
  ws: Workspace,
  rawText: string,
  llm: PreferenceCompilerLlm,
  sourceRevision: number
): Promise<PreferenceProfile> {
  const terminology = await new TerminologyRepository(ws.root).readSnapshot();
  const termLines = [
    ...terminology.archives.names.map((t) => `${t.ja} → ${t.zh}`),
    ...terminology.archives.terms.map((t) => `${t.ja} → ${t.zh}`),
  ].slice(0, 200);

  const user = `术语表（供冲突检测）：
${termLines.join("\n") || "（无）"}

作者偏好原文：
${rawText}

请编译为结构化 profile。`;

  const raw = await llm.complete(COMPILER_SYSTEM, user);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("偏好编译返回非 JSON");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as {
    rules?: Array<Record<string, unknown>>;
    unresolved?: Array<{ raw?: string; reason?: string }>;
    conflicts?: Array<{ a?: string; b?: string; reason?: string }>;
    profile?: {
      rules?: Array<Record<string, unknown>>;
      unresolved?: Array<{ raw?: string; reason?: string }>;
      conflicts?: Array<{ a?: string; b?: string; reason?: string }>;
    };
  };
  // 兼容真实模型的嵌套包装 { profile: { rules } }（P2：DeepSeek 实测返回该结构）
  const body = parsed.profile && Array.isArray(parsed.profile.rules) ? parsed.profile : parsed;

  // 代码校验：非法规则 → 移入 unresolved
  const rules: PreferenceRule[] = [];
  const unresolved: PreferenceUnresolved[] = [];
  const usedIds = new Set<string>();
  const seenRaw = new Set<string>();
  const KIND_SET = new Set<PreferenceKind>(["constraint", "preference", "reference"]);
  const SCOPE_SET = new Set<PreferenceScopeKind>(["book", "volume", "chapter", "character", "scene"]);

  const dedupeKey = (r: PreferenceRule) => `${r.scope.kind}:${r.scope.value ?? ""}:${r.kind}:${r.rule}`;
  for (const item of body.rules ?? []) {
    const kind = item.kind as PreferenceKind;
    const scope = item.scope as PreferenceScope | undefined;
    const rule = typeof item.rule === "string" ? item.rule.trim() : "";
    const id = typeof item.id === "string" ? item.id : "";
    if (!KIND_SET.has(kind) || !rule || !scope || !SCOPE_SET.has(scope.kind as PreferenceScopeKind)) {
      unresolved.push({ raw: JSON.stringify(item).slice(0, 200), reason: "结构不合法或作用域不明" });
      continue;
    }
    const candidate: PreferenceRule = {
      id: id || `pref-${String(rules.length + 1).padStart(3, "0")}`,
      scope: { kind: scope.kind as PreferenceScopeKind, value: typeof scope.value === "string" ? scope.value : undefined },
      kind,
      rule,
      confidence: typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : 0.5,
      examples: item.examples && typeof item.examples === "object"
        ? {
            preferred: Array.isArray((item.examples as { preferred?: unknown }).preferred) ? ((item.examples as { preferred?: string[] }).preferred ?? []) : undefined,
            avoid: Array.isArray((item.examples as { avoid?: unknown }).avoid) ? ((item.examples as { avoid?: string[] }).avoid ?? []) : undefined,
          }
        : undefined,
    };
    const key = dedupeKey(candidate);
    if (seenRaw.has(key)) {
      unresolved.push({ raw: candidate.rule.slice(0, 120), reason: "与已有规则重复" });
      continue;
    }
    seenRaw.add(key);
    usedIds.add(candidate.id);
    rules.push(candidate);
  }

  const conflicts: PreferenceConflict[] = (body.conflicts ?? [])
    .filter((c) => typeof c.a === "string" && typeof c.b === "string")
    .map((c) => ({ a: c.a!, b: c.b!, reason: typeof c.reason === "string" ? c.reason : "" }))
    .slice(0, 20);

  for (const u of body.unresolved ?? []) {
    const raw = typeof u.raw === "string" ? u.raw : JSON.stringify(u).slice(0, 200);
    unresolved.push({ raw: raw.slice(0, 300), reason: typeof u.reason === "string" ? u.reason : "需作者确认" });
  }

  return {
    profileVersion: 0,
    sourceHash: hashOf(rawText),
    sourceRevision,
    generatedAt: new Date().toISOString(),
    rules,
    unresolved,
    conflicts,
  };
}

// ===== 存储 =====

/** 保存作者偏好原文 + 编译 profile（原子写；原文不可覆盖历史） */
export async function saveAuthorPreferences(
  ws: Workspace,
  text: string,
  llm: PreferenceCompilerLlm
): Promise<{ revision: number; profile: PreferenceProfile }> {
  const previous = await readPreferenceProfile(ws);
  const revision = (previous?.sourceRevision ?? 0) + 1;
  const rawPath = authorPreferencesRawPath(ws);
  await atomicWriteFile(rawPath, text);
  const profile = await compilePreferences(ws, text, llm, revision);
  profile.profileVersion = (previous?.profileVersion ?? 0) + 1;
  await atomicWriteFile(authorPreferencesProfilePath(ws), JSON.stringify(profile, null, 2) + "\n");
  return { revision, profile };
}

export async function readPreferenceProfile(ws: Workspace): Promise<PreferenceProfile | null> {
  const path = authorPreferencesProfilePath(ws);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(await readFile(path, "utf-8")) as PreferenceProfile;
    if (!Array.isArray(raw.rules)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 翻译前准备：若原文已修改（hash 不匹配）→ 重新编译；编译失败抛错（不静默） */
export async function preparePreferencesForTranslation(
  ws: Workspace,
  llm: PreferenceCompilerLlm
): Promise<PreferenceProfile | null> {
  const rawPath = authorPreferencesRawPath(ws);
  if (!existsSync(rawPath)) return null;
  const text = readFileSyncUtf8(rawPath);
  const profile = await readPreferenceProfile(ws);
  if (profile && profile.sourceHash === hashOf(text)) return profile;
  const revision = (profile?.sourceRevision ?? 0) + 1;
  const fresh = await compilePreferences(ws, text, llm, revision);
  fresh.profileVersion = (profile?.profileVersion ?? 0) + 1;
  await atomicWriteFile(authorPreferencesProfilePath(ws), JSON.stringify(fresh, null, 2) + "\n");
  return fresh;
}

// ===== 按章注入 =====

/**
 * 为指定章节组装作者偏好注入块。
 * scope 匹配：book/volume 全量；chapter 匹配章节；character/scene 仅在源文实际出现该角色/场景名时注入（P2-5：防止越权到全书）。
 */
export function preferencesForChapter(
  profile: PreferenceProfile,
  chapterId: string,
  volumeId?: string,
  sourceText?: string
): string {
  if (profile.rules.length === 0 && profile.conflicts.length === 0) return "";
  const lines: string[] = [];
  for (const r of profile.rules) {
    let inScope: boolean;
    if (r.scope.kind === "book") {
      inScope = true;
    } else if (r.scope.kind === "volume") {
      inScope = !volumeId || r.scope.value === volumeId;
    } else if (r.scope.kind === "chapter") {
      inScope = !r.scope.value || r.scope.value === chapterId;
    } else if (r.scope.kind === "character" || r.scope.kind === "scene") {
      // 角色/场景偏好只在源文实际出现该角色/场景名时注入；无定位信息则不注入
      inScope = Boolean(r.scope.value && sourceText && sourceText.includes(r.scope.value));
    } else {
      inScope = false;
    }
    if (!inScope) continue;
    const tag = r.kind === "constraint" ? "硬规则" : r.kind === "preference" ? "偏好" : "风格参考";
    const scopeTag = r.scope.value ? `${r.scope.kind}:${r.scope.value}` : r.scope.kind;
    lines.push(`- [${tag}][${scopeTag}] ${r.rule}`);
  }
  if (lines.length === 0) return "";
  return `【作者偏好】v${profile.profileVersion}\n${lines.join("\n")}`;
}
