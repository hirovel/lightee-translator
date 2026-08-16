import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = resolve(appRoot, process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/electron/dist/electron");
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function reservePort(start) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(start, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === "object" && address ? address.port : start));
    });
  });
}

async function waitFor(url, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
  constructor(url) { this.socket = new WebSocket(url); this.id = 0; this.pending = new Map(); }
  async connect() {
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", rejectOpen, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

async function launch(profile, registryPath, port, fakeMode = "approved") {
  const child = spawn(electronPath, [appRoot, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
    cwd: appRoot,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, LIGHTEE_ALLOW_MULTI_INSTANCE: "1", LIGHTEE_DEV_SERVER_URL: "", LIGHTEE_FAKE_LLM: "1", LIGHTEE_FAKE_LLM_MODE: fakeMode, LIGHTEE_WORKSPACE_REGISTRY: registryPath, LIGHTEE_CONFIG_DIR: configDir },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  await waitFor(`http://127.0.0.1:${port}/json/version`).catch((error) => { throw new Error(`${error.message}\n${stderr}`); });
  const pages = await waitFor(`http://127.0.0.1:${port}/json`);
  const page = pages.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
  if (!page) throw new Error("Electron renderer target did not appear");
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  // 三处 launch 都要等就绪：后两处紧接着就 window.lightee.invoke，渲染层没起来时
  // 那是 undefined，报出来的会是一句和真正原因无关的 evaluate 异常。
  await waitUntil(cdp, "document.documentElement.dataset.rendererReady === 'true'")
    .catch(() => { throw new Error("renderer did not become ready"); });
  return { child, cdp };
}

/**
 * 轮询等一个页面内表达式变真（与 verify-release-ui.mjs 的 waitUntil 同款）。
 * 就绪不能用「睡够 700ms 再看一眼」来判：那测的是机器快慢，不是产品有没有起来。
 * windows runner 上冷启动比本地慢好几倍，一次性检查会把「还没起来」误报成「起不来」。
 */
async function waitUntil(cdp, expression, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }).catch(() => null);
    if (result?.result?.value) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") await new Promise((done) => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, done));
  else child.kill("SIGTERM");
  await sleep(500);
}

async function invoke(cdp, command, payload) {
  const expression = `window.lightee.invoke(${JSON.stringify(command)}, ${JSON.stringify(payload)})`;
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "IPC evaluate failed");
  return result.result?.value;
}

const profile = await mkdtemp(join(tmpdir(), "lightee-release-ipc-profile-"));
const workspace = await mkdtemp(join(tmpdir(), "lightee-release-ipc-workspace-"));
// 门禁不得读写用户真实的 ~/.lightee（models.json / auth.json）。
const configDir = await mkdtemp(join(tmpdir(), "lightee-release-ipc-config-"));
const registry = join(profile, "workspaces.json");
const sourcePath = join(workspace, "book.txt");
const source = "第1章 发布验收\n\nテスト本文を確認する。\n\n処理が完了した。\n";
let run;
let stuckRoot;
try {
  await writeFile(sourcePath, source, "utf8");
  run = await launch(profile, registry, await reservePort(9400));
  const { cdp } = run;

  const created = await invoke(cdp, "workspace.create", { path: workspace, name: "发布验收" });
  if (!created?.ok) throw new Error(`workspace.create failed: ${JSON.stringify(created)}`);
  const workspaceId = created.value.id;
  const imported = await invoke(cdp, "import.run", { workspaceId, sourcePath });
  if (!imported?.ok || imported.value.chapters !== 1) throw new Error(`import.run failed: ${JSON.stringify(imported)}`);

  // EX-07 / ADR-0007：导入即可翻——译前提取与逐项确认不再是翻译的前置步骤。
  // 这里断言的正是本批的核心承诺：一个刚导入、术语表全空的工作区能直接产出译文。
  const translated = await invoke(cdp, "translate.run", { workspaceId, chapterId: "ch001" });
  if (!translated?.ok || translated.value.workflowStatus !== "approved") throw new Error(`translate.run failed: ${JSON.stringify(translated)}`);

  // 译者在翻译途中登记的新词进确认队列 → 逐项确认（confirm.* 机制不变，只是入口换了）
  let listed = await invoke(cdp, "confirm.list", { workspaceId });
  while (listed?.ok && listed.value.status.status === "pending") {
    const index = listed.value.session?.index;
    const card = listed.value.cards?.[index];
    const candidate = card?.candidates?.[0];
    const chosenZh = typeof candidate === "string" ? candidate : candidate?.zh ?? card?.zh;
    const decided = await invoke(cdp, "confirm.decide", { workspaceId, action: "accept", chosenZh, expectedIndex: index });
    if (!decided?.ok) throw new Error(`confirm.decide failed: ${JSON.stringify(decided)}`);
    listed = await invoke(cdp, "confirm.list", { workspaceId });
  }
  if (!listed?.ok) throw new Error(`confirm.list failed: ${JSON.stringify(listed)}`);
  const loaded = await invoke(cdp, "chapter.load", { workspaceId, chapterId: "ch001" });
  if (!loaded?.ok || !loaded.value.paragraphs.some((paragraph) => paragraph.translation.trim())) throw new Error(`chapter.load has no translation: ${JSON.stringify(loaded)}`);

  // 迁移自 verify-flow-electron（RH-09 扩充处置）：真实进程内的状态机快照与事件链。
  // 不写死字面量链——断言状态机保证的不变式本身：起点 imported、终点 approved、
  // 每一跳的 from 必须等于上一跳的 to（审计链无断裂）。
  const stateSnapshot = JSON.parse(await readFile(join(workspace, "state", "chapter_state.json"), "utf8"));
  if (stateSnapshot.chapters?.ch001?.state !== "approved" || stateSnapshot.chapters.ch001.attempt !== 1) throw new Error(`approved 快照不正确：${JSON.stringify(stateSnapshot.chapters?.ch001)}`);
  const events = (await readFile(join(workspace, "state", "events.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (events[0]?.from !== "imported") throw new Error(`事件链起点应为 imported：${JSON.stringify(events[0])}`);
  if (events[events.length - 1]?.to !== "approved") throw new Error(`事件链终点应为 approved：${JSON.stringify(events[events.length - 1])}`);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].from !== events[index - 1].to) throw new Error(`事件链断裂于第 ${index} 跳：${events[index - 1].to} → ${events[index].from}`);
  }

  const reviewStarted = Date.now();
  const review = await invoke(cdp, "review.run", { workspaceId, chapterId: "ch001" });
  const reviewMs = Date.now() - reviewStarted;
  if (!review?.ok) throw new Error(`review.run failed: ${JSON.stringify(review)}`);
  const bookReview = await invoke(cdp, "bookReview.run", { workspaceId });
  if (!bookReview?.ok) throw new Error(`bookReview.run failed: ${JSON.stringify(bookReview)}`);
  const status = await invoke(cdp, "bookReview.status", { workspaceId });
  // RV-06：全书审校已降级为**只读建议**，三态 none | running | advisory，没有 approved 了。
  // 这条门禁一直写着 `!== "approved"`，RV-06 交付时漏改——它此前是绿的，只因为整条
  // 发布门禁在那之后没被跑过。断言改为：跑完必须是 advisory，且明细能被读出来
  // （明细曾被 IPC 裁掉、从未展示，那正是 RV 批要修的东西，不能再退回去）。
  if (!status?.ok || status.value.status !== "advisory") throw new Error(`bookReview.status failed: ${JSON.stringify(status)}`);
  if (!Array.isArray(status.value.issues)) throw new Error(`bookReview.status 缺少 issues 明细：${JSON.stringify(status.value)}`);
  if (typeof status.value.summary?.high !== "number") throw new Error(`bookReview.status 缺少 summary：${JSON.stringify(status.value)}`);
  const exportStarted = Date.now();
  const exported = await invoke(cdp, "export.run", { workspaceId, target: "all", format: "md" });
  const exportMs = Date.now() - exportStarted;
  if (!exported?.ok) throw new Error(`export.run failed: ${JSON.stringify(exported)}`);
  cdp.close();
  await stop(run.child);
  run = undefined;

  run = await launch(profile, registry, await reservePort(9410));
  const reopened = await invoke(run.cdp, "workspace.list", {});
  if (!reopened?.ok || !reopened.value.some((item) => item.id === workspaceId)) throw new Error("workspace did not survive restart");
  const restored = await invoke(run.cdp, "chapter.load", { workspaceId, chapterId: "ch001" });
  if (!restored?.ok || restored.value.workflow.state !== "approved" || !restored.value.paragraphs.some((paragraph) => paragraph.translation.trim())) throw new Error("approved translation did not survive restart");
  run.cdp.close();
  await stop(run.child);
  run = undefined;

  // ===== 迁移自 verify-desktop-release（RH-09 处置表）：熔断（stuck）路径 =====
  // 旧脚本用 `window.__lighteeEditorPrototype.keepApproved()` 驱动，那是原型期的
  // 挂载点，真实产品里已经不存在。这里改用真实 IPC + 状态机断言同一条路径。
  const stuckWorkspace = await mkdtemp(join(tmpdir(), "lightee-release-ipc-stuck-"));
  stuckRoot = stuckWorkspace;
  const stuckSource = join(stuckWorkspace, "book.txt");
  await writeFile(stuckSource, source, "utf8");
  run = await launch(profile, registry, await reservePort(9415), "stuck");
  const stuckCdp = run.cdp;
  const stuckCreated = await invoke(stuckCdp, "workspace.create", { path: stuckWorkspace, name: "熔断验收" });
  if (!stuckCreated?.ok) throw new Error(`stuck workspace.create failed: ${JSON.stringify(stuckCreated)}`);
  const stuckWorkspaceId = stuckCreated.value.id;
  const stuckImported = await invoke(stuckCdp, "import.run", { workspaceId: stuckWorkspaceId, sourcePath: stuckSource });
  if (!stuckImported?.ok) throw new Error(`stuck import.run failed: ${JSON.stringify(stuckImported)}`);
  // EX-07：熔断路径同样导入即可翻，不再先跑提取与确认。
  // fake LLM 的 stuck 模式永远返回未翻译的日文 → 审校每轮都判不合格 → 修复阶梯耗尽 → 熔断
  const stuckRun = await invoke(stuckCdp, "translate.run", { workspaceId: stuckWorkspaceId, chapterId: "ch001" });
  if (!stuckRun?.ok || stuckRun.value.workflowStatus !== "stuck") throw new Error(`熔断路径未到达 stuck：${JSON.stringify(stuckRun)}`);
  const stuckLoaded = await invoke(stuckCdp, "chapter.load", { workspaceId: stuckWorkspaceId, chapterId: "ch001" });
  const stuckState = stuckLoaded?.value?.workflow?.state;
  // 状态机允许两种熔断落点：显式 stuck，或 ready + lastError（翻译门禁两次失败）
  if (!(stuckState === "stuck" || (stuckState === "ready" && stuckLoaded.value.workflow.lastError))) throw new Error(`熔断后章节状态不对：${JSON.stringify(stuckLoaded?.value?.workflow)}`);
  const stuckAttempt = stuckLoaded.value.workflow.attempt;
  // 人工介入的真实出口：再次 translate.run = 重置后重新出发（attempt 必须递增，
  // 而不是被 conflict 拒绝）。旧脚本断言的 keepApproved 在真实产品里没有对应入口。
  const stuckRetry = await invoke(stuckCdp, "translate.run", { workspaceId: stuckWorkspaceId, chapterId: "ch001" });
  if (!stuckRetry?.ok) throw new Error(`熔断后重新发起翻译被拒绝：${JSON.stringify(stuckRetry)}`);
  const stuckRetried = await invoke(stuckCdp, "chapter.load", { workspaceId: stuckWorkspaceId, chapterId: "ch001" });
  if (!(stuckRetried?.value?.workflow?.attempt > stuckAttempt)) throw new Error(`熔断后重试未重置：attempt ${stuckAttempt} → ${stuckRetried?.value?.workflow?.attempt}`);

  // C-4：性能门槛执法（基准见 docs/release-acceptance-plan.md，CI 宽容系数见 LIGHTEE_GATE_TOLERANCE）。
  // fake LLM 下这两条路径不含真实推理，因此按「非 LLM 操作 < 1s」计。
  const tolerance = Number(process.env.LIGHTEE_GATE_TOLERANCE ?? (process.env.CI ? 3 : 1));
  const overBudget = [["reviewMs", reviewMs, 1_000], ["exportMs", exportMs, 1_000]]
    .filter(([, actual, budget]) => actual > budget * tolerance);
  if (overBudget.length) {
    throw new Error(`性能门槛超标（tolerance ×${tolerance}）：${overBudget.map(([key, actual, budget]) => `${key}=${actual}ms > ${budget * tolerance}ms`).join("; ")}`);
  }

  console.log(JSON.stringify({ ok: true, workspaceId, reviewMs, exportMs, perfToleranceX: tolerance, chapterCount: imported.value.chapters, translatedState: translated.value.workflowStatus, review: review.value, bookReview: status.value.status, export: exported.value, stuckState, stuckRetryAttempt: stuckRetried.value.workflow.attempt }, null, 2));
} finally {
  if (run) { run.cdp.close(); await stop(run.child); }
  await Promise.allSettled([rm(profile, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true }), rm(configDir, { recursive: true, force: true }), stuckRoot ? rm(stuckRoot, { recursive: true, force: true }) : Promise.resolve()]);
}
