/**
 * TP-5 / ADR-0008 —— 「章开工 = 表定格」靠同一把锁，这条保证不能只活在注释里。
 *
 * 登记即注入之后，术语档案成了翻译一致性的**运行时热路径**：每章开工读快照、
 * 每次登记写档案、终审改写档案。三者都必须经 `withTerminologyWorkspaceLock`
 * 串行化，否则「第 N 章的表 = 它开工那一瞬的档案状态」这句 UI 文案就会变成谎言，
 * 而且坏起来是静默的——竞态不会天天发生，发生时也只表现为某一章术语莫名不一致。
 *
 * 两条钉子：
 *  A. 注入源数据文件（names.json / terms.json / term-trash.json）只许
 *     terminology-repository 直接触碰——其余源码引用它们的行不得出现 fs 访问。
 *  B. 仓库自己的读写入口必须走 withWriter / withTransaction（同锁）。
 *
 * 判据同 architecture.test.ts：宁可漏、不可吵。豁免用 `// invariant-allow: <理由>`。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SOURCE_ROOTS = [
  "packages/core/src",
  "packages/engine/src",
  "apps/electron/shared",
  "apps/electron/renderer/src",
];

interface SourceFile { path: string; text: string }

function collectSources(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "node_modules" || name === "dist" || name === "dist-main") continue;
        walk(full);
        continue;
      }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
      files.push({ path: relative(REPO_ROOT, full).split("\\").join("/"), text: readFileSync(full, "utf8") });
    }
  };
  for (const root of SOURCE_ROOTS) walk(join(REPO_ROOT, root));
  return files;
}

const SOURCES = collectSources();
const REPOSITORY_PATH = "packages/core/src/terminology-repository.ts";

/** 注入源与回收站的数据文件名——「登记即注入」的一致性建立在它们之上 */
const GUARDED_FILES = /"(names\.json|terms\.json|term-trash\.json)"/;
/** 同一行上的 fs 访问形态（读或写；existsSync 也算——它是绕锁读的第一步） */
const FS_ACCESS = /\b(readFileSync|writeFileSync|readFile|writeFile|appendFile|atomicWriteJson|atomicWriteFile|existsSync|createReadStream|createWriteStream|readJson)\s*\(/;
const ALLOW = /invariant-allow:\s*\S/;

describe("TP-5 术语档案同锁不变量", () => {
  it("A. 注入源数据文件只许 terminology-repository 直接触碰", () => {
    const violations: string[] = [];
    for (const file of SOURCES) {
      if (file.path === REPOSITORY_PATH) continue;
      const lines = file.text.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!GUARDED_FILES.test(line) || !FS_ACCESS.test(line)) return;
        const prev = lines[index - 1] ?? "";
        if (ALLOW.test(line) || ALLOW.test(prev)) return;
        violations.push(`${file.path}:${index + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    expect(violations, `绕过术语仓库直接读写注入源文件（要豁免请写 invariant-allow: 理由）:\n${violations.join("\n")}`).toEqual([]);
  });

  it("B. 仓库的读写入口必须持锁（withWriter / withTransaction）", () => {
    const text = SOURCES.find((file) => file.path === REPOSITORY_PATH)?.text ?? "";
    expect(text.length, "terminology-repository.ts 不在扫描范围内？").toBeGreaterThan(0);
    // 三个公共入口：方法声明后 3 行内必须出现 withWriter（readSnapshotInTransaction
    // 按约定只在已持锁的事务内调用，不在此列——它的名字就是它的契约）。
    for (const method of ["async readSnapshot(", "async mergeEntries(", "async mutateTerms(", "async recordStatus("]) {
      const at = text.indexOf(method);
      expect(at, `${method} 不存在——方法改名时请同步这条不变量`).toBeGreaterThanOrEqual(0);
      const window = text.slice(at, at + 240);
      expect(
        /withWriter|withTransaction/.test(window),
        `${method} 声明附近没有 withWriter/withTransaction——读写入口绕开了工作区锁`,
      ).toBe(true);
    }
  });
});
