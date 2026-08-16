import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, SchemaVersionError, migrateWorkspaceSchema, readSchemaVersion } from "./schema-migrations.js";

async function workspace(bookYaml: string, config?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lightee-schema-"));
  await mkdir(join(root, "terminology"), { recursive: true });
  await writeFile(join(root, "book.yaml"), bookYaml, "utf8");
  if (config !== undefined) await writeFile(join(root, "config.json"), config, "utf8");
  return root;
}

describe("schema 版本与迁移（RH-21 / C-3）", () => {
  it("缺失版本字段视为 0，迁移后补齐为当前版本", async () => {
    const root = await workspace("name: 旧书\nsrcLang: ja\ntgtLang: zh\n", "{}");
    expect(await readSchemaVersion(root)).toBe(0);
    await migrateWorkspaceSchema(root);
    expect(await readSchemaVersion(root)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("迁移只补字段，不动既有内容——用户的书名/语言配置一个字都不能改", async () => {
    const root = await workspace("name: 我的小说\nsrcLang: ja\ntgtLang: zh\nvolumes:\n  - id: v01\n    label: 第一卷\n", '{"ai":{"model":"deepseek/deepseek-v4-flash"},"quoteStyle":"jp"}');
    await migrateWorkspaceSchema(root);
    const book = await readFile(join(root, "book.yaml"), "utf8");
    expect(book).toContain("name: 我的小说");
    expect(book).toContain("label: 第一卷");
    expect(book).toContain(`schemaVersion: ${CURRENT_SCHEMA_VERSION}`);
    const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    expect(config.ai.model).toBe("deepseek/deepseek-v4-flash");
    expect(config.quoteStyle).toBe("jp");
    expect(config.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("重复迁移是幂等的（不会写出两行 schemaVersion）", async () => {
    const root = await workspace("name: 幂等\n", "{}");
    await migrateWorkspaceSchema(root);
    const first = await readFile(join(root, "book.yaml"), "utf8");
    await migrateWorkspaceSchema(root);
    const second = await readFile(join(root, "book.yaml"), "utf8");
    expect(second).toBe(first);
    expect(second.match(/^schemaVersion:/gm)?.length).toBe(1);
  });

  it("版本高于当前支持 → 拒绝打开，并明确提示升级 Lightee", async () => {
    const root = await workspace(`name: 未来\nschemaVersion: 99\n`, "{}");
    await expect(migrateWorkspaceSchema(root)).rejects.toBeInstanceOf(SchemaVersionError);
    await expect(migrateWorkspaceSchema(root)).rejects.toThrow(/升级 Lightee/);
  });

  it("拒绝打开时不得改动工作区——用新版本写过的数据绝不能被旧版本回写", async () => {
    const original = "name: 未来\nschemaVersion: 99\n";
    const root = await workspace(original, '{"schemaVersion":99}');
    await migrateWorkspaceSchema(root).catch(() => undefined);
    expect(await readFile(join(root, "book.yaml"), "utf8")).toBe(original);
  });

  it("config.json 不存在时也能迁移（尚未写过任何设置的工作区）", async () => {
    const root = await workspace("name: 无配置\n");
    await expect(migrateWorkspaceSchema(root)).resolves.toBeUndefined();
    expect(await readSchemaVersion(root)).toBe(CURRENT_SCHEMA_VERSION);
  });
});
