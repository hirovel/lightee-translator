import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = resolve(appRoot, process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/electron/dist/electron");
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
function reservePort(start) { return new Promise((resolvePort, reject) => { const server = createServer(); server.once("error", reject); server.listen(start, "127.0.0.1", () => { const address = server.address(); server.close(() => resolvePort(typeof address === "object" && address ? address.port : start)); }); }); }
async function waitFor(url, timeoutMs = 20_000) { const started = Date.now(); while (Date.now() - started < timeoutMs) { try { const response = await fetch(url); if (response.ok) return response.json(); } catch {} await sleep(100); } throw new Error(`Timed out waiting for ${url}`); }
class Cdp { constructor(url) { this.socket = new WebSocket(url); this.id = 0; this.pending = new Map(); this.exceptions = []; this.errors = []; } async connect() { this.socket.addEventListener("message", (event) => { const message = JSON.parse(String(event.data)); if (message.id) { const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result); } else if (message.method === "Runtime.exceptionThrown") this.exceptions.push(message.params); else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") this.errors.push(message.params); }); await new Promise((resolveOpen, rejectOpen) => { this.socket.addEventListener("open", resolveOpen, { once: true }); this.socket.addEventListener("error", rejectOpen, { once: true }); }); } async evaluate(expression) { const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed"); return result.result?.value; } send(method, params = {}) { const id = ++this.id; return new Promise((resolveSend, rejectSend) => { this.pending.set(id, { resolve: resolveSend, reject: rejectSend }); this.socket.send(JSON.stringify({ id, method, params })); }); } close() { this.socket.close(); } }
async function launch(profile, registry, port, fakeMode = "approved") { const child = spawn(electronPath, [appRoot, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { cwd: appRoot, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, LIGHTEE_ALLOW_MULTI_INSTANCE: "1", LIGHTEE_DEV_SERVER_URL: "", LIGHTEE_FAKE_LLM: "1", LIGHTEE_FAKE_LLM_MODE: fakeMode, LIGHTEE_WORKSPACE_REGISTRY: registry, LIGHTEE_CONFIG_DIR: configDir } }); await waitFor(`http://127.0.0.1:${port}/json/version`); const pages = await waitFor(`http://127.0.0.1:${port}/json`); const page = pages.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl); if (!page) throw new Error("renderer target missing"); const cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect(); await cdp.send("Runtime.enable"); await waitUntil(cdp, "document.documentElement.dataset.rendererReady === 'true'"); return { child, cdp }; }
async function waitForExit(child, timeoutMs = 30_000) { const started = Date.now(); while (Date.now() - started < timeoutMs) { if (child.exitCode !== null || child.signalCode !== null) return; await sleep(100); } throw new Error("Electron 进程在关窗后未退出（关窗排空可能挂起）"); }
async function stop(child) { if (!child?.pid || child.exitCode !== null) return; if (process.platform === "win32") await new Promise((done) => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, done)); else child.kill("SIGTERM"); await sleep(500); }
async function waitUntil(cdp, expression, timeoutMs = 20_000) { const started = Date.now(); while (Date.now() - started < timeoutMs) { if (await cdp.evaluate(expression).catch(() => false)) return; await sleep(100); } throw new Error(`Timed out waiting for ${expression}`); }
// 挂载不变式（specs/release-hardening.md §2 导航不变式 / §5 条目 1-4）：
// 正文 tab 下 #chapter-editor-host 内必须恰好有一个存活编辑器。空壳 div 不是合法状态。
const MOUNT_COUNT = "document.querySelectorAll('#chapter-editor-host .cm-editor').length";
async function assertEditorMounted(cdp, label) {
  try { await waitUntil(cdp, `${MOUNT_COUNT} === 1`, 8_000); }
  catch { throw new Error(`挂载不变式违反（${label}）：期望 1 个 .cm-editor，实际 ${await cdp.evaluate(MOUNT_COUNT).catch(() => "?")}`); }
  await sleep(400); // 渲染后可能被后续异步流程销毁 → 静置再确认一次
  const settled = await cdp.evaluate(MOUNT_COUNT);
  if (settled !== 1) throw new Error(`挂载不变式违反（${label}，静置后）：实际 ${settled}`);
}
async function clickChapter(cdp, chapterId) {
  const selector = chapterId ? `#chapter-list .item[data-cid="${chapterId}"]` : "#chapter-list .item[data-cid]";
  const clicked = await cdp.evaluate(`(() => { const el = document.querySelector('${selector}'); if (!el) return false; el.click(); return true; })()`);
  if (!clicked) throw new Error(`章节条目不存在：${selector}`);
}
/**
 * 性能门槛执法（RH-21 / C-4）。基准来自 docs/release-acceptance-plan.md：
 * 非 LLM 操作不得出现超过 1 秒的无反馈卡顿；翻译完成后正文刷新不得超过 2 秒。
 *
 * `LIGHTEE_GATE_TOLERANCE`（CI 默认 3）：CI runner 比开发机慢得多，用固定宽容系数
 * 而不是直接放宽门槛——门槛写的是产品承诺，系数写的是环境差异，两者不能混成一个数。
 */
const TOLERANCE = Number(process.env.LIGHTEE_GATE_TOLERANCE ?? (process.env.CI ? 3 : 1));
const PERF_BUDGET_MS = {
  startupMs: 8_000,            // 冷启动到 rendererReady（含 Electron 自身启动）
  createWorkspaceMs: 1_000,    // 非 LLM 操作
  importMs: 1_000,             // 非 LLM 操作
  tabSwitchMs: 1_000,          // 非 LLM 操作
  translationRefreshMs: 2_000, // 翻译完成 → 正文出现译文
  inFlightLoadMs: 1_500,       // RH-15：长任务进行中读命令必须秒回
};
const perf = {};
function budgetFailures() {
  return Object.entries(PERF_BUDGET_MS)
    .filter(([key]) => typeof perf[key] === "number")
    .map(([key, budget]) => ({ key, actual: perf[key], limit: budget * TOLERANCE }))
    .filter((row) => row.actual > row.limit);
}
async function timed(key, fn) { const started = Date.now(); const value = await fn(); perf[key] = Date.now() - started; return value; }

const profile = await mkdtemp(join(tmpdir(), "lightee-release-ui-profile-")); const workspace = await mkdtemp(join(tmpdir(), "lightee-release-ui-workspace-")); const registry = join(profile, "workspaces.json");
// 门禁写真实密钥（RH-17），必须隔离到临时配置目录——绝不碰用户的 ~/.lightee/auth.json。
const configDir = await mkdtemp(join(tmpdir(), "lightee-release-ui-config-")); let run;
try {
  const sourcePath = join(workspace, "ui.txt"); await writeFile(sourcePath, "第1章 UI 验收\n\nテスト本文を確認する。\n", "utf8");
  const startupStarted = Date.now();
  run = await launch(profile, registry, await reservePort(9420)); const { cdp } = run;
  await waitUntil(cdp, "document.documentElement.dataset.rendererReady === 'true'");
  perf.startupMs = Date.now() - startupStarted;
  if (!(await cdp.evaluate("document.querySelector('#stage') !== null"))) throw new Error("#stage missing");

  // ===== 从 verify-desktop-release / verify-electron 迁移来的独有覆盖（RH-09 处置表）=====
  // 这些断言不是新需求，是搬家：旧脚本删除后它们必须仍有归属。
  if (!(await cdp.evaluate("location.protocol === 'file:'"))) throw new Error("Electron 未加载生产 file:// 入口");
  // 安全边界：renderer 必须完全没有 Node 全局（contextIsolation + sandbox 的实证）
  if (!(await cdp.evaluate("typeof process === 'undefined' && typeof require === 'undefined'"))) throw new Error("renderer 暴露了 Node 全局");
  if (!(await cdp.evaluate("document.querySelector('.terminal') !== null"))) throw new Error("设计外壳 .terminal 缺失");
  if (!(await cdp.evaluate("document.querySelector('[data-window-minimize]') !== null && document.querySelector('[data-window-maximize]') !== null && document.querySelector('[data-window-close]') !== null"))) throw new Error("窗口控件三键未挂载");
  if (!(await cdp.evaluate("typeof window.lightee?.windowAction === 'function'"))) throw new Error("窗口控制 IPC 桥缺失");
  if ((await cdp.evaluate("window.lightee?.ping()")) !== "pong") throw new Error("preload 桥无响应");
  if (!(await cdp.evaluate("typeof window.lightee?.invoke === 'function' && typeof window.lightee?.onEvent === 'function'"))) throw new Error("类型化 IPC 桥不完整");
  // 事件订阅：workspace.create 之后必须真的收到 workspace.changed（下面 create 时校验）
  await cdp.evaluate("window.__ipcEvents = []; window.__unsubscribe = window.lightee.onEvent('workspace.changed', (event) => window.__ipcEvents.push(event)); true");
  const created = await timed("createWorkspaceMs", () => cdp.evaluate(`window.lightee.invoke("workspace.create", ${JSON.stringify({ path: workspace, name: "UI 发布验收" })})`)); if (!created?.ok) throw new Error(`workspace.create failed: ${JSON.stringify(created)}`);
  const workspaceId = created.value.id;
  // 迁移自 verify-electron：renderer 的事件订阅必须真的收到 workspace.changed
  await waitUntil(cdp, "window.__ipcEvents.some((event) => event.type === 'workspace.changed' && event.payload.action === 'created')", 8_000);
  if (!(await cdp.evaluate("window.lightee.flushPendingWrites().then((r) => Boolean(r?.ok))"))) throw new Error("flushPendingWrites 桥不可用");
  // 注意：这里必须是真实换行。写成 "\\n" 会让整章塌成一个以 `#` 开头的段落，
  // 门禁就不再覆盖「标题 + 正文」的真实章节形态（RH-05 排查时发现的既有 fixture 缺陷）。
  const imported = await timed("importMs", () => cdp.evaluate(`window.lightee.invoke("import.text", ${JSON.stringify({ workspaceId, text: "第1章 UI 验收\n\nテスト本文を確認する。\n" })})`)); if (!imported?.ok) throw new Error(`import.text failed: ${JSON.stringify(imported)}`);
  await cdp.evaluate("window.__lighteeWorkspaceBridge?.refreshDashboard?.()"); await sleep(300);
  await waitUntil(cdp, "document.querySelector('.wc-row[data-ws-quick]') !== null");
  await cdp.evaluate("document.querySelector('.wc-row[data-ws-quick]')?.click()");
  await waitUntil(cdp, "document.querySelector('#chapter-list .item[data-cid]') !== null");
  await clickChapter(cdp);
  await waitUntil(cdp, "document.querySelector('#chapter-editor-host') !== null");
  // DEF-01 回归（单章工作区，此时 fixture 只有 ch001）：首次点击 → 重复点击同一章节，编辑器都必须在。
  await assertEditorMounted(cdp, "首次点击章节");
  await clickChapter(cdp);
  await assertEditorMounted(cdp, "重复点击同一章节（单章工作区）");
  const before = Date.now();
  // EX-07 / ADR-0007：导入即可翻。翻译在前，确认队列由译者发现的新词填充。
  const confirmAllTerms = async () => {
    let current = await cdp.evaluate(`window.lightee.invoke("confirm.list", ${JSON.stringify({ workspaceId })})`);
    while (current?.ok && current.value.status.status === "pending") {
      const index = current.value.session.index;
      const card = current.value.cards[index];
      const candidate = card?.candidates?.[0];
      const chosenZh = typeof candidate === "string" ? candidate : candidate?.zh ?? card?.zh;
      const decided = await cdp.evaluate(`window.lightee.invoke("confirm.decide", ${JSON.stringify({ workspaceId, action: "accept", chosenZh, expectedIndex: index })})`);
      if (!decided?.ok) throw new Error(`confirm.decide failed: ${JSON.stringify(decided)}`);
      current = await cdp.evaluate(`window.lightee.invoke("confirm.list", ${JSON.stringify({ workspaceId })})`);
    }
  };
  const translated = await cdp.evaluate(`window.lightee.invoke("translate.run", ${JSON.stringify({ workspaceId, chapterId: "ch001" })})`); if (!translated?.ok || translated.value.workflowStatus !== "approved") throw new Error(`translate.run failed: ${JSON.stringify(translated)}`);
  await confirmAllTerms();
  await waitUntil(cdp, "document.querySelector('#chapter-editor-host')?.textContent.includes('稳定的中文译文')", 5_000);
  const elapsedMs = Date.now() - before;
  perf.translationRefreshMs = elapsedMs;
  await timed("tabSwitchMs", async () => {
    await cdp.evaluate("document.querySelector('[data-btab=\"terms\"]')?.click()");
    await waitUntil(cdp, "document.querySelector('[data-btab=\"terms\"]')?.classList.contains('on') === true", 5_000);
  });
  await cdp.evaluate("document.querySelector('[data-btab=\"bi\"]')?.click()");
  await waitUntil(cdp, `${MOUNT_COUNT} === 1`, 10_000);
  const tabs = await cdp.evaluate("[...document.querySelectorAll('[data-btab]')].map((tab) => tab.dataset.btab)");
  if (!tabs.includes("terms") || !tabs.includes("review") || !tabs.includes("bi")) throw new Error(`workflow tabs missing: ${JSON.stringify(tabs)}`);
  // Regression: add a later chapter after terminology is already confirmed, translate it, and reload its real editor.
  const secondImport = await cdp.evaluate(`window.lightee.invoke("import.text", ${JSON.stringify({ workspaceId, text: "第2章 追加章节\n\n追加章节の本文を確認する。\n" })})`);
  if (!secondImport?.ok) throw new Error(`second import failed: ${JSON.stringify(secondImport)}`);
  await sleep(350);
  await waitUntil(cdp, "document.querySelectorAll('#chapter-list .item[data-cid]').length >= 2");
  const secondChapterId = await cdp.evaluate("document.querySelectorAll('#chapter-list .item[data-cid]')[1]?.getAttribute('data-cid')");
  if (!secondChapterId) throw new Error("second imported chapter id missing");
  await clickChapter(cdp, secondChapterId);
  await waitUntil(cdp, "document.querySelector('#chapter-editor-host') !== null");
  await assertEditorMounted(cdp, "切换到第二章");
  // 切到另一章再切回：两侧都必须保持挂载（spec §5 条目 3）
  await clickChapter(cdp, "ch001");
  await assertEditorMounted(cdp, "切回第一章");
  await clickChapter(cdp, secondChapterId);
  await assertEditorMounted(cdp, "再次切到第二章");
  // EX-07：导入新章节仍使术语状态失效（面板不该谎称「已完成扫描」），
  // 但它**不再挡住翻译**——让一个展示状态否决核心能力正是这一批要根除的失效模式。
  const staleAfterImport = await cdp.evaluate(`window.lightee.invoke("confirm.list", ${JSON.stringify({ workspaceId })})`);
  if (staleAfterImport?.value?.status?.status === "confirmed") throw new Error("导入新章节后术语状态仍是 confirmed —— 面板会谎称已扫描完");

  const secondTranslated = await cdp.evaluate(`window.lightee.invoke("translate.run", ${JSON.stringify({ workspaceId, chapterId: secondChapterId })})`);
  if (!secondTranslated?.ok || secondTranslated.value.workflowStatus !== "approved") throw new Error(`second translate failed: ${JSON.stringify(secondTranslated)}`);
  await waitUntil(cdp, "document.querySelector('#chapter-editor-host')?.textContent.includes('稳定的中文译文')", 5_000);
  const secondEditorText = await cdp.evaluate("document.querySelector('#chapter-editor-host')?.textContent || ''");
  if (!secondEditorText.includes("稳定的中文译文")) throw new Error("newly added chapter editor is empty after translation");
  // Regression: deleting the active chapter must invalidate its editor snapshot and select the remaining chapter.
  const workspaceInfo = await cdp.evaluate(`window.lightee.invoke("workspace.list", {})`);
  const volumeId = workspaceInfo?.ok ? workspaceInfo.value.find((item) => item.id === workspaceId)?.volumes?.find((volume) => volume.chapters.some((chapter) => chapter.id === secondChapterId))?.id : undefined;
  if (!volumeId) throw new Error("second chapter volume missing");
  const deleted = await cdp.evaluate(`window.lightee.invoke("chapter.delete", ${JSON.stringify({ workspaceId, volumeId, chapterId: secondChapterId })})`);
  if (!deleted?.ok) throw new Error(`second chapter delete failed: ${JSON.stringify(deleted)}`);
  await waitUntil(cdp, "document.querySelectorAll('#chapter-list .item[data-cid]').length === 1");
  await waitUntil(cdp, "document.querySelector('.continuous-editor-foot strong')?.textContent === 'ch001'");
  await assertEditorMounted(cdp, "删除当前章节后自动打开剩余章节");
  // RH-05 / M-8 回归：单字符正文段（「…」）是真实原文，必须渲染编辑器而不是空原文引导。
  const shortImport = await cdp.evaluate(`window.lightee.invoke("import.text", ${JSON.stringify({ workspaceId, text: "第3章 单字符正文\n\n…\n" })})`);
  if (!shortImport?.ok) throw new Error(`short-body import failed: ${JSON.stringify(shortImport)}`);
  await sleep(350);
  await waitUntil(cdp, "document.querySelectorAll('#chapter-list .item[data-cid]').length >= 2");
  const shortChapterId = await cdp.evaluate("[...document.querySelectorAll('#chapter-list .item[data-cid]')].pop()?.getAttribute('data-cid')");
  if (!shortChapterId) throw new Error("short-body chapter id missing");
  await clickChapter(cdp, shortChapterId);
  await assertEditorMounted(cdp, "单字符正文章节（不得退化为空原文引导）");
  const termStatus = await cdp.evaluate(`window.lightee.invoke("confirm.list", ${JSON.stringify({ workspaceId })})`);
  const badgeText = await cdp.evaluate("document.querySelector('[data-btab=terms] .workflow-tab-badge')?.textContent || ''");
  // 术语是三态：未提取 / 待确认 N / 已确认。此前这里写死「pending 0 ⇒ ✓」，
  // 于是刚导入新章节（术语随之失效、pending 归零）时门禁也期望 ✓——把两态假设固化进了门禁。
  // 「没有待确认项」不等于「已完成」：零值在这里有两种截然不同的含义。
  const termStatusName = termStatus?.ok ? (termStatus.value.status.status ?? "not-extracted") : "not-extracted";
  const termPending = termStatus?.ok ? (termStatus.value.status.pendingCount ?? 0) : 0;
  const expectedBadge = termPending > 0 ? String(termPending) : termStatusName === "confirmed" ? "✓" : "–";
  if (badgeText !== expectedBadge) throw new Error(`terminology badge stale: expected ${expectedBadge}, got ${badgeText}（status=${termStatusName}, pending=${termPending}）`);
  if (cdp.exceptions.length) throw new Error(`runtime exceptions: ${cdp.exceptions.length} ${JSON.stringify(cdp.exceptions.slice(0, 3))}`);

  // ===== RH-12：renderer DOM 所有权 Stage 1 =====
  // AC 1：正常路径下护栏必须**零触发**。它是安全网，不是常规路径——触发即说明某条控制流
  // 停在了销毁会话处而没有走回渲染入口，那条路径才是缺陷。
  const tripsBefore = await cdp.evaluate("window.__lighteeInvariantTrips ?? []");
  if (tripsBefore.length) throw new Error(`RH-12 失败：正常操作路径触发了挂载护栏 ${JSON.stringify(tripsBefore)}`);

  // `#main-act-btn` 所有权（RH-12 scope 追加）：bridge 独占，且文案必须反映章节真实状态。
  // 缺陷形态：ui-shell-runtime 的 syncWorkflowUI 按 demo 的 chapterPhase 把文案覆盖回
  //「先处理术语」——术语明明已确认，主按钮却停在 demo 文案上，RH-16 的「⏹ 停止」也因此不可达。
  const mainActOwner = await cdp.evaluate("document.getElementById('main-act-btn')?.dataset.owner || ''");
  if (mainActOwner !== "bridge") throw new Error(`RH-12 失败：#main-act-btn 未被 bridge 接管（owner=${mainActOwner}）`);
  // demo 会重新调用 syncWorkflowUI；让位是无条件的，所以触发一次后文案仍必须是 bridge 写的。
  await cdp.evaluate("window.syncWorkflowUI?.()");
  const mainActText = await cdp.evaluate("document.getElementById('main-act-btn')?.textContent || ''");
  if (mainActText === "先处理术语") throw new Error("RH-12 失败：syncWorkflowUI 把 #main-act-btn 覆盖回了 demo 文案");

  // ===== demo 数据泄漏（2026-08-10 用户实测报告的一整类） =====
  // 症状：术语待确认恒为 5、术语表显示设计稿词条、右上角 token 自己往上涨。
  // 根因：ui-shell-runtime 的 demo 常量（PENDING_CARDS 5 条 / TERMS / SIM 模拟器）
  // 在真实工作区里继续作画，盖掉 bridge 从 IPC 读来的真实值。
  // 这里断言的是**结果**而不是实现：真实工作区里这些位置不得出现 demo 的指纹值。
  const demoLeak = await cdp.evaluate(`(() => {
    const out = [];
    const t = (sel) => document.querySelector(sel)?.textContent?.trim() ?? "";
    // PENDING_CARDS 恒为 5 条：术语待确认在只有 1 章的门禁工作区里绝不该是 5
    const badge = t('[data-btab="terms"] .workflow-tab-badge');
    if (badge === "5") out.push("terms badge=5（PENDING_CARDS 泄漏）");
    if (t("#terms-pending-mini").includes("待确认 5")) out.push("terms-pending-mini=待确认 5");
    // demo 词条指纹已无从谈起：外壳的 TERMS/PENDING_CARDS 清空成了纯框架（2026-08-15），
    // 设计稿里不再存在任何可能漏进真实应用的词条。改为断言 demo 结构本身是空的——
    // 谁往骨架里塞回演示词条，这里立刻响。（这段跑在页面里，直接读页面全局）
    const pendingLeak = typeof PENDING_CARDS !== "undefined" ? PENDING_CARDS.length : 0;
    const termsLeak = typeof TERMS !== "undefined" ? TERMS.length : 0;
    if (pendingLeak || termsLeak) out.push("外壳演示数据不再是空的（PENDING_CARDS " + pendingLeak + " / TERMS " + termsLeak + " 条）——纯框架被破坏");
    return out;
  })()`);
  if (demoLeak.length) throw new Error(`demo 数据泄漏进真实工作区：${JSON.stringify(demoLeak)}`);
  // SIM 模拟器：真实应用里必须完全停摆。取两次 token，中间等 2.5s（模拟器周期 < 2s）。
  const tokenBefore = await cdp.evaluate('document.getElementById("sys-token")?.textContent ?? ""');
  await sleep(2500);
  const tokenAfter = await cdp.evaluate('document.getElementById("sys-token")?.textContent ?? ""');
  if (tokenBefore !== tokenAfter) throw new Error(`SIM 模拟器仍在真实应用里跑：token ${tokenBefore} → ${tokenAfter}`);

  // ===== 标题栏右上角：真实状态 + 可操作（2026-08-10 用户报告「显示的也不是真实状态」） =====
  // 缺陷形态：那格最后一段写死「在线」，不读任何状态、永远绿灯——密钥没配也说在线。
  // 这里断言的同样是结果：不许出现无依据的「在线」，且模型名必须来自工作区真实配置。
  const titlebar = await cdp.evaluate(`(() => {
    const host = document.getElementById("bar-status");
    return {
      state: host?.dataset.state ?? "",
      model: document.getElementById("tb-model-name")?.textContent?.trim() ?? "",
      conn: document.getElementById("tb-conn")?.textContent?.trim() ?? "",
      clickable: !!document.getElementById("tb-model"),
      menuItems: document.querySelectorAll("#tb-menu [data-ref]").length,
      settingsEntry: !!document.querySelector("#tb-menu [data-ai-settings]"),
    };
  })()`);
  if (titlebar.conn === "在线") throw new Error("标题栏仍在无依据地显示「在线」（写死的假状态）");
  if (titlebar.conn === "读取中…" || titlebar.state === "") throw new Error(`标题栏未被 bridge 填充真实状态：${JSON.stringify(titlebar)}`);
  if (!titlebar.clickable || !titlebar.settingsEntry) throw new Error(`标题栏模型指示不可操作：${JSON.stringify(titlebar)}`);
  // 门禁工作区用 fake LLM，从未成功调用过任何真实模型 → 绝不允许出现「连接正常」
  if (titlebar.state === "ok") throw new Error(`没有任何成功调用，标题栏却报「连接正常」：${JSON.stringify(titlebar)}`);
  // 菜单必须来自真实 models.json；一条都没有说明 bridge 没接上
  if (titlebar.menuItems === 0) throw new Error("标题栏模型菜单为空：未从真实服务商配置构建");
  // AC 2：人为注入违规 → 护栏必须恢复出编辑器。
  // 注入方式要挑 hook 自身判据**抓不到**的那一类，否则测的是旧分支不是护栏：
  // 直接清空 #bpanel 会让 `!host` 成立，hook 的既有分支就重建了，护栏根本不触发。
  // 这里把宿主整个搬出 #bpanel——`getElementById` 仍找得到（host 判据失效）、会话仍存活，
  // 但用户面前的面板已经没有编辑器了。这正是「会话挂在已脱离节点上」的真实形态。
  await cdp.evaluate("(() => { const holder = document.createElement('div'); holder.id = 'rh12-stolen'; holder.style.display = 'none'; document.body.appendChild(holder); holder.appendChild(document.getElementById('chapter-editor-host')); return true; })()");
  await cdp.evaluate("window.__lighteeRenderPanelHook?.()");
  await waitUntil(cdp, "document.querySelectorAll('#bpanel .cm-editor').length === 1", 10_000);
  await cdp.evaluate("document.getElementById('rh12-stolen')?.remove()");
  const tripsAfter = await cdp.evaluate("window.__lighteeInvariantTrips ?? []");
  if (tripsAfter.length !== 1) throw new Error(`RH-12 失败：注入违规后护栏应恰好记录 1 次，实际 ${JSON.stringify(tripsAfter)}`);
  const invariantGuard = tripsAfter[0];
  // 恢复完成后把观测点清零，避免污染后续断言。
  await cdp.evaluate("window.__lighteeInvariantTrips = []");

  const appConsoleErrors = cdp.errors.filter((entry) => {
    const text = entry.args?.map((arg) => arg.value ?? arg.description ?? "").join(" ") ?? "";
    return !text.includes("Electron sandboxed_renderer.bundle.js script failed to run") && !text.includes("binding.startupData");
  });
  if (appConsoleErrors.length) throw new Error(`console errors: ${appConsoleErrors.length} ${JSON.stringify(appConsoleErrors.slice(0, 3))}`);

  // RH-17 / A-4 回归（第一段）：真实 Electron 进程内保存密钥 → 磁盘上不得留明文。
  // 这里跑的是真的 safeStorage（Windows = DPAPI），不是测试里的假编解码器。
  const secretKey = `sk-gate-${Date.now()}`;
  const keyResult = await cdp.evaluate(`window.lightee.invoke("ai.key.write", { providerId: "deepseek", apiKey: ${JSON.stringify(secretKey)} })`);
  if (!keyResult?.ok) throw new Error(`ai.key.write 失败：${JSON.stringify(keyResult)}`);
  const authOnDisk = await readFile(join(configDir, "auth.json"), "utf8");
  if (authOnDisk.includes(secretKey)) throw new Error("RH-17 失败：auth.json 中仍是明文密钥");
  if (JSON.parse(authOnDisk).deepseek?.sealed !== "dpapi-v1") throw new Error(`RH-17 失败：auth.json 条目缺少加密标记 ${authOnDisk.slice(0, 200)}`);

  // RH-04 / DEF-04 回归：autosave 防抖是 1000ms，在防抖窗口内关窗，重启后编辑必须仍在。
  await clickChapter(cdp, "ch001");
  await assertEditorMounted(cdp, "关窗排空前打开 ch001");
  const marker = `排空标记${Date.now()}`;
  await cdp.evaluate("document.querySelector('#chapter-editor-host .cm-content')?.focus()");
  await cdp.send("Input.insertText", { text: marker });
  await waitUntil(cdp, `document.querySelector('#chapter-editor-host')?.textContent.includes(${JSON.stringify(marker)})`, 5_000);
  await cdp.evaluate("setTimeout(() => window.lightee.windowAction('close'), 250)");
  await waitForExit(run.child, 30_000);
  run.cdp.close();
  run = null;

  run = await launch(profile, registry, await reservePort(9421));
  await waitUntil(run.cdp, "document.documentElement.dataset.rendererReady === 'true'");
  const relisted = await run.cdp.evaluate(`window.lightee.invoke("workspace.list", {})`);
  if (!relisted?.ok) throw new Error(`workspace.list after restart failed: ${JSON.stringify(relisted)}`);
  const reloaded = await run.cdp.evaluate(`window.lightee.invoke("chapter.load", ${JSON.stringify({ workspaceId, chapterId: "ch001" })})`);
  if (!reloaded?.ok) throw new Error(`chapter.load after restart failed: ${JSON.stringify(reloaded)}`);
  const persisted = reloaded.value.paragraphs.some((paragraph) => paragraph.translation.includes(marker));
  if (!persisted) throw new Error(`关窗排空失败：重启后未找到关闭前 250ms 的编辑内容（${marker}）`);

  // RH-17 回归（第二段）：重启后仍能解密——密钥可用性不依赖进程内存中的明文。
  const providersAfterRestart = await run.cdp.evaluate(`window.lightee.invoke("ai.providers.list", ${JSON.stringify({ workspaceId })})`);
  const deepseekEntry = (providersAfterRestart?.value?.providers ?? []).find((provider) => provider.id === "deepseek");
  if (deepseekEntry?.hasKey !== true) throw new Error(`RH-17 失败：重启后密钥不可用 ${JSON.stringify(deepseekEntry)}`);

  // 握手超时兜底：renderer 无响应（这里用同步忙等阻塞主线程）时窗口仍必须销毁，不得永久挂起。
  const blockedCloseStarted = Date.now();
  await run.cdp.evaluate("setTimeout(() => { window.lightee.windowAction('close'); const end = Date.now() + 8000; while (Date.now() < end) {} }, 0)").catch(() => undefined);
  await waitForExit(run.child, 25_000);
  const blockedCloseMs = Date.now() - blockedCloseStarted;
  run.cdp.close();
  run = null;

  // RH-16 回归：挂起模式下点「⏹ 停止」→ 章节回 ready → 可以重新翻译。
  run = await launch(profile, registry, await reservePort(9422), "hang");
  await waitUntil(run.cdp, "document.documentElement.dataset.rendererReady === 'true'");
  await run.cdp.evaluate("window.__lighteeWorkspaceBridge?.refreshDashboard?.()"); await sleep(300);
  await waitUntil(run.cdp, "document.querySelector('.wc-row[data-ws-quick]') !== null");
  await run.cdp.evaluate("document.querySelector('.wc-row[data-ws-quick]')?.click()");
  await waitUntil(run.cdp, `document.querySelector('#chapter-list .item[data-cid="${shortChapterId}"]') !== null`);
  await clickChapter(run.cdp, shortChapterId);
  // EX-07：术语状态不再是 translate.run 的前置条件，hang 段直接开翻。
  // 注：不通过 footer 主按钮驱动，直接打 IPC——这里验证的是取消通道本身在真实 Electron
  // 进程内的行为。（`#main-act-btn` 的 demo 文案覆盖缺陷已由 RH-12 修复并在上面单独断言。）
  // 注意：Cdp.evaluate 带 awaitPromise=true——表达式**不能**求值成 Promise，
  // 否则会一直等这次（故意挂起的）翻译，脚本自锁。这里立刻返回，结果另存到全局变量。
  await run.cdp.evaluate(`(() => { window.__rh16 = undefined; window.lightee.invoke("translate.run", ${JSON.stringify({ workspaceId, chapterId: shortChapterId })}).then((r) => { window.__rh16 = r; }); return true; })()`);
  // RH-15 之后翻译不再整段持有工作区锁，运行期间的读命令必须秒回。
  // （RH-15 之前这里会把门禁自己锁死——那正是 A-1 的可观测证据。）
  await sleep(1500);
  if (await run.cdp.evaluate("window.__rh16 !== undefined")) throw new Error("hang 模式下 translate.run 不应已经结束");
  const probeStarted = Date.now();
  const inFlightLoad = await run.cdp.evaluate(`window.lightee.invoke("chapter.load", ${JSON.stringify({ workspaceId, chapterId: shortChapterId })})`);
  const inFlightLoadMs = Date.now() - probeStarted;
  perf.inFlightLoadMs = inFlightLoadMs;
  if (!inFlightLoad?.ok) throw new Error(`翻译期间 chapter.load 失败：${JSON.stringify(inFlightLoad)}`);
  if (inFlightLoadMs > 1_500) throw new Error(`翻译期间 chapter.load 耗时 ${inFlightLoadMs}ms —— 工作区锁仍在拦读命令（RH-15 回归）`);
  const cancelResult = await run.cdp.evaluate(`window.lightee.invoke("translate.cancel", ${JSON.stringify({ workspaceId, chapterId: shortChapterId })})`);
  if (cancelResult?.value?.status !== "cancelling") throw new Error(`translate.cancel 未生效：${JSON.stringify(cancelResult)}`);
  // 取消后 run 不是立刻返回：管线的修复阶梯还要把剩余轮次空跑完（每轮被 proxy 立即拒绝），
  // 实测约 10 秒。RH-15 把 LLM 移出锁后这段会更短，但门禁不该卡在紧边界上。
  await waitUntil(run.cdp, "window.__rh16 !== undefined", 60_000);
  const cancelledRun = await run.cdp.evaluate("window.__rh16");
  if (cancelledRun?.ok || cancelledRun?.error?.details?.cancelled !== true) throw new Error(`取消后的 translate.run 应返回 cancelled：${JSON.stringify(cancelledRun)}`);
  const afterCancel = await run.cdp.evaluate(`window.lightee.invoke("chapter.load", ${JSON.stringify({ workspaceId, chapterId: shortChapterId })})`);
  if (afterCancel?.value?.workflow?.state !== "ready") throw new Error(`取消后章节状态应回到 ready，实际 ${JSON.stringify(afterCancel?.value?.workflow?.state)}`);

  // ===== 「模型 · 服务商」面板必须真的可编辑（2026-08-10 用户报告） =====
  // 缺陷形态：面板是「只读展示 + 只能新增」——API 类型只存在于「添加服务商」表单，已有服务商
  // 没有任何编辑入口；思考档位在模型没有 thinkingLevelMap 时被禁用成「能力未探测」，
  // 而任何界面都写不了那份 map。两者都只能手改 models.json。断言的是**可编辑性本身**。
  await run.cdp.evaluate("window.openAiSettings?.()");
  // 设置面默认是**快捷设置**：日常四行就够（服务商/模型/密钥/思考强度+测试连接）。
  // 把服务商与模型的管理面当默认设置面，对普通使用是负担。
  await waitUntil(run.cdp, 'document.querySelector("#ai-quick [data-q-provider]") !== null', 15_000);
  // `hidden` 属性只是把 UA 的 display:none 加上去，作者样式（.ai-md{display:grid}）能盖掉它。
  // 断言属性等于什么都没断言——曾经就是这样：属性为 true，详细面板照样占着位置，
  // 首屏挂一个空框、返回快捷也收不起来。这里一律按**真实可见性**判定。
  const VISIBLE = `((el) => !!el && el.getClientRects().length > 0)`;
  const aiQuick = await run.cdp.evaluate(`(() => {
    const visible = ${VISIBLE};
    const quick = document.getElementById("ai-quick");
    const think = quick?.querySelector("[data-q-think]");
    return {
      visible: visible(quick),
      advancedVisible: visible(document.getElementById("ai-advanced")),
      providers: quick?.querySelectorAll("[data-q-provider] option").length ?? 0,
      models: quick?.querySelectorAll("[data-q-model] option").length ?? 0,
      hasKeyInput: !!quick?.querySelector("[data-q-key]"),
      hasTest: !!quick?.querySelector("[data-q-test]"),
      thinkingOptions: think ? think.options.length : 0,
      thinkingDisabled: think ? think.disabled : null,
      toAdvanced: !!quick?.querySelector("[data-to-advanced]"),
      blocks: quick?.childElementCount ?? 0,
    };
  })()`);
  if (!aiQuick.visible) throw new Error(`设置面默认不是快捷设置：${JSON.stringify(aiQuick)}`);
  if (aiQuick.advancedVisible) throw new Error(`详细面板未真正收起（属性可能是 hidden，但仍占据布局）：${JSON.stringify(aiQuick)}`);
  if (!aiQuick.hasKeyInput || !aiQuick.hasTest || aiQuick.providers === 0 || aiQuick.models === 0) throw new Error(`快捷设置缺少日常必需项：${JSON.stringify(aiQuick)}`);
  // 快捷设置就该是快捷的：区块数失控说明详细内容又漏回默认面了
  if (aiQuick.blocks > 6) throw new Error(`快捷设置膨胀到 ${aiQuick.blocks} 个区块——详细内容应留在详细面板`);
  if (aiQuick.thinkingDisabled !== false) throw new Error(`快捷设置里的思考强度仍被禁用：${JSON.stringify(aiQuick)}`);
  if (!aiQuick.toAdvanced) throw new Error("快捷设置没有通往详细面板的入口");

  // ===== 翻译偏好：不许再有「只改文本、从不落盘」的假控件 =====
  // 审计发现这一格四行里三行是假的：引号策略/并发数只改文本；翻译指南甚至推一条
  // 「✓ 已保存（translation.guide）」然后把内容丢进内存变量。断言的是**真控件 + 真落盘**。
  const prefs = await run.cdp.evaluate(`(() => {
    const rows = document.getElementById("tp-rows");
    return {
      quoteIsSelect: rows?.querySelector("[data-tp-quote]")?.tagName ?? null,
      guideEntry: !!rows?.querySelector("[data-tp-guide]"),
      // 设置卡里不该再有只改文本的循环/开关处理器
      fakeHandlers: [...document.querySelectorAll("#wc-settings-card [onclick]")]
        .map((el) => el.getAttribute("onclick"))
        .filter((code) => /wcCycle|wcToggle/.test(code ?? "")).length,
    };
  })()`);
  if (prefs.quoteIsSelect !== "SELECT") throw new Error(`引号策略仍不是真控件：${JSON.stringify(prefs)}`);
  // EX-08：「全书上下文」这一行随全书概览能力一起退役，断言随之移除；
  // 其余三条（引号真控件 / 翻译指南入口 / 无假控件）不变。
  if (!prefs.guideEntry) throw new Error(`翻译偏好缺少真实控件：${JSON.stringify(prefs)}`);
  if (prefs.fakeHandlers !== 0) throw new Error(`设置卡里仍有 ${prefs.fakeHandlers} 个只改文本的假控件（wcCycle/wcToggle）`);
  // 真落盘：改引号策略后重读 settings，值必须变了
  await run.cdp.evaluate(`(() => { const s = document.querySelector("[data-tp-quote]"); s.value = "jp"; s.dispatchEvent(new Event("change")); })()`);
  await sleep(700);
  const quotePersisted = await run.cdp.evaluate(`window.lightee.invoke("settings.read", ${JSON.stringify({ workspaceId })})`);
  if (quotePersisted?.value?.values?.quoteStyle !== "jp") throw new Error(`引号策略未真正落盘：${JSON.stringify(quotePersisted?.value?.values?.quoteStyle)}`);

  // 展开详细面板后，服务商与模型必须真的可编辑
  await run.cdp.evaluate('document.querySelector("#ai-quick [data-to-advanced]").click()');
  await waitUntil(run.cdp, 'document.querySelectorAll("#ai-provider-list [data-provider]").length > 0', 15_000);
  await waitUntil(run.cdp, `(${VISIBLE})(document.getElementById("ai-advanced")) && !(${VISIBLE})(document.getElementById("ai-quick"))`, 8_000);
  // 窄窗口下测：上一版在门禁的默认宽度里「不裁剪」，用户在自己的窗口里照样被裁——
  // 布局只在够宽时才成立，等于没成立。这里把视口压窄再断言。
  await run.cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 760, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const aiPanel = await run.cdp.evaluate(`(() => {
    const detail = document.getElementById("ai-provider-detail");
    const preset = detail?.querySelector("[data-m-think]");
    const level = detail?.querySelector('[data-t-write="ai.thinking.write"]');
    return {
      providers: document.querySelectorAll("#ai-provider-list [data-provider]").length,
      canCreate: !!document.querySelector("#ai-provider-list [data-new-provider]"),
      apiOptions: [...(detail?.querySelectorAll("[data-p-api] option") ?? [])].map((option) => option.value),
      modelRows: detail?.querySelectorAll("[data-model]").length ?? 0,
      presetOptions: preset ? preset.options.length : 0,
      probeButtons: detail?.querySelectorAll("[data-m-probe]").length ?? 0,
      levelOptions: level ? level.options.length : 0,
      levelDisabled: level ? level.disabled : null,
      // 模型行最右的「×」被裁掉过：列宽全固定时总宽超出容器，而 .ai-models 为圆角裁剪
      // 设了 overflow:hidden，超出部分直接被切掉。按几何判定，不是按「元素存在」判定。
      clippedActions: (() => {
        const box = detail?.querySelector(".ai-models");
        if (!box) return null;
        const limit = box.getBoundingClientRect().right;
        return [...detail.querySelectorAll("[data-m-del]")]
          .filter((button) => button.getBoundingClientRect().right > limit + 0.5).length;
      })(),
    };
  })()`);
  if (aiPanel.providers === 0) throw new Error("服务商列表为空：面板未按真实 models.json 渲染");
  if (!aiPanel.canCreate) throw new Error("缺少「＋ 添加服务商」入口");
  for (const api of ["openai-responses", "openai-completions"]) {
    if (!aiPanel.apiOptions.includes(api)) throw new Error(`已有服务商无法修改 API 类型（缺 ${api}）：${JSON.stringify(aiPanel.apiOptions)}`);
  }
  if (aiPanel.modelRows === 0) throw new Error("模型表格为空：模型规格无处编辑");
  if (aiPanel.presetOptions < 4) throw new Error(`思考档位预设不可选：只有 ${aiPanel.presetOptions} 项`);
  if (aiPanel.probeButtons === 0) throw new Error("模型行缺少「探测」入口——那样思考档位又只能靠手填");
  // 门禁工作区的当前模型从未被探测过。此前这正是被禁用成「能力未探测」的那一格；
  // 运行时本就接受 off..high，锁死它是渲染层单方面比运行时更严。
  if (aiPanel.levelDisabled !== false) throw new Error(`未探测的模型思考档位仍被禁用——这正是用户报告的「思考强度锁定」：${JSON.stringify(aiPanel)}`);
  if (aiPanel.levelOptions < 3) throw new Error(`未探测模型的可选思考档位过少：${JSON.stringify(aiPanel)}`);
  if (aiPanel.clippedActions !== 0) throw new Error(`900px 视口下模型行右侧动作被容器裁掉：${aiPanel.clippedActions} 行的「×」超出 .ai-models 边界`);
  await run.cdp.send("Emulation.clearDeviceMetricsOverride");
  await sleep(300);

  // 返回快捷设置必须真的把详细面板收回去（用户报告：返回后原本的不会收起）
  await run.cdp.evaluate('document.querySelector("#ai-provider-detail [data-to-quick]").click()');
  await sleep(600);
  const afterBack = await run.cdp.evaluate(`(() => {
    const visible = ${VISIBLE};
    return { quick: visible(document.getElementById("ai-quick")), advanced: visible(document.getElementById("ai-advanced")) };
  })()`);
  if (!afterBack.quick || afterBack.advanced) throw new Error(`返回快捷设置后详细面板未收起：${JSON.stringify(afterBack)}`);

  // C-4：阈值执法。此前这些数字只被记录、从不被断言——「记录了但没人看」等于没有门槛。
  const overBudget = budgetFailures();
  if (overBudget.length) {
    throw new Error(`性能门槛超标（tolerance ×${TOLERANCE}）：${overBudget.map((row) => `${row.key}=${row.actual}ms > ${row.limit}ms`).join("; ")}`);
  }

  console.log(JSON.stringify({ ok: true, perf, perfToleranceX: TOLERANCE, workspaceId, translatedState: translated.value.workflowStatus, secondChapterState: secondTranslated.value.workflowStatus, editorContainsTranslation: true, secondChapterEditorContainsTranslation: true, activeChapterAfterDelete: "ch001", terminologyBadge: badgeText, translationRefreshMs: elapsedMs, closeDrainPersisted: true, blockedCloseMs, cancelReturnsToReady: true, keySealedOnDisk: true, keyUsableAfterRestart: true, inFlightLoadMs, invariantTripsOnHappyPath: 0, invariantGuard, mainActOwner, demoLeak: 0, simToken: tokenAfter, titlebar, aiQuick, aiPanel, tabs }, null, 2));
} finally { if (run) { run.cdp.close(); await stop(run.child); } await Promise.allSettled([rm(profile, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true }), rm(configDir, { recursive: true, force: true })]); }
