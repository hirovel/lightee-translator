/**
 * 打包清单护栏：入口文件引用到的每一个本地模块，都必须在 electron-builder 的 `files` 里。
 *
 * 为什么必须是一道**静态**检查：全套测试与发布门禁都从**源码目录**启动 Electron，
 * 源码目录里文件当然都在。打包清单的正确性在源码运行时不可观测——它只在产物里
 * 才成立或不成立。漏一个入口链上的模块，装出来的应用双击即 ERR_MODULE_NOT_FOUND，
 * 而在此之前一路绿灯。因此这道检查不看运行结果，直接比对「入口引用到的文件」与
 * 「files 覆盖的文件」两个集合。
 *
 * 只查顶层相对导入：`dist/` 与 `dist-main/` 由通配覆盖，不必逐个核对。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8"));
const files = manifest.build?.files ?? [];

/** `files` 里的通配前缀（如 `dist-main/**\/*` → `dist-main/`），命中即算已覆盖 */
const globPrefixes = files
  .filter((entry) => typeof entry === "string" && entry.includes("*"))
  .map((entry) => entry.slice(0, entry.indexOf("*")));
const literals = new Set(files.filter((entry) => typeof entry === "string" && !entry.includes("*")));

const covered = (relPath) => literals.has(relPath) || globPrefixes.some((prefix) => prefix && relPath.startsWith(prefix));

/** 入口文件：electron-builder 的 main 字段 + preload（两者是 asar 的根入口） */
const entries = [manifest.main ?? "main.js", "preload.js"].filter((entry) => existsSync(resolve(appRoot, entry)));

const missing = [];
const seen = new Set();
const walk = (entry) => {
  if (seen.has(entry)) return;
  seen.add(entry);
  const source = readFileSync(resolve(appRoot, entry), "utf8");
  // 静态 import / export-from / 动态 import / require，只取相对路径
  const pattern = /(?:import|export)[^"']*?["'](\.\.?\/[^"']+)["']|import\(\s*["'](\.\.?\/[^"']+)["']|require\(\s*["'](\.\.?\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    const target = relative(appRoot, resolve(dirname(resolve(appRoot, entry)), specifier)).split("\\").join("/");
    if (!covered(target)) missing.push(`${entry} → ${specifier}（解析为 ${target}）`);
    // 顶层文件继续往下走一层：single-instance.js 这类文件自己也可能再引别的
    if (!target.startsWith("dist") && existsSync(resolve(appRoot, target))) walk(target);
  }

  /**
   * 运行时路径引用：`join(__dirname, "build", "icon.png")` 这类。
   *
   * 只扫 import 是不够的：按路径读取的资源（图标、模板、词表）根本不出现在导入图上，
   * 沿导入图走一辈子也走不到一个 png。这类文件漏进清单不会报任何错，只会在打包后
   * 悄悄回退成默认值——一切「正常」运行，只是不对，因此比缺模块更难发现。
   *
   * 判据：只认字面量参数拼出的路径（变量拼接静态上无法判定，不猜）。
   */
  const runtimePattern = /join\(\s*__dirname\s*,\s*((?:"[^"]+"|'[^']+')(?:\s*,\s*(?:"[^"]+"|'[^']+'))*)\s*\)/g;
  for (const match of source.matchAll(runtimePattern)) {
    const segments = match[1].split(",").map((part) => part.trim().slice(1, -1));
    const target = segments.join("/");
    // 引用的目标必须在磁盘上真实存在，否则这条引用本身就是死的，与打包无关
    if (!existsSync(resolve(appRoot, target))) continue;
    if (!covered(target)) missing.push(`${entry} → join(__dirname, ${segments.map((s) => `"${s}"`).join(", ")})（运行时读取 ${target}）`);
  }
};
for (const entry of entries) {
  if (!covered(entry)) missing.push(`入口 ${entry} 本身不在 files 里`);
  walk(entry);
}

if (missing.length) {
  // 后果分两种：缺模块 → 启动即 ERR_MODULE_NOT_FOUND；缺资源 → 无报错，静默回退（图标变默认）。
  // 后者更难发现，因为一切「正常」运行。
  console.error("打包清单缺文件——这些在装出来的 asar 里不存在：");
  for (const item of missing) console.error(`  · ${item}`);
  console.error("\n修法：把上面的文件加进 apps/electron/package.json 的 build.files。");
  process.exit(1);
}
console.log(`Package files check passed (${seen.size} entry modules verified)`);
