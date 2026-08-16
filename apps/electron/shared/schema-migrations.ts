/**
 * 工作区 schema 版本与迁移注册表（RH-21 / 架构评估 C-3）。
 *
 * 此前只有 chapter events 有版本号，`book.yaml`、`config.json`、五个术语档案都没有。
 * 后果是双向的：旧版本读到新格式会**静默误读**（缺字段当成缺省值，然后把缺省值写回去，
 * 用户的数据就这么没了）；新版本读到旧格式则只能靠散落各处的 `?? default` 兜着。
 *
 * 规则：
 * - 缺失版本字段 = version 0（历史工作区），按注册表逐级迁移到当前版本。
 * - 版本**高于**当前支持 → 抛 `SchemaVersionError` 拒绝打开，且**一个字节都不写**。
 *   宁可让用户去升级，也不能让旧版本把新格式回写成旧格式。
 * - 每条迁移必须幂等：崩溃在迁移中途后重跑必须得到同一结果。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_SCHEMA_VERSION } from "@lightee/engine";
import { atomicWriteFile, atomicWriteJson, readJson, readText } from "./atomic-file.js";

/**
 * 当前支持的工作区 schema 版本。
 *
 * 值定义在 engine（`WORKSPACE_SCHEMA_VERSION`）——新建工作区时写进 book.yaml 的
 * 是它，能读的上限也必须是它，两个数字各写各的迟早对不上。此处只转出，迁移注册表留在这里。
 */
export const CURRENT_SCHEMA_VERSION = WORKSPACE_SCHEMA_VERSION;

export class SchemaVersionError extends Error {
  readonly found: number;
  readonly supported: number;
  constructor(found: number) {
    super(`该工作区由更新版本的 Lightee 创建（schema v${found}，本版本支持 v${CURRENT_SCHEMA_VERSION}）。请升级 Lightee 后再打开；为避免损坏数据，本次未作任何修改。`);
    this.name = "SchemaVersionError";
    this.found = found;
    this.supported = CURRENT_SCHEMA_VERSION;
  }
}

const BOOK_VERSION_LINE = /^schemaVersion:\s*(\d+)\s*$/m;

/** 读工作区当前 schema 版本。以 `book.yaml` 为准——它是工作区存在性的标志文件 */
export async function readSchemaVersion(root: string): Promise<number> {
  const book = await readText(join(root, "book.yaml"), "");
  const found = BOOK_VERSION_LINE.exec(book)?.[1];
  return found ? Number(found) : 0;
}

export interface SchemaMigration {
  /** 目标版本：本条迁移把 `to - 1` 升到 `to` */
  to: number;
  description: string;
  migrate(root: string): Promise<void>;
}

/**
 * 迁移注册表。**按 `to` 升序执行**，新增迁移只能往后追加，绝不修改已发布的条目——
 * 已经跑过的迁移在用户磁盘上留下的结果无法回收。
 */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    to: 1,
    description: "为 book.yaml / config.json 补 schemaVersion（历史工作区没有版本字段）",
    async migrate(root) {
      const bookPath = join(root, "book.yaml");
      const book = await readText(bookPath, "");
      // 没有 book.yaml = 这个目录压根不是工作区。此时凭空造一个只写着 schemaVersion
      // 的空壳，既在用户目录里留了垃圾，又让随后的「就地新建」以为 book.yaml 已经有了
      // （createWorkspaceSkeleton 是 if-not-exists 写入）——书名再也写不进去。
      // 「打开一个不是工作区的目录」必须是只读的一次失败。
      if (!existsSync(bookPath)) return;
      if (!BOOK_VERSION_LINE.test(book)) {
        // 追加到末尾而不是插到开头：book.yaml 的首行是用户可见的 `name:`，
        // 在它前面塞一行机器字段会让文件第一眼就变得陌生。
        const separator = book.length === 0 || book.endsWith("\n") ? "" : "\n";
        await atomicWriteFile(bookPath, `${book}${separator}schemaVersion: 1\n`);
      }
      const configPath = join(root, "config.json");
      const config = await readJson<Record<string, unknown> | null>(configPath, null);
      // config.json 尚不存在的工作区（从没写过设置）不凭空造一个——缺省语义由读取侧负责。
      if (config && config.schemaVersion === undefined) {
        await atomicWriteJson(configPath, { ...config, schemaVersion: 1 });
      }
    },
  },
];

/**
 * 打开工作区前执行。版本过新时抛 `SchemaVersionError`（调用方应把它转成 `conflict`
 * 类错误展示给用户），否则逐级迁移到当前版本。
 */
export async function migrateWorkspaceSchema(root: string): Promise<void> {
  const version = await readSchemaVersion(root);
  if (version > CURRENT_SCHEMA_VERSION) throw new SchemaVersionError(version);
  for (const migration of [...SCHEMA_MIGRATIONS].sort((a, b) => a.to - b.to)) {
    if (migration.to > version) await migration.migrate(root);
  }
}
