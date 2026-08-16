/**
 * 图标方向探索——一页六个方向的对比表（每格：512 砖缩放显示 + 16px 真实栅格放大样）。
 *
 * 产物进 scratchpad 不进仓库：这是给作者挑方向的评审材料，不是交付物。
 * 定稿后由 make-icon.mjs 出正式 icon.png。
 *
 *   npx electron scripts/make-icon-candidates.mjs <输出png路径>
 *
 * 六个方向共用同一套青色系与暗砖底：受众定位（爱好者译者+读者）已定，
 * 「工具的克制打底、日轻的轻盈做点缀」，此轮只比构图。
 */
import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OUT = process.argv[process.argv.length - 1];
const W = 1140, H = 840;

/** 四角星（与 make-icon.mjs 同一形） */
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

/**
 * 第二轮（2026-08-14 作者批示后重做）：
 * 1. 配色对齐软件实际生效的 Dracula 主题——底 #282a36、紫 #bd93f9、粉 #ff79c6。
 *    第一轮的青色系是设计稿历史版本的残影，应用里根本不长那样。
 * 2. 「符号贴暗砖」没有设计感——这轮每个方向都带一个真正的构图手法：
 *    双色分层 / 氛围场景 / 负空间 / 贯穿构图 / 出血裁切。
 */
function tile(prefix, body, bg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="${prefix}t" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#2c2e3d"/><stop offset="1" stop-color="#1c1d26"/>
    </linearGradient>
    <linearGradient id="${prefix}pu" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d8c5fc"/><stop offset="1" stop-color="#8a63d2"/>
    </linearGradient>
    <linearGradient id="${prefix}pk" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#fff4fb"/><stop offset="0.45" stop-color="#ffb3dd"/><stop offset="1" stop-color="#ff79c6"/>
    </linearGradient>
    <linearGradient id="${prefix}pp" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#bd93f9"/><stop offset="1" stop-color="#ff79c6"/>
    </linearGradient>
    <filter id="${prefix}g" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="13" result="b"/>
      <feColorMatrix in="b" type="matrix" result="t"
        values="0 0 0 0 1  0 0 0 0 0.55  0 0 0 0 0.83  0 0 0 0.5 0"/>
      <feMerge><feMergeNode in="t"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  ${bg ?? `<rect width="512" height="512" rx="114" fill="url(#${prefix}t)"/>`}
  <rect x="1.5" y="1.5" width="509" height="509" rx="112.5" fill="none" stroke="#44475a" stroke-width="3" opacity="0.7"/>
  ${body}
</svg>`;
}

/**
 * 第四轮（作者批示「都不够好看」，锁定 A 与「轻」两方向）：不换构图，上工艺——
 * 光晕、玻璃高光、投影、星芒耀斑、氛围底。每个变体一个明确的打磨主张。
 */
const SERIF = `'Source Han Serif SC','Noto Serif SC','SimSun',serif`;

/** 星芒耀斑：过星心的一道横向细光 */
function flare(cx, cy, len, prefix) {
  return `<rect x="${cx - len / 2}" y="${cy - 3}" width="${len}" height="6" rx="3"
    fill="url(#${prefix}fl)" filter="url(#${prefix}soft)"/>`;
}

const CRAFT_DEFS = (p) => `
  <radialGradient id="${p}haze" cx="0.62" cy="0.38" r="0.65">
    <stop offset="0" stop-color="#bd93f9" stop-opacity="0.26"/>
    <stop offset="0.6" stop-color="#8a63d2" stop-opacity="0.1"/>
    <stop offset="1" stop-color="#8a63d2" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="${p}vig" cx="0.5" cy="0.5" r="0.72">
    <stop offset="0.72" stop-color="#000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity="0.32"/>
  </radialGradient>
  <linearGradient id="${p}fl" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#ffb3dd" stop-opacity="0"/>
    <stop offset="0.5" stop-color="#fff4fb" stop-opacity="0.85"/>
    <stop offset="1" stop-color="#ffb3dd" stop-opacity="0"/>
  </linearGradient>
  <filter id="${p}soft" x="-60%" y="-400%" width="220%" height="900%"><feGaussianBlur stdDeviation="4"/></filter>
  <filter id="${p}blur8" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="8"/></filter>
  <filter id="${p}blur24" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="24"/></filter>`;

const CANDIDATES = [
  {
    key: "A1", label: "A1 · 玻璃光管（高光+投影+耀斑）",
    svg: tile("a1", `${CRAFT_DEFS("a1")}
      <rect width="512" height="512" rx="114" fill="url(#a1haze)"/>
      <path d="M158 128 L158 372 L330 372" fill="none" stroke="#0e0f16" stroke-width="50" opacity="0.6"
            stroke-linecap="round" stroke-linejoin="round" filter="url(#a1blur8)" transform="translate(9,13)"/>
      <path d="M158 128 L158 372 L330 372" fill="none" stroke="url(#a1pu)" stroke-width="46"
            stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M158 132 L158 368" fill="none" stroke="#ffffff" stroke-width="9" opacity="0.32"
            stroke-linecap="round" transform="translate(-8,-4)"/>
      <path d="${sparkle(322, 206, 128)}" fill="#ff79c6" opacity="0.55" filter="url(#a1blur24)"/>
      <path d="${sparkle(322, 206, 116)}" fill="url(#a1pk)"/>
      ${flare(322, 206, 300, "a1")}
      <path d="${sparkle(150, 92, 18)}" fill="#d8c5fc" opacity="0.7"/>
      <rect width="512" height="512" rx="114" fill="url(#a1vig)"/>`),
  },
  {
    key: "A2", label: "A2 · 光在字后（星被 L 遮挡的纵深）",
    svg: tile("a2", `${CRAFT_DEFS("a2")}
      <rect width="512" height="512" rx="114" fill="url(#a2haze)"/>
      <path d="${sparkle(298, 244, 150)}" fill="#ff79c6" opacity="0.5" filter="url(#a2blur24)"/>
      <path d="${sparkle(298, 244, 136)}" fill="url(#a2pk)"/>
      ${flare(298, 244, 340, "a2")}
      <path d="M158 128 L158 372 L330 372" fill="none" stroke="#0e0f16" stroke-width="52" opacity="0.5"
            stroke-linecap="round" stroke-linejoin="round" filter="url(#a2blur8)" transform="translate(6,10)"/>
      <path d="M158 128 L158 372 L330 372" fill="none" stroke="url(#a2pu)" stroke-width="46"
            stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M166 140 L166 300" fill="none" stroke="#ffd6ee" stroke-width="8" opacity="0.5"
            stroke-linecap="round" transform="translate(14,0)"/>
      <path d="${sparkle(130, 108, 16)}" fill="#d8c5fc" opacity="0.6"/>
      <rect width="512" height="512" rx="114" fill="url(#a2vig)"/>`),
  },
  {
    key: "A3", label: "A3 · 黄昏底 L+星（A 构图 × 氛围天空）",
    svg: tile("a3", `${CRAFT_DEFS("a3")}
      <path d="M158 128 L158 372 L330 372" fill="none" stroke="#1a1523" stroke-width="52" opacity="0.45"
            stroke-linecap="round" stroke-linejoin="round" filter="url(#a3blur8)" transform="translate(8,12)"/>
      <path d="M158 128 L158 372 L330 372" fill="none" stroke="#f8f2fa" stroke-width="46"
            stroke-linecap="round" stroke-linejoin="round" opacity="0.97"/>
      <path d="${sparkle(322, 206, 128)}" fill="#fff4fb" opacity="0.55" filter="url(#a3blur24)"/>
      <path d="${sparkle(322, 206, 114)}" fill="url(#a3pk)"/>
      ${flare(322, 206, 290, "a3")}
      <path d="${sparkle(150, 92, 17)}" fill="#ffd6ee" opacity="0.75"/>
      <rect width="512" height="512" rx="114" fill="url(#a3vig)"/>`,
      `<linearGradient id="a3sky" x1="0" y1="0" x2="0.2" y2="1">
        <stop offset="0" stop-color="#2b2440"/><stop offset="0.55" stop-color="#5c3a6e"/>
        <stop offset="0.85" stop-color="#a04f86"/><stop offset="1" stop-color="#d06a9a"/>
      </linearGradient>
      <rect width="512" height="512" rx="114" fill="url(#a3sky)"/>`),
  },
  {
    key: "E1", label: "E1 · 明朝体「轻」出血（书封气质）",
    svg: tile("e1", `${CRAFT_DEFS("e1")}
      <rect width="512" height="512" rx="114" fill="url(#e1haze)"/>
      <text x="298" y="322" text-anchor="middle" dominant-baseline="middle" font-family="${SERIF}"
            font-size="420" fill="#0e0f16" opacity="0.55" filter="url(#e1blur8)" transform="translate(8,12)">轻</text>
      <text x="298" y="322" text-anchor="middle" dominant-baseline="middle" font-family="${SERIF}"
            font-size="420" fill="url(#e1pp)">轻</text>
      <path d="${sparkle(112, 112, 40)}" fill="#ff79c6" opacity="0.5" filter="url(#e1blur24)"/>
      <path d="${sparkle(112, 112, 36)}" fill="url(#e1pk)"/>
      <path d="${sparkle(170, 176, 11)}" fill="#d8c5fc" opacity="0.5"/>
      <rect width="512" height="512" rx="114" fill="url(#e1vig)"/>`),
  },
  {
    key: "E2", label: "E2 · 月晕「轻」（背光居中）",
    svg: tile("e2", `${CRAFT_DEFS("e2")}
      <circle cx="256" cy="248" r="190" fill="url(#e2haze)"/>
      <circle cx="256" cy="248" r="140" fill="#bd93f9" opacity="0.16" filter="url(#e2blur24)"/>
      <text x="256" y="262" text-anchor="middle" dominant-baseline="middle" font-family="${SERIF}"
            font-size="272" fill="url(#e2pp)">轻</text>
      <path d="${sparkle(388, 116, 30)}" fill="url(#e2pk)"/>
      <path d="${sparkle(118, 356, 14)}" fill="#d8c5fc" opacity="0.55"/>
      <rect width="512" height="512" rx="114" fill="url(#e2vig)"/>`),
  },
  {
    key: "E3", label: "E3 · 黄昏底「轻」（配色即氛围）",
    svg: tile("e3", `${CRAFT_DEFS("e3")}
      <text x="286" y="310" text-anchor="middle" dominant-baseline="middle" font-family="${SERIF}"
            font-size="400" fill="#0e0f16" opacity="0.5" filter="url(#e3blur8)" transform="translate(7,11)">轻</text>
      <text x="286" y="310" text-anchor="middle" dominant-baseline="middle" font-family="${SERIF}"
            font-size="400" fill="#f8f2fa" opacity="0.96">轻</text>
      <path d="${sparkle(122, 120, 34)}" fill="#fff4fb" opacity="0.95"/>
      <path d="${sparkle(184, 74, 13)}" fill="#ffd6ee" opacity="0.6"/>
      <rect width="512" height="512" rx="114" fill="url(#e3vig)"/>`,
      `<linearGradient id="e3sky" x1="0" y1="0" x2="0.2" y2="1">
        <stop offset="0" stop-color="#2b2440"/><stop offset="0.55" stop-color="#5c3a6e"/>
        <stop offset="0.85" stop-color="#a04f86"/><stop offset="1" stop-color="#d06a9a"/>
      </linearGradient>
      <rect width="512" height="512" rx="114" fill="url(#e3sky)"/>`),
  },
];

const cells = CANDIDATES.map((c) => `
  <div class="cell">
    <div class="preview">${c.svg.replace('width="512" height="512"', 'width="216" height="216"')}</div>
    <div class="small"><canvas class="px" data-idx="${CANDIDATES.indexOf(c)}" width="96" height="96"></canvas><span>16px</span></div>
    <div class="label">${c.label}</div>
  </div>`).join("");

const PAGE = `<!doctype html><html><head><style>
  html,body{margin:0;padding:0;background:#eceff1;font-family:'Microsoft YaHei',sans-serif}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:16px;box-sizing:border-box;width:${W}px}
  .cell{background:#fff;border-radius:10px;padding:12px;display:flex;flex-direction:column;align-items:center;gap:8px}
  .small{display:flex;align-items:center;gap:8px;color:#666;font-size:11px}
  .px{image-rendering:pixelated;border:1px solid #ddd}
  .label{font-size:13px;color:#222}
</style></head><body><div class="grid">${cells}</div>
<script>
  const svgs = ${JSON.stringify(CANDIDATES.map((c) => c.svg))};
  let done = 0;
  svgs.forEach((svg, i) => {
    const img = new Image();
    img.onload = () => {
      const tiny = document.createElement('canvas'); tiny.width = 16; tiny.height = 16;
      tiny.getContext('2d').drawImage(img, 0, 0, 16, 16);
      const big = document.querySelector('.px[data-idx="' + i + '"]');
      const ctx = big.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tiny, 0, 0, 96, 96);
      if (++done === svgs.length) document.title = 'READY';
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
</script></body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false, frame: false, useContentSize: true });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  // 等 16px 栅格画完（页面画完把 title 改成 READY）
  for (let i = 0; i < 40 && win.webContents.getTitle() !== "READY"; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300));
  const shot = await win.capturePage();
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, shot.toPNG());
  console.log(`sheet -> ${OUT}`);
  win.destroy();
  app.quit();
});
