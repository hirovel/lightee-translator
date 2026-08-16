/**
 * R2-2 人设合流：语气档案 → 人名条目的注入用人设。
 */
import { describe, it, expect } from "vitest";
import { personaSuffix, resolvePersonas } from "../src/persona.ts";

describe("personaSuffix", () => {
  it("字段齐全时按固定顺序渲染", () => {
    expect(
      personaSuffix({ gender: "female", role: "同班同学", register: "plain", selfRefJa: "私", selfRefZh: "我" })
    ).toBe("（女，同班同学，随意体，自称：私→我）");
  });

  it("性别取规范值并渲染成中文；unknown 不注入", () => {
    expect(personaSuffix({ gender: "male" })).toBe("（男）");
    expect(personaSuffix({ gender: "unknown" })).toBe("");
    expect(personaSuffix({ gender: "随便写的" })).toBe("");
  });

  it("只有部分字段时不留空档", () => {
    expect(personaSuffix({ register: "polite" })).toBe("（敬体）");
    expect(personaSuffix({ selfRefJa: "俺", selfRefZh: "我" })).toBe("（自称：俺→我）");
    expect(personaSuffix({ gender: "male" })).toBe("（男）");
  });

  it("自称只有日文时不编造中文译法", () => {
    expect(personaSuffix({ selfRefJa: "僕" })).toBe("（自称：僕）");
  });

  it("mixed 语体不注入（等于没说，白占 token）", () => {
    expect(personaSuffix({ register: "mixed" })).toBe("");
  });

  it("空人设 → 空串（注入行退化成原来的样子）", () => {
    expect(personaSuffix(undefined)).toBe("");
    expect(personaSuffix({})).toBe("");
  });
});

describe("resolvePersonas", () => {
  const archives = {
    names: [{ ja: "桧山灯", zh: "桧山灯", type: "person_name" }],
    voice: [
      { character: "桧山灯", selfRefJa: "私", selfRefZh: "我", politeStyle: "plain", zhStrategy: "轻快随意" },
    ],
  };

  it("语气档案投影成人设（按角色名对上人名条目）", () => {
    const personas = resolvePersonas(archives);
    expect(personas.get("桧山灯")).toMatchObject({ register: "plain", selfRefJa: "私", selfRefZh: "我" });
  });

  it("人名条目自带 persona 时逐字段覆盖投影（作者权威优先）", () => {
    const personas = resolvePersonas({
      ...archives,
      names: [{ ja: "桧山灯", zh: "桧山灯", persona: { gender: "女", selfRefZh: "人家" } }],
    });
    expect(personas.get("桧山灯")).toMatchObject({
      gender: "女",
      register: "plain",
      selfRefJa: "私",
      selfRefZh: "人家",
    });
  });

  it("语气档案里没有对应人名条目的角色不产生人设（注入面只跟着术语走）", () => {
    const personas = resolvePersonas({
      names: [],
      voice: [{ character: "路人", selfRefJa: "俺" }],
    });
    expect(personas.size).toBe(0);
  });

  it("未指定角色的语气条目被忽略而不是挂到空名字上", () => {
    const personas = resolvePersonas({
      names: [{ ja: "桧山灯", zh: "桧山灯" }],
      voice: [{ character: "", selfRefJa: "私" }],
    });
    expect(personas.size).toBe(0);
  });

  it("档案缺失 → 空表", () => {
    expect(resolvePersonas({}).size).toBe(0);
  });
});

describe("R2-5 性别落地", () => {
  it("语气档案的 gender 投影进人设", () => {
    const personas = resolvePersonas({
      names: [{ ja: "桧山灯", zh: "桧山灯" }],
      voice: [{ character: "桧山灯", gender: "female", selfRefJa: "私", selfRefZh: "我", politeStyle: "plain" }],
    });
    expect(personas.get("桧山灯")).toMatchObject({ gender: "female" });
    expect(personaSuffix(personas.get("桧山灯"))).toBe("（女，随意体，自称：私→我）");
  });

  it("作者在人名条目上的性别覆盖语气档案的判断", () => {
    const personas = resolvePersonas({
      names: [{ ja: "桧山灯", zh: "桧山灯", persona: { gender: "male" } }],
      voice: [{ character: "桧山灯", gender: "female" }],
    });
    expect(personas.get("桧山灯")).toMatchObject({ gender: "male" });
  });

  it("addressing 已移除：写进去也不渲染（形状错误的字段不留后门）", () => {
    expect(personaSuffix({ addressing: "叫谁都用君" } as never)).toBe("");
  });
});
