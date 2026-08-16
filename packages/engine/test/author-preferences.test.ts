import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { createWorkspace, type Workspace } from "../src/workspace.ts";
import {
  compilePreferences,
  preferencesForChapter,
  preparePreferencesForTranslation,
  readPreferenceProfile,
  saveAuthorPreferences,
} from "../src/author-preferences.ts";

let dir: string;
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lightee-pref-"));
  ws = await createWorkspace(dir, { name: "偏好测试" });
  await mkdir(join(dir, "terminology"), { recursive: true });
  await writeFile(join(dir, "terminology", "names.json"), JSON.stringify([{ ja: "透君", zh: "辽君", type: "name" }]));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RAW = `桧山灯说话要有撒娇感但不要嗲。她叫辽君时固定译成“辽君”，不要改成“阿辽”。旁白尽量自然，少用网络流行语。战斗场景节奏要快，可以用短句。`;

const COMPILED = {
  rules: [
    { id: "pref-001", scope: { kind: "character", value: "桧山灯" }, kind: "preference", rule: "台词带轻微撒娇感，避免过度嗲化", confidence: 0.9 },
    { id: "pref-002", scope: { kind: "character", value: "桧山灯" }, kind: "constraint", rule: "称呼「透君」固定使用「辽君」", confidence: 0.99 },
    { id: "pref-003", scope: { kind: "book" }, kind: "preference", rule: "旁白减少网络流行语", confidence: 0.85 },
    { id: "pref-004", scope: { kind: "scene", value: "战斗" }, kind: "preference", rule: "提高节奏，使用短句", confidence: 0.8 },
  ],
  unresolved: [{ raw: "更文学还是更口语", reason: "无法唯一解释" }],
  conflicts: [{ a: "pref-001", b: "pref-002", reason: "撒娇与固定称呼可能冲突" }],
};

const compilerLlm = (text: string) => ({ complete: async () => text });

describe("compilePreferences", () => {
  it("正常编译：rules/unresolved/conflicts 结构校验", async () => {
    const profile = await compilePreferences(ws, RAW, compilerLlm(JSON.stringify(COMPILED)), 1);
    expect(profile.rules).toHaveLength(4);
    expect(profile.rules[1]).toMatchObject({ kind: "constraint", scope: { kind: "character", value: "桧山灯" } });
    expect(profile.unresolved).toHaveLength(1);
    expect(profile.conflicts).toHaveLength(1);
    expect(profile.sourceHash).toHaveLength(12);
    expect(profile.sourceRevision).toBe(1);
  });

  it("非法规则移入 unresolved（坏 kind/scope/空 rule）", async () => {
    const profile = await compilePreferences(ws, "x", compilerLlm(JSON.stringify({
      rules: [
        { id: "a", scope: { kind: "book" }, kind: "bogus", rule: "非法类型" },
        { id: "b", scope: { kind: "weird" }, kind: "constraint", rule: "非法作用域" },
        { id: "c", scope: { kind: "book" }, kind: "preference", rule: "" },
        { id: "d", scope: { kind: "book" }, kind: "constraint", rule: "有效规则" },
      ],
      unresolved: [],
      conflicts: [],
    })), 1);
    expect(profile.rules.map((r) => r.id)).toEqual(["d"]);
    expect(profile.unresolved.length).toBe(3);
  });

  it("重复规则去重 → unresolved", async () => {
    const profile = await compilePreferences(ws, "x", compilerLlm(JSON.stringify({
      rules: [
        { id: "a", scope: { kind: "book" }, kind: "preference", rule: "同样规则" },
        { id: "b", scope: { kind: "book" }, kind: "preference", rule: "同样规则" },
      ],
      unresolved: [],
      conflicts: [],
    })), 1);
    expect(profile.rules).toHaveLength(1);
    expect(profile.unresolved).toHaveLength(1);
  });

  it("兼容真实模型嵌套包装 { profile: { rules } }（DeepSeek 实测）", async () => {
    const profile = await compilePreferences(ws, "x", compilerLlm(JSON.stringify({
      profile: {
        rules: [
          { id: "a", scope: { kind: "book" }, kind: "constraint", rule: "アリス固定爱丽丝" },
          { id: "b", scope: { kind: "character", value: "桧山灯" }, kind: "preference", rule: "撒娇" },
        ],
        unresolved: [],
        conflicts: [],
      },
    })), 1);
    expect(profile.rules).toHaveLength(2);
    expect(profile.rules[0]).toMatchObject({ kind: "constraint", rule: "アリス固定爱丽丝" });
    expect(profile.rules[1]).toMatchObject({ kind: "preference", scope: { kind: "character", value: "桧山灯" } });
  });

  it("非 JSON 输出 → 抛错", async () => {
    await expect(compilePreferences(ws, "x", compilerLlm("抱歉无法处理"), 1)).rejects.toThrow();
  });
});

describe("saveAuthorPreferences / preparePreferencesForTranslation", () => {
  it("保存原文 + 编译 profile；原文保留", async () => {
    const { revision, profile } = await saveAuthorPreferences(ws, RAW, compilerLlm(JSON.stringify(COMPILED)));
    expect(revision).toBe(1);
    expect(profile.profileVersion).toBe(1);
    expect(await readFile(join(dir, "state", "author-preferences.md"), "utf8")).toBe(RAW);
    expect(existsSync(join(dir, "state", "author-preferences.json"))).toBe(true);
  });

  it("profile 最新 → 翻译前不重新编译", async () => {
    let compileCalls = 0;
    await saveAuthorPreferences(ws, RAW, compilerLlm(JSON.stringify(COMPILED)));
    const spyLlm = { complete: async () => { compileCalls++; return JSON.stringify(COMPILED); } };
    const profile = await preparePreferencesForTranslation(ws, spyLlm);
    expect(compileCalls).toBe(0); // hash 匹配 → 跳过编译
    expect(profile?.profileVersion).toBe(1);
  });

  it("原文修改 → 翻译前重新编译并递增版本", async () => {
    await saveAuthorPreferences(ws, RAW, compilerLlm(JSON.stringify(COMPILED)));
    await writeFile(join(dir, "state", "author-preferences.md"), RAW + "\n新增：标题保留日式风格。", "utf8");
    const profile = await preparePreferencesForTranslation(ws, compilerLlm(JSON.stringify(COMPILED)));
    expect(profile?.profileVersion).toBe(2);
    const stored = await readPreferenceProfile(ws);
    expect(stored?.profileVersion).toBe(2);
  });

  it("无原文 → null（不调用编译）", async () => {
    let calls = 0;
    const profile = await preparePreferencesForTranslation(ws, { complete: async () => { calls++; return "{}"; } });
    expect(profile).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("preferencesForChapter", () => {
  const profile = {
    profileVersion: 3,
    sourceHash: "abc",
    sourceRevision: 1,
    generatedAt: "",
    rules: [
      { id: "p1", scope: { kind: "book" as const }, kind: "preference" as const, rule: "旁白自然", confidence: 0.9 },
      { id: "p2", scope: { kind: "chapter" as const, value: "ch002" }, kind: "constraint" as const, rule: "仅 ch002", confidence: 0.9 },
      { id: "p3", scope: { kind: "chapter" as const, value: "ch001" }, kind: "constraint" as const, rule: "仅 ch001", confidence: 0.9 },
      { id: "p4", scope: { kind: "character" as const, value: "桧山灯" }, kind: "preference" as const, rule: "撒娇", confidence: 0.9 },
    ],
    unresolved: [],
    conflicts: [],
  };

  it("scope 过滤：book 全量、chapter 匹配、character 按内容定位", () => {
    // 无 sourceText → character 偏好不越权注入
    const block = preferencesForChapter(profile as never, "ch001", "v01");
    expect(block).toContain("旁白自然");
    expect(block).toContain("仅 ch001");
    expect(block).not.toContain("仅 ch002");
    expect(block).not.toContain("撒娇"); // character 无源文定位 → 不注入
    // sourceText 实际包含角色名 → 注入
    const withSource = preferencesForChapter(profile as never, "ch001", "v01", "桧山灯が笑った。");
    expect(withSource).toContain("撒娇");
    expect(withSource).toContain("v3");
  });

  it("无匹配规则 → 空串", () => {
    expect(preferencesForChapter({ ...profile, rules: [] } as never, "ch001")).toBe("");
  });
});
