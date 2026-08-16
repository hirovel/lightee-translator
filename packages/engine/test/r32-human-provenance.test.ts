/**
 * R3-2 段落 provenance 与人改保护。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace, type Workspace } from "../src/workspace.ts";
import { translateChapterToFile } from "../src/translate-one.ts";
import { applyParagraphPatch, readChapterParagraphs, writeChapterParagraphs } from "../src/paragraph-gate.ts";

let dir: string;
let ws: Workspace;

const CONFIG = {
  project: { name: "t", srcLang: "ja", tgtLang: "zh" },
  agents: {},
  translation: { mode: "balanced" as const, concurrency: 1, batchChars: 2000 },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lightee-r32-"));
  ws = await createWorkspace(dir, { name: "人改保护" });
  await mkdir(join(dir, "source", "v01"), { recursive: true });
  await mkdir(join(dir, "translations", "v01"), { recursive: true });
  await mkdir(join(dir, "terminology"), { recursive: true });
  await writeFile(join(dir, "source", "v01", "ch001.md"), "「こんにちは」\n\nアリスが言った。", "utf-8");
  await writeFile(
    join(dir, "source", "manifest.json"),
    JSON.stringify({ book: "t", chapters: [{ id: "ch001", title: "第1章", volume: "v01" }] })
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const echoLlm = (text: string) => ({
  complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
    const ids = [...messages[messages.length - 1]!.content.matchAll(/<paragraph id="([^"]+)"/g)].map((x) => x[1]!);
    return { text: ids.map((id) => `<paragraph id="${id}">${text}</paragraph>`).join("\n") };
  },
});

describe("整章重译不覆盖人改段", () => {
  it("标了 human 的段落保留原译文，其余段落照常更新，并上报保留数", async () => {
    await translateChapterToFile(ws, "ch001", echoLlm("机翻一版") as never, CONFIG);
    const first = (await readChapterParagraphs(ws, "ch001"))!;
    await writeChapterParagraphs(
      ws,
      "ch001",
      first.paragraphs.map((p, i) => (i === 0 ? { ...p, translation: "我亲手改的译文", translatedBy: "human" as const } : p)),
      { baseRevision: first.revision }
    );

    const result = await translateChapterToFile(ws, "ch001", echoLlm("机翻二版") as never, CONFIG);
    expect(result.preservedHumanParagraphs).toBe(1);
    const after = (await readChapterParagraphs(ws, "ch001"))!;
    expect(after.paragraphs[0]!.translation).toBe("我亲手改的译文");
    expect(after.paragraphs[0]!.translatedBy).toBe("human");
    expect(after.paragraphs[1]!.translation).toBe("机翻二版");
    expect(after.paragraphs[1]!.translatedBy).toBe("model");
  });

  it("没有人改段时保留数为 0，行为与旧版一致", async () => {
    await translateChapterToFile(ws, "ch001", echoLlm("一版") as never, CONFIG);
    const result = await translateChapterToFile(ws, "ch001", echoLlm("二版") as never, CONFIG);
    expect(result.preservedHumanParagraphs).toBe(0);
    const after = (await readChapterParagraphs(ws, "ch001"))!;
    expect(after.paragraphs.every((p) => p.translation === "二版")).toBe(true);
  });

  it("首次翻译（无既有段落文件）不受影响", async () => {
    const result = await translateChapterToFile(ws, "ch001", echoLlm("首译") as never, CONFIG);
    expect(result.preservedHumanParagraphs).toBe(0);
    expect(result.translation).toContain("首译");
  });
});

describe("局部修订跳过人改段", () => {
  it("patch 命中 human 段 → 跳过并回报，其余段落照常应用", async () => {
    await translateChapterToFile(ws, "ch001", echoLlm("机翻") as never, CONFIG);
    const file = (await readChapterParagraphs(ws, "ch001"))!;
    await writeChapterParagraphs(
      ws,
      "ch001",
      file.paragraphs.map((p, i) => (i === 0 ? { ...p, translation: "人工译文", translatedBy: "human" as const } : p)),
      { baseRevision: file.revision }
    );
    const current = (await readChapterParagraphs(ws, "ch001"))!;

    const result = await applyParagraphPatch(ws, {
      chapterId: "ch001",
      baseRevision: current.revision,
      changes: [
        { paragraphId: current.paragraphs[0]!.id, translation: "修订想改人工段" },
        { paragraphId: current.paragraphs[1]!.id, translation: "修订改机翻段" },
      ],
    });
    expect(result.skippedHumanParagraphs).toEqual([current.paragraphs[0]!.id]);
    expect(result.paragraphs[0]!.translation).toBe("人工译文");
    expect(result.paragraphs[1]!.translation).toBe("修订改机翻段");
  });

  it("patch 全部命中 human 段 → 明确报错而不是静默写一遍空改动", async () => {
    await translateChapterToFile(ws, "ch001", echoLlm("机翻") as never, CONFIG);
    const file = (await readChapterParagraphs(ws, "ch001"))!;
    await writeChapterParagraphs(
      ws,
      "ch001",
      file.paragraphs.map((p) => ({ ...p, translatedBy: "human" as const })),
      { baseRevision: file.revision }
    );
    const current = (await readChapterParagraphs(ws, "ch001"))!;
    await expect(
      applyParagraphPatch(ws, {
        chapterId: "ch001",
        baseRevision: current.revision,
        changes: [{ paragraphId: current.paragraphs[0]!.id, translation: "想改" }],
      })
    ).rejects.toThrow(/人工/);
  });
});
