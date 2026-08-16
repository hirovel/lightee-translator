import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminologyRepository } from "./terminology-repository.js";
import { termProvenance, withProvenance } from "./term-provenance.js";

/**
 * ADR-0008 的仓库侧规则（TP-2）：
 * 暂定词条（provenance=model）被终审（action=confirmed）时，新值必须赢、且翻面为 author；
 * 作者定稿（provenance 缺省=author）不被任何 confirmed 覆盖——旧规则保护存量的语义不变。
 */
describe("mergeEntries × provenance", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lightee-prov-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const repo = () => new TerminologyRepository(root);

  it("模型登记（prepared）：新词追加进档案，带 provenance=model", async () => {
    const { snapshot } = await repo().mergeEntries({
      operationId: "reg-1",
      action: "prepared",
      entries: [{ archive: "names", entry: withProvenance({ ja: "ヒヤマ", zh: "小灯", type: "person" }, "model") }],
    });
    const row = snapshot.archives.names.find((entry) => entry.ja === "ヒヤマ");
    expect(row).toBeDefined();
    expect(termProvenance(row!)).toBe("model");
  });

  it("模型再次登记同一词（prepared）：先写的赢——跨章一致性靠先到先得", async () => {
    await repo().mergeEntries({
      operationId: "reg-1",
      action: "prepared",
      entries: [{ archive: "terms", entry: withProvenance({ ja: "聖女", zh: "圣女" }, "model") }],
    });
    const { snapshot } = await repo().mergeEntries({
      operationId: "reg-2",
      action: "prepared",
      entries: [{ archive: "terms", entry: withProvenance({ ja: "聖女", zh: "圣者" }, "model") }],
    });
    const rows = snapshot.archives.terms.filter((entry) => entry.ja === "聖女");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.zh).toBe("圣女");
  });

  it("终审暂定词条（confirmed）：作者的新译法必须赢，且翻面为 author", async () => {
    await repo().mergeEntries({
      operationId: "reg-1",
      action: "prepared",
      entries: [{ archive: "names", entry: withProvenance({ ja: "ヒヤマ", zh: "小灯" }, "model") }],
    });
    const { snapshot } = await repo().mergeEntries({
      operationId: "confirm-1",
      action: "confirmed",
      entries: [{ archive: "names", entry: { ja: "ヒヤマ", zh: "朝日奈" } }],
    });
    const row = snapshot.archives.names.find((entry) => entry.ja === "ヒヤマ");
    expect(row!.zh).toBe("朝日奈");
    expect(termProvenance(row!)).toBe("author");
  });

  it("作者定稿不被 confirmed 覆盖：存量语义原样保留（旧值赢）", async () => {
    await repo().mergeEntries({
      operationId: "author-1",
      action: "confirmed",
      entries: [{ archive: "terms", entry: { ja: "魔導書", zh: "魔导书" } }],
    });
    const { snapshot } = await repo().mergeEntries({
      operationId: "confirm-2",
      action: "confirmed",
      entries: [{ archive: "terms", entry: { ja: "魔導書", zh: "魔法书" } }],
    });
    const row = snapshot.archives.terms.find((entry) => entry.ja === "魔導書");
    expect(row!.zh).toBe("魔导书");
  });

  it("终审后 provenance=author 的词条，模型 prepared 再来也不动它", async () => {
    await repo().mergeEntries({
      operationId: "reg-1",
      action: "prepared",
      entries: [{ archive: "terms", entry: withProvenance({ ja: "紋章", zh: "纹章" }, "model") }],
    });
    await repo().mergeEntries({
      operationId: "confirm-1",
      action: "confirmed",
      entries: [{ archive: "terms", entry: { ja: "紋章", zh: "徽记" } }],
    });
    const { snapshot } = await repo().mergeEntries({
      operationId: "reg-9",
      action: "prepared",
      entries: [{ archive: "terms", entry: withProvenance({ ja: "紋章", zh: "纹章" }, "model") }],
    });
    const row = snapshot.archives.terms.find((entry) => entry.ja === "紋章");
    expect(row!.zh).toBe("徽记");
    expect(termProvenance(row!)).toBe("author");
  });
});

describe("mutateTerms delete × names 档案（终审拒绝的出口）", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lightee-prov-del-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("names 里的暂定词条可删（拒绝=移出档案），且进回收站可还原", async () => {
    const repo = new TerminologyRepository(root);
    const { snapshot } = await repo.mergeEntries({
      operationId: "reg-1",
      action: "prepared",
      entries: [{ archive: "names", entry: withProvenance({ ja: "モブ", zh: "路人甲", type: "person" }, "model") }],
    });
    const row = snapshot.archives.names.find((entry) => entry.ja === "モブ")!;
    const afterDelete = await repo.mutateTerms({
      operationId: "rej-1",
      action: "deleted",
      termId: String(row.id),
      baseRevision: snapshot.revision,
      archive: "names",
    });
    expect(afterDelete.snapshot.archives.names.find((entry) => entry.ja === "モブ")).toBeUndefined();
    expect(afterDelete.snapshot.trash.some((item) => item.item.ja === "モブ")).toBe(true);

    const restored = await repo.mutateTerms({
      operationId: "res-1",
      action: "restored",
      termId: String(row.id),
      baseRevision: afterDelete.snapshot.revision,
      archive: "names",
    });
    expect(restored.snapshot.archives.names.find((entry) => entry.ja === "モブ")).toBeDefined();
  });
});
