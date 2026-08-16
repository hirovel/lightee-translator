/**
 * 打包产物解剖：asar 里必须真的存在入口链上的每一个模块。
 *
 * 与 check-package-files.mjs 的分工——那一支查的是**清单**（files 里有没有写全），
 * 这一支查的是**产物**（写全了，是否真的进了 asar）。两者不可互相替代：
 * 清单正确但 electron-builder 的忽略规则把文件筛掉，只有解剖产物才看得见。
 *
 * 为什么源码侧的测试与门禁挡不住这类问题：它们都从源码目录启动 Electron，
 * 而打包清单的正确性在源码运行时不可观测——只有解剖真正发出去的那个文件才作数。
 *
 * 用法：npm run package:win 之后 node scripts/check-asar.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asarPath = join(appRoot, "release", "win-unpacked", "resources", "app.asar");

if (!existsSync(asarPath)) {
  console.error(`找不到打包产物：${asarPath}\n先跑 npm run package:win。`);
  process.exit(1);
}

const entries = new Set(asar.listPackage(asarPath).map((entry) => entry.replace(/\\/g, "/").replace(/^\//, "")));
const manifest = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8"));

const missing = [];
const seen = new Set();
const walk = (relPath) => {
  if (seen.has(relPath) || !entries.has(relPath)) return;
  seen.add(relPath);
  let source;
  try { source = asar.extractFile(asarPath, relPath).toString("utf8"); } catch { return; }
  const pattern = /(?:import|export)[^"']*?["'](\.\.?\/[^"']+)["']|import\(\s*["'](\.\.?\/[^"']+)["']|require\(\s*["'](\.\.?\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    // asar 内部一律是 POSIX 路径。这里**不能**用 path.resolve：Windows 上它会把
    // 「/」当成当前盘根，解析出 C:/... 这种在 asar 里永远不存在的键，于是每一条
    // 引用都被误报成缺失——护栏一旦开始说错话，就和没有护栏一样。
    const target = posix.normalize(posix.join(posix.dirname(relPath), specifier));
    if (!entries.has(target)) { missing.push(`${relPath} → ${specifier}（asar 内缺 ${target}）`); continue; }
    walk(target);
  }
};

for (const entry of [manifest.main ?? "main.js", "preload.js"]) {
  if (!entries.has(entry)) { missing.push(`入口 ${entry} 不在 asar 里`); continue; }
  walk(entry);
}

/**
 * 运行时资源：`join(__dirname, "build", "icon.png")` 这类不经导入图的读取。
 * 缺了不会报错，只会静默回退成默认值，所以必须单独查——沿导入图走一辈子也走不到一个 png。
 */
for (const entry of [manifest.main ?? "main.js", "preload.js"]) {
  if (!entries.has(entry)) continue;
  let source;
  try { source = asar.extractFile(asarPath, entry).toString("utf8"); } catch { continue; }
  const runtimePattern = /join\(\s*__dirname\s*,\s*((?:"[^"]+"|'[^']+')(?:\s*,\s*(?:"[^"]+"|'[^']+'))*)\s*\)/g;
  for (const match of source.matchAll(runtimePattern)) {
    const target = match[1].split(",").map((part) => part.trim().slice(1, -1)).join("/");
    // 源码树上不存在的引用是死引用，与打包无关，不在这里报
    if (!existsSync(resolve(appRoot, target))) continue;
    if (!entries.has(target)) missing.push(`${entry} → 运行时读取 ${target}（asar 内缺）`);
  }
}

/**
 * 可执行文件自报的身份：图标、版本号、公司名都存在 PE 的资源段里，由 electron-builder
 * 在打包时改写。这一步一旦被跳过（`signAndEditExecutable: false` 就会连带跳过——它关的
 * 不只是签名，`Edit` 那半截同样失效），产物会顶着 Electron 自己的壳发出去：资源管理器
 * 里是原子图标，属性页写着 GitHub, Inc. 和 Electron 的版本号。
 *
 * 这类问题没有任何报错，装完也能正常运行，只是每一处露脸的地方都不是自己的名字。
 * 前两道检查看的是「文件在不在」，看不见「文件里写的是谁」，所以要单列这一条。
 */
const exePath = join(appRoot, "release", "win-unpacked", `${manifest.build?.productName ?? "app"}.exe`);
if (process.platform === "win32" && existsSync(exePath)) {
  const ps = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `$v=(Get-Item -LiteralPath '${exePath}').VersionInfo; Write-Output "$($v.ProductName)|$($v.CompanyName)|$($v.FileVersion)"`],
    { encoding: "utf8" },
  );
  if (ps.status === 0) {
    const [productName, companyName, fileVersion] = ps.stdout.trim().split("|");
    const expected = {
      ProductName: manifest.build?.productName,
      CompanyName: manifest.author,
      FileVersion: manifest.version,
    };
    const actual = { ProductName: productName, CompanyName: companyName, FileVersion: fileVersion };
    for (const [field, want] of Object.entries(expected)) {
      if (want && actual[field] !== want) {
        missing.push(`${exePath.split(/[\\/]/).pop()} 的 ${field} 是「${actual[field] || "(空)"}」，应为「${want}」——可执行文件资源未被改写`);
      }
    }
  }
}

if (missing.length) {
  // 三类后果，严重度递减但发现难度递增：
  // 缺模块 → 启动即 ERR_MODULE_NOT_FOUND；缺资源 → 无报错，静默回退成默认值；
  // 元数据未改写 → 一切正常运行，只是每处露脸的地方都不是自己的名字。
  console.error("打包产物有问题——发出去的包会崩溃、静默降级，或顶着别人的名字：");
  for (const item of missing) console.error(`  · ${item}`);
  process.exit(1);
}
console.log(`Asar check passed (${entries.size} files in asar, ${seen.size} entry modules resolved)`);
