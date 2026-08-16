import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { createWorkspace, type Workspace } from "../src/workspace.ts";
import {
  applyParagraphPatch,
  gateTranslationOutput,
  paragraphsPath,
  readChapterParagraphs,
  repairParagraphsXml,
  writeChapterParagraphs,
} from "../src/paragraph-gate.ts";

let dir: string;
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lightee-gate-"));
  ws = await createWorkspace(dir, { name: "门禁测试" });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("repairParagraphsXml", () => {
  it("属性空格修复 + CRLF 统一", () => {
    const out = repairParagraphsXml('<paragraph id = "p0001" type = "body">甲\r\n乙</paragraph>');
    expect(out).toBe('<paragraph id="p0001" type="body">甲\n乙</paragraph>');
  });

  it("剥外层代码块", () => {
    expect(repairParagraphsXml("```xml\n<paragraph id=\"p0001\">甲</paragraph>\n```")).toBe(
      '<paragraph id="p0001">甲</paragraph>'
    );
  });

  it("完全无闭合标签 → 按开标签重切分逐段补闭合", () => {
    const out = repairParagraphsXml('<paragraph id="p0001">甲\n<paragraph id="p0002">乙');
    expect(out).toBe('<paragraph id="p0001">甲</paragraph><paragraph id="p0002">乙</paragraph>');
  });
});

describe("gateTranslationOutput", () => {
  const expected = ["p0001", "p0002"];

  it("合法输出 → ok", () => {
    const gate = gateTranslationOutput(
      '<paragraph id="p0001">甲</paragraph>\n<paragraph id="p0002">乙</paragraph>',
      expected
    );
    expect(gate.ok).toBe(true);
    expect(gate.paragraphs.map((p) => p.text)).toEqual(["甲", "乙"]);
  });

  it("代码块包裹 → parse 内建兼容，ok 且无需 repair", () => {
    const gate = gateTranslationOutput(
      '```xml\n<paragraph id="p0001">甲</paragraph>\n<paragraph id="p0002">乙</paragraph>\n```',
      expected
    );
    expect(gate.ok).toBe(true);
  });

  it("缺少闭合 → repair 补齐后 ok", () => {
    const gate = gateTranslationOutput(
      '<paragraph id="p0001">甲\n<paragraph id="p0002">乙',
      expected
    );
    expect(gate.ok).toBe(true);
    expect(gate.recovered).toBe(true);
    expect(gate.paragraphs.map((p) => p.text)).toEqual(["甲", "乙"]);
  });

  it("真实模型的 </<paragraph> 闭合笔误 → 结构恢复后保留下一段", () => {
    const gate = gateTranslationOutput(
      '<paragraph id="p0001">甲</<paragraph>\n<paragraph id="p0002">乙</paragraph>',
      expected
    );
    expect(gate.ok).toBe(true);
    expect(gate.recovered).toBe(true);
    expect(gate.paragraphs.map((p) => [p.id, p.text])).toEqual([
      ["p0001", "甲"],
      ["p0002", "乙"],
    ]);
  });

  it("真实模型把 paragraph 写成 parameter → 只修标签后通过", () => {
    const gate = gateTranslationOutput(
      '<parameter id="p0001" type="body">甲</parameter>\n<paragraph id="p0002">乙</parameter>',
      expected
    );
    expect(gate.ok).toBe(true);
    expect(gate.recovered).toBe(true);
    expect(gate.paragraphs.map((p) => [p.id, p.text])).toEqual([
      ["p0001", "甲"],
      ["p0002", "乙"],
    ]);
  });

  it("正文里的 <parameter 字样不被改写，错拼的标签名仍修复", () => {
    const xml =
      '<parameter id="p0001" type="body">工具调用要写成 <parameter name="x"> 才对。</parameter>\n' +
      '<paragraph id="p0002">末尾还有 </parameter> 这种字样。</paragraph>';
    const repaired = repairParagraphsXml(xml);
    expect(repaired).toContain('<paragraph id="p0001"');
    expect(repaired).toContain('<parameter name="x">');
    expect(repaired).toContain("末尾还有 </parameter> 这种字样。");
  });

  it("段落数不符 → 失败", () => {
    const gate = gateTranslationOutput('<paragraph id="p0001">甲</paragraph>', expected);
    expect(gate.ok).toBe(false);
    expect(gate.errors.map((e) => e.code)).toContain("count_mismatch");
  });

  it("完全无标签（模型忽略指令）→ 失败且无法恢复", () => {
    const gate = gateTranslationOutput("甲\n\n乙", expected);
    expect(gate.ok).toBe(false);
  });

  it("重复 ID → 失败", () => {
    const gate = gateTranslationOutput(
      '<paragraph id="p0001">甲</paragraph>\n<paragraph id="p0001">乙</paragraph>',
      expected
    );
    expect(gate.ok).toBe(false);
    expect(gate.errors.map((e) => e.code)).toContain("duplicate");
  });

  it("顺序调换 → 失败", () => {
    const gate = gateTranslationOutput(
      '<paragraph id="p0002">乙</paragraph>\n<paragraph id="p0001">甲</paragraph>',
      expected
    );
    expect(gate.ok).toBe(false);
    expect(gate.errors.map((e) => e.code)).toContain("out_of_order");
  });

  it("空响应 → 失败 empty", () => {
    const gate = gateTranslationOutput("   ", expected);
    expect(gate.ok).toBe(false);
    expect(gate.errors.map((e) => e.code)).toContain("empty");
  });
});

describe("writeChapterParagraphs", () => {
  it("写入段落 JSON + md 投影，revision 递增", async () => {
    const paras = [
      { id: "p0001", type: "body" as const, source: "甲", translation: "甲译" },
      { id: "p0002", type: "body" as const, source: "乙", translation: "乙译" },
    ];
    const file = await writeChapterParagraphs(ws, "ch001", paras, { staging: true });
    expect(file.revision).toBe(1);
    const stored = await readChapterParagraphs(ws, "ch001");
    expect(stored?.revision).toBe(1);
    expect(stored?.paragraphs).toEqual(paras);
    const md = await readFile(join(dir, "state", "staging", "ch001_zh.md"), "utf-8");
    expect(md).toBe("甲译\n\n乙译\n");
  });

  it("baseRevision 冲突 → 拒绝", async () => {
    const paras = [{ id: "p0001", type: "body" as const, source: "甲", translation: "甲译" }];
    await writeChapterParagraphs(ws, "ch001", paras, { staging: true });
    await expect(
      writeChapterParagraphs(ws, "ch001", paras, { baseRevision: 0, staging: true })
    ).rejects.toThrow(/段落版本冲突/);
  });

  it("未 staging → 写 translations/", async () => {
    const paras = [{ id: "p0001", type: "body" as const, source: "甲", translation: "甲译" }];
    await writeChapterParagraphs(ws, "ch001", paras);
    const md = await readFile(join(dir, "translations", "ch001_zh.md"), "utf-8");
    expect(md).toBe("甲译\n");
  });
});

describe("applyParagraphPatch", () => {
  const source = [
    { id: "p0001", type: "body" as const, source: "甲", translation: "甲译" },
    { id: "p0002", type: "body" as const, source: "乙", translation: "乙译" },
    { id: "p0003", type: "body" as const, source: "丙", translation: "丙译" },
  ];

  beforeEach(async () => {
    await writeChapterParagraphs(ws, "ch001", source, { staging: true });
  });

  it("只修改指定段并 revision+1", async () => {
    const result = await applyParagraphPatch(ws, {
      chapterId: "ch001",
      baseRevision: 1,
      changes: [{ paragraphId: "p0002", translation: "乙译修订", resolvedIssueIds: ["iss_01"] }],
    });
    expect(result.revision).toBe(2);
    expect(result.paragraphs[1]?.translation).toBe("乙译修订");
    expect(result.paragraphs[0]?.translation).toBe("甲译"); // 未触碰
    const md = await readFile(join(dir, "state", "staging", "ch001_zh.md"), "utf-8");
    expect(md).toBe("甲译\n\n乙译修订\n\n丙译\n");
  });

  it("未知段落 → 拒绝", async () => {
    await expect(
      applyParagraphPatch(ws, {
        chapterId: "ch001",
        baseRevision: 1,
        changes: [{ paragraphId: "p9999", translation: "x" }],
      })
    ).rejects.toThrow(/未知段落/);
  });

  it("revision 冲突 → 拒绝", async () => {
    await expect(
      applyParagraphPatch(ws, {
        chapterId: "ch001",
        baseRevision: 5,
        changes: [{ paragraphId: "p0001", translation: "x" }],
      })
    ).rejects.toThrow(/版本冲突/);
  });

  it("空译文 → 拒绝", async () => {
    await expect(
      applyParagraphPatch(ws, {
        chapterId: "ch001",
        baseRevision: 1,
        changes: [{ paragraphId: "p0001", translation: "   " }],
      })
    ).rejects.toThrow(/译文为空/);
  });

  it("多段 patch 同时应用", async () => {
    const result = await applyParagraphPatch(ws, {
      chapterId: "ch001",
      baseRevision: 1,
      changes: [
        { paragraphId: "p0001", translation: "甲译1" },
        { paragraphId: "p0003", translation: "丙译3" },
      ],
    });
    expect(result.paragraphs.map((p) => p.translation)).toEqual(["甲译1", "乙译", "丙译3"]);
  });
});
