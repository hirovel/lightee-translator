/**
 * RV-01 假零修复：审校读得到 staging，读不到就明说。
 *
 * 现状（红）：translations/{id}_zh.md 不存在且无 translationOverride 时，
 * reviewChapter 直接返回 issueCount:0 —— 没检查却说没问题。
 * 而该文件只在「章节 approved 提升」或「作者在编辑器保存过」时才产生，
 * 于是刚翻完、未定稿的章节点「审校本章」永远得到一个假的绿勾。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewChapter } from "../src/review-one.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const SOURCE_PARA = "彼女は桧山灯さんに声をかけた。返事はなかった。";
/** 中文句子里夹着未翻译的片假名专名 → kana_leftover（段落级检查） */
const LEAKED_PARA = "她朝ヒヤマ小姐喊了一声。没有回应。";

async function makeWorkspace(opts: { staging?: string; translation?: string; paragraphs?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lightee-rv01-"));
  roots.push(root);
  await mkdir(join(root, "source", "v01"), { recursive: true });
  await mkdir(join(root, "state", "paragraphs"), { recursive: true });
  await writeFile(
    join(root, "source", "manifest.json"),
    JSON.stringify({ book: "RV01", chapters: [{ id: "ch001", volume: "v01", title: "第一章" }] }),
    "utf8",
  );
  await writeFile(join(root, "source", "v01", "ch001.md"), SOURCE_PARA, "utf8");
  if (opts.paragraphs !== false) {
    await writeFile(
      join(root, "state", "paragraphs", "ch001.json"),
      JSON.stringify({
        revision: 1,
        chapterId: "ch001",
        paragraphs: [{ id: "p0001", type: "text", source: SOURCE_PARA, translation: LEAKED_PARA }],
      }),
      "utf8",
    );
  }
  if (opts.staging !== undefined) {
    await mkdir(join(root, "state", "staging"), { recursive: true });
    await writeFile(join(root, "state", "staging", "ch001_zh.md"), opts.staging, "utf8");
  }
  if (opts.translation !== undefined) {
    await mkdir(join(root, "translations"), { recursive: true });
    await writeFile(join(root, "translations", "ch001_zh.md"), opts.translation, "utf8");
  }
  return root;
}

describe("RV-01 审校回落 staging", () => {
  it("只有 staging 时扫真实译文，而不是打绿勾", async () => {
    const root = await makeWorkspace({ staging: LEAKED_PARA });
    const result = await reviewChapter({ root }, "ch001");
    expect(result.noTranslation).toBeFalsy();
    expect(result.issues.map((i) => i.type)).toContain("kana_leftover");
    expect(result.issueCount).toBeGreaterThan(0);
  });

  it("两处都没有译文时返回 noTranslation，而不是 0 问题", async () => {
    const root = await makeWorkspace();
    const result = await reviewChapter({ root }, "ch001");
    expect(result.noTranslation).toBe(true);
    expect(result.issueCount).toBe(0);
    expect(result.issues).toEqual([]);
  });

  it("translations 存在时仍以 translations 为准（staging 是回落而非覆盖）", async () => {
    // translations 是干净译文、staging 是带残留的旧稿：结果必须干净。
    const root = await makeWorkspace({ translation: "她朝桧山灯小姐喊了一声。没有回应。", staging: LEAKED_PARA });
    const result = await reviewChapter({ root }, "ch001");
    expect(result.noTranslation).toBeFalsy();
    // 段落权威文件里存的是 staging 那版，段落级检查用它——这里只断言译文来源，
    // 即整段回声/未译类判定不该把干净译文报成问题。
    expect(result.issues.map((i) => i.type)).not.toContain("untranslated");
  });

  it("translationOverride 仍然优先于任何落盘文件", async () => {
    const root = await makeWorkspace({ translation: "她朝桧山灯小姐喊了一声。没有回应。" });
    const result = await reviewChapter({ root }, "ch001", { translationOverride: LEAKED_PARA });
    expect(result.noTranslation).toBeFalsy();
  });
});
