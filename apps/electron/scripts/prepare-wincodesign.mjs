/**
 * electron-builder 打包 Windows 目标时需要 winCodeSign 工具包（signtool.exe / rcedit.exe），
 * 由它内部的原生下载器（`app-builder` 二进制）取得。那个压缩包里混着 macOS 的签名库，
 * 其中几个文件是符号链接——本机（无开发者模式、非管理员）解压时对符号链接没有创建权限，
 * 报 `Cannot create symbolic link : 客户端没有所需的特权`，随即无限重试，每次都在缓存目录
 * 留下一个解压到一半的数字命名残目录（曾经堆到 368MB）。
 *
 * macOS 那部分我们用不到——项目只打 Windows 包。这个脚本绕开原生下载器，自己解压同一个
 * 压缩包，用 `-xr'!darwin'` 跳过问题文件，落到 electron-builder 期望的最终目录名下；
 * 目录一旦就位，原生下载器发现缓存命中会直接跳过下载，不会再触发那条失败路径。
 *
 * CI（GitHub Actions windows-latest）不受影响——runner 有创建符号链接的权限，原生下载器
 * 走它自己的路径就能成功（2026-08-16 workflow_dispatch 演练已验证）。这个脚本只在本机
 * 缺这个权限时才有必要，因此设计成缓存已就绪时零开销跳过，可以安全地挂进每次打包前置。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { get } from "node:https";
import { path7za } from "7zip-bin";

const WIN_CODE_SIGN_VERSION = "2.6.0";
const DIR_NAME = `winCodeSign-${WIN_CODE_SIGN_VERSION}`;
const DOWNLOAD_URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${DIR_NAME}/${DIR_NAME}.7z`;

function cacheRoot() {
  if (process.env.ELECTRON_BUILDER_CACHE) return process.env.ELECTRON_BUILDER_CACHE;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA, "electron-builder", "Cache");
  if (process.platform === "darwin") return join(process.env.HOME, "Library", "Caches", "electron-builder");
  return join(process.env.HOME, ".cache", "electron-builder");
}

function downloadFile(url, destPath) {
  return new Promise((resolvePromise, reject) => {
    const file = createWriteStream(destPath);
    get(url, { headers: { "User-Agent": "lightee-build" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        downloadFile(res.headers.location, destPath).then(resolvePromise, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败：HTTP ${res.statusCode} — ${url}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolvePromise));
    }).on("error", reject);
  });
}

async function main() {
  if (process.platform !== "win32") {
    console.log("非 Windows 平台，跳过 winCodeSign 预备（该工具包只服务 win 打包目标）。");
    return;
  }

  const root = cacheRoot();
  const finalDir = join(root, "winCodeSign", DIR_NAME);
  const signtoolMarker = join(finalDir, "windows-10", "x64", "signtool.exe");

  if (existsSync(signtoolMarker)) {
    console.log(`winCodeSign 缓存已就绪：${finalDir}`);
    return;
  }

  const winCodeSignDir = join(root, "winCodeSign");
  mkdirSync(winCodeSignDir, { recursive: true });

  // 清掉历次失败留下的数字命名残目录/压缩包（如 419761175、419761175.7z）——
  // 它们不是缓存，是解压中断的半成品，留着只占地方、不提供任何用处。
  for (const name of readdirSync(winCodeSignDir)) {
    if (/^\d+(\.7z)?$/.test(name)) {
      rmSync(join(winCodeSignDir, name), { recursive: true, force: true });
    }
  }

  const archivePath = join(winCodeSignDir, `${DIR_NAME}.7z`);
  if (!existsSync(archivePath)) {
    console.log(`下载 ${DOWNLOAD_URL} ...`);
    await downloadFile(DOWNLOAD_URL, archivePath);
  }

  console.log(`解压（跳过 darwin，本机对符号链接无权限）→ ${finalDir}`);
  const result = spawnSync(path7za, ["x", archivePath, `-o${finalDir}`, "-xr!darwin", "-bso0", "-bsp0", "-y"], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`7z 解压失败，退出码 ${result.status}`);
    process.exit(1);
  }

  if (!existsSync(signtoolMarker)) {
    console.error(`解压完成但没找到 ${signtoolMarker} —— 压缩包结构可能已变化，需要重新核对。`);
    process.exit(1);
  }

  rmSync(archivePath, { force: true });
  console.log(`winCodeSign 就绪：${finalDir}`);
}

await main();
