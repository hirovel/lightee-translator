/**
 * 生成应用图标 build/icon.png（electron-builder 从它转出 .ico）。
 *
 * 为什么用 Electron 渲染而不是找个图形库：这个仓库里已经有 Chromium 了。
 * 让它渲染一段 SVG 再截图，得到的是**和界面同一个渲染器**画出来的形状——
 * 渐变、圆角、发光的表现与产品里看到的一致，也不必为出图引入新依赖。
 *
 *   npx electron scripts/make-icon.mjs
 *
 * 图形（A3 方案，作者四轮评审后定稿 2026-08-14）：黄昏渐变天空作底——
 * 配色对齐软件的 Dracula 主题（紫粉），白色圆体 L 承粉星，星带光晕与横向耀斑。
 * 早先的青色版是设计稿历史调色板的残影，与应用实际长相不符，已废。
 */
import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), "build", "icon.png");

/** 四角星：四段三次贝塞尔，控制点拉向中心 → 星芒凹进去。k 越小越尖。 */
function sparkle(cx, cy, r, k = 0.24) {
  const c = r * k;
  return [
    `M${cx} ${cy - r}`,
    `C${cx} ${cy - c} ${cx + c} ${cy} ${cx + r} ${cy}`,
    `C${cx + c} ${cy} ${cx} ${cy + c} ${cx} ${cy + r}`,
    `C${cx} ${cy + c} ${cx - c} ${cy} ${cx - r} ${cy}`,
    `C${cx - c} ${cy} ${cx} ${cy - c} ${cx} ${cy - r}`,
    "Z",
  ].join(" ");
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0" stop-color="#2b2440"/>
      <stop offset="0.55" stop-color="#5c3a6e"/>
      <stop offset="0.85" stop-color="#a04f86"/>
      <stop offset="1" stop-color="#d06a9a"/>
    </linearGradient>
    <linearGradient id="star" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#fff4fb"/>
      <stop offset="0.45" stop-color="#ffb3dd"/>
      <stop offset="1" stop-color="#ff79c6"/>
    </linearGradient>
    <linearGradient id="flare" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffb3dd" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#fff4fb" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#ffb3dd" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="vig" cx="0.5" cy="0.5" r="0.72">
      <stop offset="0.72" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.32"/>
    </radialGradient>
    <filter id="soft" x="-60%" y="-400%" width="220%" height="900%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="blur8" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="blur24" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="24"/></filter>
  </defs>

  <!-- 底：黄昏天空，不是砖 -->
  <rect width="512" height="512" rx="114" fill="url(#sky)"/>
  <rect x="1.5" y="1.5" width="509" height="509" rx="112.5" fill="none" stroke="#44475a" stroke-width="3" opacity="0.7"/>

  <!-- L：白色圆体，带柔投影，立在天色前 -->
  <path d="M158 128 L158 372 L330 372" fill="none" stroke="#1a1523" stroke-width="52" opacity="0.45"
        stroke-linecap="round" stroke-linejoin="round" filter="url(#blur8)" transform="translate(8,12)"/>
  <path d="M158 128 L158 372 L330 372" fill="none" stroke="#f8f2fa" stroke-width="46"
        stroke-linecap="round" stroke-linejoin="round" opacity="0.97"/>

  <!-- 主星：光晕两层 + 横向耀斑 -->
  <path d="${sparkle(322, 206, 128)}" fill="#fff4fb" opacity="0.55" filter="url(#blur24)"/>
  <path d="${sparkle(322, 206, 114)}" fill="url(#star)"/>
  <rect x="177" y="203" width="290" height="6" rx="3" fill="url(#flare)" filter="url(#soft)"/>

  <!-- 伴星：左上一点疏密变化 -->
  <path d="${sparkle(150, 92, 17)}" fill="#ffd6ee" opacity="0.75"/>

  <rect width="512" height="512" rx="114" fill="url(#vig)"/>
</svg>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    useContentSize: true,
    webPreferences: { offscreen: false, sandbox: true },
  });
  // overflow:hidden 是必须的——少了它，页面会为 512 的图在 512 的窗口里挂出滚动条，
  // 而 capturePage 连滚动条一起截，图标右下角会多出两条灰边。
  const page = `<!doctype html><html><head><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}svg{display:block}</style></head><body>${SVG}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  // 等一帧，确保滤镜与渐变都已经画完再截
  await new Promise((resolve) => setTimeout(resolve, 250));
  const shot = await win.capturePage();
  // HiDPI 屏上 capturePage 会按缩放出更大的图；统一压回 512 正方形
  const png = shot.getSize().width === SIZE ? shot : shot.resize({ width: SIZE, height: SIZE, quality: "best" });
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, png.toPNG());
  console.log(`icon -> ${OUT} (${png.getSize().width}x${png.getSize().height})`);
  win.destroy();
  app.quit();
});
