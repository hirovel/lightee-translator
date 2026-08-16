import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminologyRepository } from "@lightee/core/terminology-repository";
import { termProvenance } from "@lightee/core/term-provenance";
import { archiveRegisteredTerms, containmentNotes, provisionalEntriesFor } from "../src/register-archive.ts";
import type { FusedTerm } from "@lightee/core/extract-fuse";

const term = (over: Partial<FusedTerm>): FusedTerm => ({ ja: "ジャ", zh: "译", type: "other", ...over } as FusedTerm);

describe("provisionalEntriesFor（纯映射）", () => {
  it("person → names，其余 → terms", () => {
    const entries = provisionalEntriesFor([
      term({ ja: "ヒヤマ", zh: "小灯", type: "person" }),
      term({ ja: "聖印", zh: "圣印", type: "item" }),
    ]);
    expect(entries.map((e) => e.archive)).toEqual(["names", "terms"]);
  });

  it("pun 不进档案：双关策略是作者裁量（0003 的理由于双关仍成立），走卡片闸门", () => {
    expect(provisionalEntriesFor([term({ ja: "灯ヒナ", zh: "小灯", type: "pun" })])).toEqual([]);
  });

  it("没有译法的词不进档案：注入块没法注一个空译法", () => {
    expect(provisionalEntriesFor([term({ ja: "ナゾ", zh: "", type: "world" })])).toEqual([]);
  });

  it("每条都带 provenance=model", () => {
    const entries = provisionalEntriesFor([term({ ja: "紋章", zh: "纹章", type: "world" })]);
    expect(entries[0]!.entry.provenance).toBe("model");
  });
});

describe("archiveRegisteredTerms（落档）", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lightee-regarc-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("登记即注入：落档后快照立即可见，下一章的 allTerms（names+terms 拼接）天然包含", async () => {
    await archiveRegisteredTerms(root, "ch001", [
      term({ ja: "ヒヤマ", zh: "小灯", type: "person" }),
      term({ ja: "聖印", zh: "圣印", type: "item" }),
    ]);
    const snapshot = await new TerminologyRepository(root).readSnapshot();
    const injected = [...snapshot.archives.names, ...snapshot.archives.terms];
    expect(injected.map((e) => e.ja)).toEqual(["ヒヤマ", "聖印"]);
    for (const entry of injected) expect(termProvenance(entry)).toBe("model");
  });

  it("重跑同一章同一批词幂等：门禁重试不会把档案写出重复行", async () => {
    const terms = [term({ ja: "聖印", zh: "圣印", type: "item" })];
    await archiveRegisteredTerms(root, "ch001", terms);
    await archiveRegisteredTerms(root, "ch001", terms);
    const snapshot = await new TerminologyRepository(root).readSnapshot();
    expect(snapshot.archives.terms.filter((e) => e.ja === "聖印")).toHaveLength(1);
  });

  it("追加序保持（EX-05 缓存前缀前提）：后落档的章排在先落档的章之后", async () => {
    await archiveRegisteredTerms(root, "ch001", [term({ ja: "一", zh: "壹", type: "world" })]);
    await archiveRegisteredTerms(root, "ch002", [term({ ja: "二", zh: "贰", type: "world" })]);
    const snapshot = await new TerminologyRepository(root).readSnapshot();
    expect(snapshot.archives.terms.map((e) => e.ja)).toEqual(["一", "二"]);
  });

  it("全是 pun/无译法时不发操作：零条目的合并连 operationId 都不该占", async () => {
    const result = await archiveRegisteredTerms(root, "ch001", [term({ ja: "灯ヒナ", zh: "×", type: "pun" })]);
    expect(result.archived).toBe(0);
    const snapshot = await new TerminologyRepository(root).readSnapshot();
    expect(snapshot.archives.terms).toHaveLength(0);
    expect(snapshot.operations).toHaveLength(0);
  });

  // ===== TP-3 晋升前置包含检查 =====

  it("TP-3：新词与在档译名互为包含 → 入档时出声（不拦，只提醒）", async () => {
    await archiveRegisteredTerms(root, "ch001", [term({ ja: "セイジョ", zh: "圣女", type: "person" })]);
    const result = await archiveRegisteredTerms(root, "ch002", [term({ ja: "ホシノセイジョ", zh: "星之圣女", type: "person" })]);
    expect(result.archived).toBe(1);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("星之圣女");
    expect(result.notes[0]).toContain("圣女");
    // 提醒不拦路：词条照常入档
    const snapshot = await new TerminologyRepository(root).readSnapshot();
    expect(snapshot.archives.names.map((entry) => entry.zh)).toEqual(["圣女", "星之圣女"]);
  });

  it("TP-3：无包含关系时零杂音", async () => {
    await archiveRegisteredTerms(root, "ch001", [term({ ja: "セイジョ", zh: "圣女", type: "person" })]);
    const result = await archiveRegisteredTerms(root, "ch002", [term({ ja: "モンショウ", zh: "纹章", type: "world" })]);
    expect(result.notes).toEqual([]);
  });
});

describe("containmentNotes（纯判定）", () => {
  const entry = (zh: string) => ({ archive: "terms" as const, entry: { ja: "×", zh } });

  it("双向都报：子串与超串", () => {
    expect(containmentNotes([entry("圣女")], ["星之圣女"])[0]).toContain("子串");
    expect(containmentNotes([entry("星之圣女")], ["圣女"])[0]).toContain("包含");
  });

  it("同批新词之间的包含关系同样要报", () => {
    const notes = containmentNotes([entry("圣女"), entry("星之圣女")], []);
    expect(notes).toHaveLength(1);
  });

  it("同译名不自证包含", () => {
    expect(containmentNotes([entry("圣女")], ["圣女"])).toEqual([]);
  });
});
