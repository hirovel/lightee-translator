/**
 * 存储迁移的守门测试。
 *
 * 这些用例守的不是「功能可用」，是「不会再删掉用户的数据」——2026-08-16 那次误删之后，
 * 凡是碰用户数据的路径都必须有自动化背书。所以断言里出现最多的不是「搬过来了」，
 * 而是「原件还在」。
 *
 * 全程只用临时目录，绝不触碰真实的 `~/.lightee` 或 `%APPDATA%`。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lighteePaths } from "./app-paths.js";
import { migrateLegacyStorage } from "./storage-migration.js";

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "lightee-migration-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** 铺一个「旧版用过一阵」的现场：~/.lightee 有配置与历史，旧 profile 有日志 */
function layoutLegacy(options: { home?: boolean; userData?: boolean } = { home: true, userData: true }) {
  const root = join(sandbox, "AppData", "Lightee");
  const legacyHomeDir = join(sandbox, "home", ".lightee");
  const legacyUserDataDir = join(sandbox, "AppData", "lightee-electron");

  if (options.home !== false) {
    mkdirSync(legacyHomeDir, { recursive: true });
    writeFileSync(join(legacyHomeDir, "models.json"), '{"providers":{}}', "utf8");
    writeFileSync(join(legacyHomeDir, "auth.json"), '{"deepseek":{"key":"SEALED"}}', "utf8");
    writeFileSync(join(legacyHomeDir, "workspaces.json"), '{"workspaces":[]}', "utf8");
    writeFileSync(join(legacyHomeDir, "models.json.bak"), "{}", "utf8");
    writeFileSync(join(legacyHomeDir, "llm-history.jsonl"), '{"id":1}\n', "utf8");
    writeFileSync(join(legacyHomeDir, "llm-history.jsonl.1"), '{"id":0}\n', "utf8");
  }
  if (options.userData !== false) {
    mkdirSync(join(legacyUserDataDir, "logs"), { recursive: true });
    mkdirSync(join(legacyUserDataDir, "Cache"), { recursive: true });
    writeFileSync(join(legacyUserDataDir, "logs", "lightee-2026-08-16.log"), "hello\n", "utf8");
    writeFileSync(join(legacyUserDataDir, "Cache", "data_0"), "cache", "utf8");
  }

  return { paths: lighteePaths(root), legacyHomeDir, legacyUserDataDir };
}

describe("storage-migration", () => {
  it("把 ~/.lightee 的配置与历史搬进新根，且原件一个字节都不删", () => {
    const input = layoutLegacy();
    const result = migrateLegacyStorage(input);

    expect(result.migrated).toBe(true);
    expect(readFileSync(input.paths.authPath, "utf8")).toBe('{"deepseek":{"key":"SEALED"}}');
    expect(existsSync(input.paths.modelsPath)).toBe(true);
    expect(existsSync(input.paths.workspaceRegistryPath)).toBe(true);
    expect(existsSync(join(input.paths.configDir, "models.json.bak"))).toBe(true);
    // 轮转份也要一起走，否则「历史只增不减」这个承诺在迁移这一步断掉
    expect(existsSync(input.paths.historyFile)).toBe(true);
    expect(existsSync(`${input.paths.historyFile}.1`)).toBe(true);

    // ——— 核心断言：旧目录只是改名，内容原样还在 ———
    expect(existsSync(input.legacyHomeDir)).toBe(false);
    const retired = `${input.legacyHomeDir}.migrated`;
    expect(readFileSync(join(retired, "auth.json"), "utf8")).toBe('{"deepseek":{"key":"SEALED"}}');
    expect(readFileSync(join(retired, "llm-history.jsonl"), "utf8")).toBe('{"id":1}\n');
  });

  it("只搬旧 profile 的 logs，Chromium 缓存不搬，整个旧 profile 改名留底", () => {
    const input = layoutLegacy();
    migrateLegacyStorage(input);

    expect(readFileSync(join(input.paths.logsDir, "lightee-2026-08-16.log"), "utf8")).toBe("hello\n");
    expect(existsSync(join(input.paths.root, "Cache"))).toBe(false);

    const retired = `${input.legacyUserDataDir}.migrated`;
    expect(readFileSync(join(retired, "Cache", "data_0"), "utf8")).toBe("cache");
  });

  it("幂等：新根已有配置就彻底不动旧目录（重复启动不该反复搬）", () => {
    const input = layoutLegacy();
    mkdirSync(input.paths.configDir, { recursive: true });
    writeFileSync(input.paths.modelsPath, '{"providers":{"mine":{}}}', "utf8");

    migrateLegacyStorage(input);

    // 新根的配置没有被旧文件盖掉
    expect(readFileSync(input.paths.modelsPath, "utf8")).toBe('{"providers":{"mine":{}}}');
    // 旧目录原地不动，连改名都没有
    expect(existsSync(input.legacyHomeDir)).toBe(true);
    expect(existsSync(`${input.legacyHomeDir}.migrated`)).toBe(false);
    expect(readFileSync(join(input.legacyHomeDir, "auth.json"), "utf8")).toBe('{"deepseek":{"key":"SEALED"}}');
  });

  it("再跑一次不会覆盖已有的 .migrated 备份", () => {
    const first = layoutLegacy();
    migrateLegacyStorage(first);

    // 用户又跑了一次旧版，于是 ~/.lightee 重新长出来；新根这次先清空以便再次触发迁移
    rmSync(first.paths.configDir, { recursive: true, force: true });
    mkdirSync(first.legacyHomeDir, { recursive: true });
    writeFileSync(join(first.legacyHomeDir, "auth.json"), '{"second":{"key":"ROUND2"}}', "utf8");

    migrateLegacyStorage(first);

    // 第一次的备份原样保留，第二次另起一个名字
    expect(readFileSync(join(`${first.legacyHomeDir}.migrated`, "auth.json"), "utf8")).toBe('{"deepseek":{"key":"SEALED"}}');
    expect(readFileSync(join(`${first.legacyHomeDir}.migrated-2`, "auth.json"), "utf8")).toBe('{"second":{"key":"ROUND2"}}');
  });

  it("没有任何旧数据时什么都不做（全新安装）", () => {
    const input = layoutLegacy({ home: false, userData: false });
    const result = migrateLegacyStorage(input);

    expect(result.migrated).toBe(false);
    expect(result.log).toEqual([]);
    expect(existsSync(input.paths.root)).toBe(false);
  });

  it("日志只记路径与计数，不含任何配置值", () => {
    const input = layoutLegacy();
    const result = migrateLegacyStorage(input);

    const joined = result.log.join("\n");
    expect(joined).not.toContain("SEALED");
    expect(joined).not.toContain("deepseek");
    expect(joined).toContain("config=4");
    expect(joined).toContain("history=2");
  });

  it("旧 profile 恰好就是新根时不自我吞噬", () => {
    // 理论上只有 --user-data-dir 指反了才会发生，但这条路径的代价是删掉整个数据根。
    const root = join(sandbox, "AppData", "Lightee");
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "logs", "a.log"), "x", "utf8");

    const result = migrateLegacyStorage({
      paths: lighteePaths(root),
      legacyHomeDir: join(sandbox, "nonexistent"),
      legacyUserDataDir: root,
    });

    expect(result.migrated).toBe(false);
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(join(root, "logs"))).toEqual(["a.log"]);
  });
});
