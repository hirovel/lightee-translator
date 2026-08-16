/**
 * 忙碌卡演示台：把**真实录下来的**运行事件回放进**真实的渲染层**，逐帧截图。
 *
 * ## 为什么需要它
 *
 * 从前的截图脚本截的是静态页面——`vite preview` 里没有 `window.lightee`，
 * 于是 `bindAiEvents` 拿不到事件通道，忙碌卡（`.busy-card`）从头到尾是 `display:none`。
 * 结果就是：思考直播、正文直播、会话式时间轴、三个跳转按钮，**一次都没有被截图验证过**。
 * 它们只有单测（`run-transcript.test.ts` 的纯逻辑）和肉眼看过的真机，中间那层
 * 「DOM 画出来长什么样」是空的。要发布的东西不该有这种空白。
 *
 * 那批旧脚本（`verify-renderer` / `capture-visual-acceptance` / `capture-renderer`）
 * 已经清掉：前两个的选择器停留在 2026-08-03、长期红着且不在 `npm test` 里，
 * 第三个是空壳。**渲染层的截图验证现在只剩这一份，所以它必须保持绿。**
 *
 * ## 保真度：假的必须发出真的会发的东西
 *
 * 两条线都钉在真实数据上：
 *
 * 1. **事件形状**照 `ipc-service.ts` 的 `emit` 现场抄——`agent.thinking` 带
 *    `{label, attempt, thinking, delta, done}`，`agent.text` 带 `{label, paragraphId, delta, done}`，
 *    provenance 一并带上。形状对不上，截出来的图就只能证明"我编的事件能画出我编的界面"。
 * 2. **时序与体量**取自真实跑批 `runs/flow-1786584396492`（SSR26 ch001，deepseek-v4-pro，high）：
 *    轮 1 思考 25869 字 / 192129ms，轮 2 思考 236 字 / 1369ms，两块之间空 5149ms（工具轮），
 *    正文 125 段 / 2432 字 / 50 秒。下面 `PARAGRAPHS` 的每一对 `[相对毫秒, 字数]` 都是量出来的。
 *
 * **正文与思考的文字是中性占位，不是那本书的译文**——版权内容不进可分发的截图产物。
 * 要验证的是"多少字、什么时候到、画成什么样"，这三件事与文字内容无关。
 *
 * ## 时间压缩
 *
 * 真实一章 250 秒，截图脚本不能跑 250 秒。整条磁带按 `SPEED` 等比压缩：
 * **只压缩，不重排**——事件顺序与相对间隔保持原样，否则"工具轮空了 5 秒"这种
 * 要展示的现象就被我自己改掉了。
 *
 * 用法：node scripts/capture-busy-demo.mjs [--probe]
 *   --probe  只记录渲染层向 IPC 要了哪些命令，不回放、不截图（用来确定假 IPC 要答多少）
 */
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, findExecutable, findPort, removeProfile, sleep, stopProcess, waitFor } from "./lib/cdp.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(appRoot, ".artifacts/busy-demo");
const probeOnly = process.argv.includes("--probe");

/** 整条磁带的压缩倍率。真实 250s → 约 20s。 */
const SPEED = 12.5;

/**
 * 正文段落：`[相对毫秒, 字数]`，取自真实跑批的 125 段。
 * 字数是真的，字**不是**真的——回放时用中性占位文本填到这个长度。
 */
const PARAGRAPHS = [[200489,30],[200723,9],[201730,77],[201963,22],[202110,6],[202334,15],[202564,13],[202748,7],[203398,72],[203535,7],[203716,5],[203902,20],[204039,6],[204180,9],[204555,39],[204685,7],[204871,9],[205100,23],[205707,21],[206054,20],[206498,11],[206947,26],[207410,20],[207666,5],[207847,4],[208266,20],[208440,7],[208695,5],[208871,7],[209136,5],[209566,24],[210064,18],[210412,11],[210933,20],[211193,15],[212359,73],[213061,15],[214211,59],[214479,7],[214809,4],[215329,31],[215584,7],[215933,17],[216479,12],[216891,10],[217228,19],[217514,7],[217849,9],[218059,8],[218749,37],[219168,15],[219419,7],[219836,23],[220273,15],[220442,6],[220790,23],[221219,11],[221468,10],[221887,22],[222220,12],[222726,31],[223490,44],[224092,40],[224781,44],[225120,10],[225549,23],[226070,22],[226410,17],[226733,19],[227163,17],[227552,17],[227708,7],[228049,20],[228298,7],[228804,33],[229136,9],[229737,41],[230787,61],[231293,23],[231634,15],[232323,45],[232771,11],[232953,5],[233470,28],[233977,22],[234310,12],[235073,56],[235996,61],[236251,12],[236764,27],[237568,43],[237814,5],[238148,12],[238661,19],[239255,13],[240099,52],[240356,6],[240603,8],[241036,17],[241452,17],[241788,11],[242440,42],[242879,18],[243548,27],[243720,7],[244155,13],[244325,5],[244746,29],[244925,3],[245097,3],[245632,22],[246073,18],[246320,14],[246754,23],[247174,16],[247614,15],[247970,15],[248317,11],[248565,11],[248824,10],[249247,13],[249761,33],[250138,11],[250312,4],[250671,13]];

/** 真实两个思考块：[起, 止, 字数]。中间 193601→198750 的 5149ms 就是工具轮。 */
const THINK_BLOCKS = [[1472, 193601, 25869], [198750, 200119, 236]];

const TAIL_EVENTS = [
  [250691, "chapter.stateChanged", { from: "translating", to: "translated", reason: "translating -> translated" }],
  [250700, "chapter.stateChanged", { from: "translated", to: "reviewing", reason: "translated -> reviewing" }],
  [250700, "review.progress", { progress: 0, message: "开始审校" }],
  [250700, "agent.status", { agent: "reviewer", status: "running", message: "开始审校", operation: "review" }],
  [250719, "agent.status", { agent: "reviewer", status: "done", message: "0 个问题", operation: "review" }],
  [250731, "chapter.stateChanged", { from: "reviewing", to: "approved", reason: "reviewing -> approved" }],
  [250731, "agent.status", { agent: "reviewer", status: "done", message: "approved", operation: "review" }],
  [250733, "translate.progress", { progress: 1, message: "翻译与审校完成 · 2 次调用 · 输入 12.3k（命中缓存 11.0k） · 输出 15.1k · 250s" }],
  [250764, "agent.status", { agent: "terminologist", status: "done", message: "译者标注 3 项新术语待确认" }],
];

const browserPath = await findExecutable();
const previewPort = await findPort(4190);
const debugPort = await findPort(9270);
const profile = resolve(appRoot, ".tmp/busy-demo-profile");
// stdio 收着而不是丢掉：预览服务起不来时，`stdio:"ignore"` 会把唯一的线索扔了，
// 表现为「等端口超时」——那是症状，不是原因。
let previewLog = "";
const preview = spawn(process.execPath, [
  resolve(appRoot, "node_modules/vite/bin/vite.js"),
  "preview", "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort",
], { cwd: appRoot, stdio: ["ignore", "pipe", "pipe"] });
preview.stdout.on("data", (chunk) => { previewLog += chunk; });
preview.stderr.on("data", (chunk) => { previewLog += chunk; });
preview.on("exit", (code) => { previewLog += `\n[preview 退出 code=${code}]`; });
const chrome = spawn(browserPath, [
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "about:blank",
], { stdio: "ignore" });
let cdp;

/**
 * 装在页面上的假 `lightee`。
 *
 * 它必须**在文档脚本之前**装好（`Page.addScriptToEvaluateOnNewDocument`）——
 * `bindAiEvents` 只在启动时取一次 `window.lightee`，晚一步装就等于没装，
 * 而且不会报错，表现为"事件发了但界面纹丝不动"。
 */
const FAKE_LIGHTEE = `
(() => {
  const listeners = new Map();
  window.__calls = [];
  window.__stubs = {};
  window.lightee = {
    ping: () => "pong",
    getPendingDrop: () => ({ path: null, name: null }),
    invoke: async (command, payload) => {
      window.__calls.push({ command, payload });
      const stub = window.__stubs[command];
      if (typeof stub === "function") return stub(payload);
      if (stub !== undefined) return stub;
      return { ok: false, error: { code: "demo", message: "演示台无后端" } };
    },
    onEvent: (name, listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name)?.delete(listener);
    },
    flushPendingWrites: async () => ({ ok: true }),
    onWillClose: () => () => {},
    closeReady: () => {},
    windowAction: () => {},
  };
  // 回放入口：形状照 preload 的信封（version/type/payload），少一个字段都可能被过滤掉
  window.__fire = (type, payload) => {
    const envelope = { version: 1, type, payload };
    for (const listener of listeners.get(type) ?? []) {
      try { listener(envelope); } catch (error) { console.error("listener", type, error); }
    }
  };
})();
`;

/** 整条磁带的真实长度（最后一条尾事件） */
const TOTAL_MS = TAIL_EVENTS.at(-1)[0];

/** 等页面里的回放时钟走到磁带的某一刻。按**磁带时间**而不是墙上时间对齐截图。 */
async function waitTape(client, tapeMs) {
  const deadline = Date.now() + (TOTAL_MS / SPEED) + 15_000;
  while (Date.now() < deadline) {
    if (await client.evaluate(`(window.__tapeAt?.() ?? 0) >= ${tapeMs}`)) return;
    await sleep(80);
  }
  throw new Error(`回放没走到 ${tapeMs}ms`);
}

/**
 * 假 IPC 的作答面。**只有三个命令**——这是探针（`--probe`）量出来的，不是猜的：
 * 渲染层启动时只问 `workspace.list` / `workspace.session.read` / `ai.providers.list`。
 * 答完这三个它就进 main 视图，事件作用域（`acceptsWorkspaceEvent`）随之成立。
 *
 * 形状照 `ipc-contract.ts` 的 `WorkspaceInfo` / `WorkspaceSessionInfo` 填。
 */
const WORKSPACE_ID = "ws-demo";
const CHAPTER_ID = "ch001";
const STUBS = `
const DEMO_WS = {
  id: "${WORKSPACE_ID}", path: "D:\\\\轻小译\\\\演示工作区", name: "演示工作区",
  srcLang: "ja", tgtLang: "zh", openedAt: 1786584396492, status: "ready",
  volumes: [{ id: "v1", label: "第一卷", chapters: [
    { id: "${CHAPTER_ID}", title: "第一话", state: "translating" },
    { id: "ch002", title: "第二话", state: "imported" },
    { id: "ch003", title: "第三话", state: "imported" },
  ] }],
};
window.__errors = [];
addEventListener("error", (e) => window.__errors.push(String(e.message)));
window.__stubs["workspace.list"] = () => ({ ok: true, value: [DEMO_WS] });
window.__stubs["workspace.open"] = () => ({ ok: true, value: DEMO_WS });
window.__stubs["workspace.session.read"] = () => ({ ok: true, value: { workspaceId: "${WORKSPACE_ID}", chapterId: "${CHAPTER_ID}", savedAt: 1786584396492 } });
/* chapter.load 必须答上——它决定 activeChapterContent，而作用域门禁拿它当"当前章节"：
   不答的话 acceptsChapterEvent / acceptsAgentEvent（operation=translate）全部拒收，
   表现为「事件都发了，忙碌卡却始终不亮」。这不是产品缺陷——看不见的章节，
   它的进度本来就不该弹到你脸上；是演示台答漏了。
   （注：这段注释在模板字符串里，不能用反引号——会把字面量提前截断。） */
window.__stubs["chapter.load"] = () => ({ ok: true, value: {
  workspaceId: "${WORKSPACE_ID}", chapterId: "${CHAPTER_ID}", revision: 1,
  paragraphs: Array.from({ length: 125 }, (_, i) => ({
    id: "p" + String(i + 1).padStart(4, "0"),
    source: "（演示台占位原文 " + (i + 1) + "）",
    translation: "",
  })),
  sourceCorrection: null, hasApprovedTranslation: false,
  workflow: {
    chapterId: "${CHAPTER_ID}", state: "translating", version: 1, reviseCount: 0, attempt: 1,
    retryCount: 0, lastError: null, lastReason: null, lastActivityAt: null, userModified: false,
    recheckReason: null, runId: "demo-run", transitionCount: 2, everApproved: false,
  },
} });
window.__stubs["ai.providers.list"] = () => ({ ok: true, value: {
  providers: [{ id: "deepseek", name: "DeepSeek", hasKey: true, models: [{ id: "deepseek/deepseek-v4-pro", name: "deepseek-v4-pro", thinkingLevelMap: { high: "high" } }] }],
  current: "deepseek/deepseek-v4-pro", currentProvider: "deepseek", currentThinking: "high", reviewThinking: "high", termThinking: "high",
} });
`;

/**
 * 生成页面里的回放驱动。
 *
 * 事件形状逐字对着 `ipc-service.ts` 的 `emit(...)` 现场写：
 * - `agent.thinking` → `{label, attempt, thinking, delta, done?, workspaceId, chapterId, runId}`
 * - `agent.text`     → `{label, attempt, paragraphId, delta, done?, ...同上}`
 * 形状对不上，截出来的图只能证明"我编的事件能画出我编的界面"。
 *
 * **文字是中性占位**：要验证的是"多少字、什么时候到、画成什么样"，
 * 这三件事与文字内容无关，而版权正文不该进可分发的截图产物。
 */
function buildReplay() {
  const events = [];
  const prov = { workspaceId: WORKSPACE_ID, chapterId: CHAPTER_ID, runId: "demo-run" };
  const label = `translate:${CHAPTER_ID}`;

  // provenance 一条都不能漏：`chapter.stateChanged` 走 `acceptsWorkspaceEvent`，
  // 没有 workspaceId 就被静默丢弃——而它正是流水的开工信号，丢了它整条时间轴是空的。
  events.push([123, "translate.progress", { progress: 0, message: "开始翻译", ...prov }]);
  events.push([139, "chapter.stateChanged", { from: "imported", to: "ready", reason: "imported -> ready", ...prov }]);
  events.push([148, "chapter.stateChanged", { from: "ready", to: "translating", reason: "ready -> translating", ...prov }]);
  events.push([148, "agent.status", { agent: "translator", status: "running", message: "正在翻译这一章", operation: "translate", ...prov }]);

  // 思考块：按真实起止与总字数切片。攒批节奏照 ThinkingBuffer 的量级（每块几百字）。
  THINK_BLOCKS.forEach(([from, to, chars], index) => {
    const attempt = index + 1;
    const slices = Math.max(6, Math.min(40, Math.round(chars / 700)));
    for (let i = 0; i < slices; i += 1) {
      const at = Math.round(from + ((to - from) * (i + 1)) / slices);
      const size = Math.round(chars / slices);
      events.push([at, "agent.thinking", { label, attempt, thinking: "high", delta: filler(size, i), ...prov }]);
    }
    events.push([to, "agent.thinking", { label, attempt, thinking: "high", delta: "", done: true, ...prov }]);
  });

  PARAGRAPHS.forEach(([at, chars], index) => {
    const id = `p${String(index + 1).padStart(4, "0")}`;
    events.push([at, "agent.text", { label, attempt: 2, paragraphId: id, delta: filler(chars, index), ...prov }]);
  });
  events.push([PARAGRAPHS.at(-1)[0] + 5, "agent.text", { label, attempt: 2, paragraphId: `p0125`, delta: "", done: true, ...prov }]);

  for (const [at, type, payload] of TAIL_EVENTS) events.push([at, type, { ...payload, ...prov }]);
  events.sort((a, b) => a[0] - b[0]);

  return `(() => {
    const TAPE = ${JSON.stringify(events)};
    const SPEED = ${SPEED};
    let t0 = 0;
    window.__tapeAt = () => (t0 ? (performance.now() - t0) * SPEED : 0);
    window.__replay = () => {
      t0 = performance.now();
      for (const [at, type, payload] of TAPE) setTimeout(() => window.__fire(type, payload), at / SPEED);
    };
  })();`;
}

/** 中性占位文本。刻意不用那本书的任何一句——只需要长度对得上。 */
function filler(chars, seed) {
  const pool = "窗外的雨停了下来。她把伞收好，靠在门边听着走廊尽头传来的脚步声。那声音很轻，像是怕惊动谁。桌上的茶已经凉透，杯壁凝着一圈水痕。";
  let out = "";
  while (out.length < chars) out += pool.slice((seed * 7 + out.length) % pool.length) + pool;
  return out.slice(0, Math.max(1, chars));
}

try {
  await waitFor(`http://127.0.0.1:${previewPort}/`).catch((error) => {
    throw new Error(`${error.message}\n--- vite preview 输出 ---\n${previewLog || "(空)"}`);
  });
  await waitFor(`http://127.0.0.1:${debugPort}/json/version`);
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" }).then((r) => r.json());
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  // 两段必须一起、且都在文档脚本之前：`bindAiEvents` 启动时取一次 `window.lightee`，
  // stub 晚一步装上就等于工作区没答上来，页面停在欢迎页而不报错。
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: probeOnly ? FAKE_LIGHTEE : FAKE_LIGHTEE + STUBS });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${previewPort}/` });
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (await cdp.evaluate("document.documentElement.dataset.rendererReady === 'true'").catch(() => false)) break;
    await sleep(100);
  }
  await sleep(900);

  if (!probeOnly) {
    // 主页 → 工作台。忙碌卡的宿主节点只在工作台视图里渲染，停在主页就什么都截不到。
    await cdp.evaluate("document.getElementById('wc-last-enter')?.click()");
    const entered = Date.now();
    while (Date.now() - entered < 15_000) {
      if (await cdp.evaluate("Boolean(document.getElementById('busy-card'))").catch(() => false)) break;
      await sleep(120);
    }
    if (!(await cdp.evaluate("Boolean(document.getElementById('busy-card'))"))) {
      throw new Error(`没进到工作台（忙碌卡宿主节点不存在）。当前视图：${await cdp.evaluate("document.querySelector('[data-workbench-prototype]')?.dataset.view ?? '(无)'")}`);
    }
    await sleep(500);
    await cdp.evaluate(buildReplay());
  }

  if (probeOnly) {
    const calls = await cdp.evaluate("JSON.stringify(window.__calls.map((c) => c.command))");
    const counts = {};
    for (const c of JSON.parse(calls ?? "[]")) counts[c] = (counts[c] ?? 0) + 1;
    console.log("渲染层启动时向 IPC 要的命令：");
    for (const [command, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${command} ×${n}`);
    console.log(`\n共 ${Object.keys(counts).length} 个命令。`);
    console.log("lightee 是否装上：", await cdp.evaluate("typeof window.lightee"));
    console.log("__fire 是否可用：", await cdp.evaluate("typeof window.__fire"));
    console.log("busy-card 是否存在：", await cdp.evaluate("Boolean(document.getElementById('busy-card'))"));
    console.log("当前视图：", await cdp.evaluate("document.querySelector('[data-workbench-prototype]')?.dataset.view ?? '(无)'"));
  } else {
    await mkdir(outputDir, { recursive: true });
    const shots = [];
    const shoot = async (name, note) => {
      const png = await cdp.send("Page.captureScreenshot", { format: "png" });
      await writeFile(resolve(outputDir, name), Buffer.from(png.data, "base64"));
      // 章节头那格随帧记下来：它是「进度条 250 秒不动」的修复对象，
      // 只看末帧看不出它有没有动——所以逐帧留证。
      const cell = await cdp.evaluate(`(() => {
        const el = document.querySelector('#b-info .info-cell[data-key="translate"]');
        if (!el) return "(无翻译进度格)";
        return (el.textContent ?? "").replace(/\\s+/g, " ").trim();
      })()`).catch(() => "(读取失败)");
      shots.push({ name, note, 章节头进度格: cell });
      console.log(`  截图 ${name} —— ${note}`);
      console.log(`         章节头：${cell}`);
    };

    console.log(`回放开始（真实 ${(TOTAL_MS / 1000).toFixed(0)}s，按 ${SPEED}× 压缩为 ${(TOTAL_MS / SPEED / 1000).toFixed(0)}s）`);
    await cdp.evaluate("window.__replay()");

    // 采样点对着「这一格 UI 要证明什么」选，不是等距截图
    await waitTape(cdp, 2000); await shoot("01-思考直播.png", "轮1思考中：忙碌卡亮起，打字机尾巴在动");
    await cdp.evaluate("document.getElementById('busy-flow-head')?.click()");
    await waitTape(cdp, 12000); await shoot("02-时间轴展开.png", "运行流水展开：开始翻译 / 模型思考（累计字数在涨）");
    await waitTape(cdp, 199000); await shoot("03-工具轮交接.png", "两个思考块之间那 5149ms —— 标注为推定，不写成事实");
    await waitTape(cdp, 210000); await shoot("04-正文直播.png", "正文逐段到达：光流扫过刚写出的那一段");
    await waitTape(cdp, 240000); await shoot("05-正文过半.png", "正文写到后段，段号推进");
    // 「译文已写完但尚未定稿」这一态在磁带上只存在 15ms（250676→250691），压缩后抓不住，
    // 所以不去凑它；这一帧改验更该验的东西：**跳转按钮真的会跳**。
    await cdp.evaluate("document.querySelector('[data-busy-jump=\"agent\"]')?.click()");
    await sleep(500); await shoot("06-跳转Agent控制台.png", "点弹窗上的「Agent 控制台」：走既有 tab 按钮跳过去，不另建一套导航");
    await cdp.evaluate("document.getElementById('busy-think-head')?.click()");
    await sleep(400); await shoot("07-思考全文展开.png", "点开思考块：尾巴收起、全文可滚动（同一段不显示两遍）");
    await waitTape(cdp, TOTAL_MS + 200); await sleep(600);
    await shoot("08-定稿后收起.png", "approved 之后忙碌卡自行收起——不再占着屏幕说「正在工作」");

    const health = await cdp.evaluate(`JSON.stringify({
      卡片存在: Boolean(document.getElementById('busy-card')),
      卡片可见: document.getElementById('busy-card') ? getComputedStyle(document.getElementById('busy-card')).display : "(无此节点)",
      卡片类名: document.getElementById('busy-card')?.className ?? "(无)",
      秒表: document.getElementById('busy-time')?.textContent ?? "(无)",
      当前动作: document.getElementById('busy-what')?.textContent ?? "(无)",
      思考摘要: document.getElementById('busy-think-summary')?.textContent ?? "(无)",
      流水步数: document.querySelectorAll('#busy-flow-list .bf-step').length,
      流水摘要: document.getElementById('busy-flow-summary')?.textContent,
      正文标题: document.getElementById('busy-body-head')?.textContent,
      正文字数: document.getElementById('busy-body-text')?.textContent?.length ?? 0,
      跳转按钮: document.querySelectorAll('[data-busy-jump]').length,
      工具轮格: [...document.querySelectorAll('#busy-flow-list .bf-gap .bf-detail')].map((n) => n.textContent),
      控制台错误: window.__errors ?? [],
    })`);
    /**
     * 四个 tab 的**诚实降级**检查。
     *
     * 演示台的假 IPC 对绝大多数命令返回 `{ok:false}`——这正好是个现成的压力面：
     * 后端说「不」的时候，面板该显示看得懂的错误或空态，**不该白屏、不该炸、
     * 更不该显示一个编出来的零**（RV-01 那类假零是这个项目栽过的跟头）。
     *
     * 不编任何数据：要验的就是"没有数据时它说什么"。
     */
    const tabs = [
      ["bi", "正文编辑"],
      ["terms", "术语确认"],
      ["review", "审校"],
      ["agent", "Agent 控制台"],
    ];
    const degrade = [];
    for (const [key, label] of tabs) {
      const clicked = await cdp.evaluate(`Boolean(document.querySelector('[data-btab="${key}"]'))`);
      if (!clicked) { degrade.push({ tab: label, 结果: "找不到该 tab 按钮" }); continue; }
      await cdp.evaluate(`document.querySelector('[data-btab="${key}"]').click()`);
      await sleep(700);
      const state = await cdp.evaluate(`(() => {
        // 面板容器是 #bpanel（tui-prototype 的 renderPanel 往这里写）。
        // 第一版我写了 .bpanel.on / #b-body，两个都不存在，于是四个面板一律量成"空白"——
        // 而截图里明明有内容。**探针的 bug，不是产品的**。
        const panel = document.getElementById('bpanel');
        if (!panel) return JSON.stringify({ 有内容: false, 字数: 0, 开头: "(#bpanel 不存在)" });
        const text = (panel.textContent ?? "").replace(/\\s+/g, " ").trim();
        return JSON.stringify({ 有内容: text.length > 0, 字数: text.length, 开头: text.slice(0, 90) });
      })()`);
      await shoot(`tab-${key}.png`, `${label}：后端返回失败时的降级表现`);
      degrade.push({ tab: label, ...JSON.parse(state) });
    }
    console.log("\n四个面板的降级表现（后端一律 ok:false）：");
    for (const row of degrade) console.log(`  ${row.tab}｜${row.有内容 ? `${row.字数} 字` : "**空白**"}｜${row.开头 ?? row.结果 ?? ""}`);

    /**
     * 命令栏（RS-2 / D4、D5、D10、D12）。上一轮 tabs 循环最后停在 Agent 控制台，
     * 此刻命令栏应当已渲染。演示工作区的三章正好铺开三种态：
     * ch001 translating（禁勾）、ch002/ch003 imported（默认勾）——
     * 所以「范围 2 章」不是巧合，是 D4 默认勾选规则的直接证据。
     */
    await cdp.evaluate("document.querySelector('#agent-composer [data-ac=\"toggle\"]')?.click()");
    await sleep(400);
    await shoot("09-命令栏展开.png", "章节可选框展开：默认勾未译、翻译中禁勾、摘要行不编时长数字");
    // 勾选交互走真实 change 事件：取消一章 → 摘要行立即改口
    await cdp.evaluate(`(() => {
      const box = document.querySelector('#agent-composer input[data-cid="ch002"]');
      if (!box) return;
      box.checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await sleep(300);
    const composer = await cdp.evaluate(`JSON.stringify((() => {
      const root = document.getElementById('agent-composer');
      if (!root) return { 存在: false };
      const boxes = [...root.querySelectorAll('input[data-cid]')];
      return {
        存在: true,
        操作芯片: root.querySelector('.ac-op')?.textContent ?? "(无)",
        摘要行: root.querySelector('.ac-summary')?.textContent ?? "(无)",
        开始按钮: root.querySelector('[data-ac="run"]')?.textContent ?? "(无)",
        章节框数: boxes.length,
        勾选数: boxes.filter((b) => b.checked).length,
        禁勾数: boxes.filter((b) => b.disabled).length,
        徽标: [...root.querySelectorAll('.ac-ch-badge')].map((n) => n.textContent),
      };
    })())`);
    await shoot("10-命令栏勾选后.png", "取消勾选一章后摘要行立即改口（将翻译 1 章）");
    const composerState = JSON.parse(composer);
    console.log("\n命令栏自检：");
    console.log(JSON.stringify(composerState, null, 2));
    if (!composerState.存在 || composerState.章节框数 !== 3 || composerState.禁勾数 !== 1) {
      throw new Error("命令栏自检失败：结构与演示工作区的三章三态对不上");
    }
    if (/分钟|预计/.test(composerState.摘要行)) {
      throw new Error("命令栏摘要行出现了预估时长数字——违反 D10");
    }

    /**
     * 术语终审页（ADR-0008 / RS-2 两来源一队列）。上面的 tab-terms 截的是
     * 降级表现（后端 ok:false）；这里**运行时补装** confirm.list / terms.query 的
     * 桩再点一次术语 tab——两种表现都留证，谁也不顶掉谁。
     * provenance=author 的词条必须不出现在终审队列里（它已是作者定稿）。
     */
    await cdp.evaluate(`(() => {
      window.__stubs["confirm.list"] = () => ({ ok: true, value: {
        cards: [], session: null, revision: 3,
        status: { status: "pending", cardCount: 0, pendingCount: 0, confirmedCount: 0, updatedAt: Date.now(), extractionId: null },
      } });
      window.__stubs["terms.query"] = () => ({ ok: true, value: { nextCursor: null, revision: 7, items: [
        { id: "t1", archive: "names", ja: "アリス", zh: "爱丽丝", type: "person", provenance: "model" },
        { id: "t2", archive: "terms", ja: "魔導書", zh: "魔导书", provenance: "model" },
        { id: "t3", archive: "names", ja: "ボブ", zh: "鲍勃", provenance: "author" },
      ] } });
    })()`);
    await cdp.evaluate("document.querySelector('[data-btab=\"terms\"]').click()");
    await sleep(700);
    await shoot("11-术语终审页.png", "两来源一队列：模型暂定 2 条（author 定稿不进队列）· 确认/改译/拒绝");
    await cdp.evaluate("document.querySelector('[data-prov-edit=\"t1\"]')?.click()");
    await sleep(300);
    await shoot("12-终审行内改译.png", "改译走行内输入，不弹模态；提交即全书追溯改名");
    const review = JSON.parse(await cdp.evaluate(`JSON.stringify((() => {
      const rows = [...document.querySelectorAll('.tw-prov-row')];
      return {
        行数: rows.length,
        词条: rows.map((row) => (row.querySelector('.tw-prov-ja')?.textContent ?? "").trim().slice(0, 12)),
        含作者定稿: rows.some((row) => (row.textContent ?? "").includes("ボブ")),
        改译输入框: Boolean(document.querySelector('.tw-prov-input')),
        徽标: document.querySelector('[data-btab="terms"] .workflow-tab-badge')?.textContent ?? "(无)",
      };
    })())`));
    console.log("\n终审页自检：");
    console.log(JSON.stringify(review, null, 2));
    if (review.行数 !== 2 || review.含作者定稿 || !review.改译输入框) {
      throw new Error("终审页自检失败：队列应恰含 2 条模型暂定（作者定稿不进队列），改译应给行内输入框");
    }

    console.log("\n收尾自检：");
    console.log(JSON.stringify(JSON.parse(health), null, 2));
    /**
     * 产物自带的免责说明。
     *
     * 时间轴上的秒数读的是**墙上时钟**，而磁带被压缩了 12.5×——所以截图里的
     * 「间隔 432ms」对应真实的 5149ms。这不是缺陷，是压缩的必然代价；
     * 但截图会被单独拿去看，说明写在别处等于没写，所以钉进产物里。
     */
    const caveat = {
      时间压缩: `${SPEED}×`,
      影响: "时间轴与秒表显示的是压缩后的墙上时钟；真实时长 = 显示值 × " + SPEED,
      对照: { 工具轮真实间隔: "5149ms", 截图显示: "约 412ms", 全章真实历时: `${(TOTAL_MS / 1000).toFixed(0)}s` },
      文字: "正文与思考为中性占位文本；字数、段号、到达时刻取自真实跑批 flow-1786584396492",
      未失真的量: ["段落总数 125", "正文总字数 2432", "思考块数 2", "流水步数", "段号推进顺序"],
    };
    await writeFile(resolve(outputDir, "自检.json"), JSON.stringify({ shots, caveat, 降级表现: degrade, 命令栏: composerState, 终审页: review, health: JSON.parse(health) }, null, 2), "utf8");
    console.log(`\n时间压缩 ${SPEED}×：截图里的秒数需 ×${SPEED} 才是真实时长（字数与段数未失真）`);
    console.log(`\n产物目录：${outputDir}`);
  }
} finally {
  cdp?.close();
  await stopProcess(chrome);
  await stopProcess(preview);
  await removeProfile(profile);
}
