import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeCandidates = [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
  process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, "Microsoft/Edge/Application/msedge.exe"),
  process.env.PROGRAMFILES_X86 && resolve(process.env.PROGRAMFILES_X86, "Google/Chrome/Application/chrome.exe"),
].filter(Boolean);
let chromePath;
for (const candidate of chromeCandidates) {
  try {
    await import("node:fs/promises").then(({ access }) => access(candidate)).then(() => { chromePath = candidate; });
    if (chromePath) break;
  } catch {
    // Try the next installed browser.
  }
}
if (!chromePath) throw new Error("Set CHROME_PATH to Chrome or Edge to run workspace verification");

const profile = resolve(appRoot, ".tmp/workspace-profile");
const browser = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=9256",
  "--user-data-dir=" + profile,
  "about:blank",
], { stdio: "ignore" });
const preview = spawn(process.execPath, [resolve(appRoot, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", "4176"], {
  cwd: appRoot,
  stdio: "ignore",
});

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", rejectOpen, { once: true });
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitFor(url, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json().catch(() => null);
    } catch {
      // Service is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolveStop) => {
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolveStop());
    });
    return;
  }
  child.kill("SIGTERM");
}

async function removeWithRetry(path, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
}

const targetUrl = "http://127.0.0.1:4176/?prototype=workspaces";
let cdp;
const exceptions = [];
const consoleErrors = [];

try {
  await waitFor("http://127.0.0.1:4176/");
  await waitFor("http://127.0.0.1:9256/json/version");
  const target = await fetch(`http://127.0.0.1:9256/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" }).then((response) => response.json());
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  cdp.on("Runtime.exceptionThrown", (params) => exceptions.push(params));
  cdp.on("Runtime.consoleAPICalled", (params) => { if (params.type === "error") consoleErrors.push(params); });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");
  await new Promise((resolveWait) => setTimeout(resolveWait, 900));

  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed";
      throw new Error(`${detail} [${expression}]`);
    }
    return result.result?.value;
  };

  const assert = async (expression, message) => {
    if (!(await evaluate(expression))) throw new Error(message);
  };

  await assert("document.documentElement.dataset.rendererReady === 'true'", "workspace renderer did not boot");
  await assert("document.querySelector('#switcher')?.hidden === true", "prototype switcher was not hidden for the workspace route");
  await assert("document.querySelector('[data-ws-dialog]')?.hidden === true && getComputedStyle(document.querySelector('[data-ws-dialog]')).display === 'none'", "workspace dialog was visible on the welcome screen");
  await assert("document.querySelectorAll('[data-ws-card]').length === 3", "recent list did not render three workspaces");
  await assert("[...document.querySelectorAll('[data-ws-card] strong')].map((node) => node.textContent).join(',') === '雨中的天使,转生剑士,异世界咖啡馆'", "recent list is not sorted by most recent first");
  await assert("document.querySelector('[data-ws-resume-line]')?.textContent.includes('雨中的天使') && document.querySelector('[data-ws-resume-line]')?.textContent.includes('公园的相遇')", "resume section did not show the last session position");

  // Resume session: 继续 opens the last workspace and highlights the session chapter.
  await evaluate("document.querySelector('[data-ws-resume-btn]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  await assert("document.querySelector('[data-workspace-prototype]')?.dataset.view === 'main' && document.querySelector('.ws-chapter.current')?.dataset.wsChapter === 'ch002'", "resume did not open the last workspace at the session chapter");
  await evaluate("document.querySelector('[data-ws-back]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  await assert("document.querySelector('[data-workspace-prototype]')?.dataset.view === 'welcome'", "back did not return to the welcome view");

  // Directory dialog: validation, browse injection, create flow.
  await evaluate("document.querySelector('[data-ws-new]').click()");
  await assert("document.querySelector('[data-ws-dialog]')?.hidden === false && document.querySelector('[data-ws-dialog-title]')?.textContent === '新建工作区'", "create dialog did not open");
  await evaluate("document.querySelector('[data-ws-path]').value = 'C:/books/brand-new'; document.querySelector('input[data-ws-name]').value = '新书'; document.querySelector('[data-ws-dialog-confirm]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  await assert("document.querySelector('[data-workspace-prototype]')?.dataset.view === 'main' && document.querySelector('[data-ws-name]')?.textContent === '新书'", "create flow did not open the new workspace");
  await evaluate("document.querySelector('[data-ws-back]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  await assert("document.querySelectorAll('[data-ws-card]').length === 4 && document.querySelector('[data-ws-card] strong')?.textContent === '新书'", "created workspace did not appear first in recent list");
  await evaluate("document.querySelector('[data-ws-open]').click()");
  await evaluate("document.querySelector('[data-ws-dialog-confirm]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await assert("document.querySelector('[data-ws-dialog-error]')?.textContent !== '' && document.querySelector('[data-ws-dialog]')?.hidden === false", "open dialog accepted an empty path");
  await evaluate("window.__workspacePrototype.adapter.nextPickedPath = 'C:/books/picked'; document.querySelector('[data-ws-browse]').click()");;
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await assert("document.querySelector('[data-ws-path]')?.value === 'C:/books/picked'", "browse did not fill the picked directory");
  await evaluate("document.querySelector('[data-ws-dialog-confirm]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  await assert("document.querySelector('[data-workspace-prototype]')?.dataset.view === 'main' && document.querySelector('[data-ws-name]')?.textContent === 'picked'", "open flow did not load the picked directory");
  await evaluate("document.querySelector('[data-ws-back]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));

  // Escape closes the dialog.
  await evaluate("document.querySelector('[data-ws-new]').click()");
  await assert("document.querySelector('[data-ws-dialog]')?.hidden === false", "dialog did not reopen");
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await assert("document.querySelector('[data-ws-dialog]')?.hidden === true", "Escape did not close the dialog");

  // Open 雨中的天使 and exercise volumes/renames/session.
  await evaluate("[...document.querySelectorAll('[data-ws-card]')].find((card) => card.querySelector('strong').textContent === '雨中的天使').querySelector('[data-ws-open-card]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  await assert("document.querySelector('[data-workspace-prototype]')?.dataset.view === 'main' && document.querySelector('[data-ws-name]')?.textContent === '雨中的天使'", "recent card did not open the workspace");
  await assert("document.querySelectorAll('[data-ws-volume]').length === 2 && document.querySelectorAll('[data-ws-chapter]').length === 3 && document.querySelector('.ws-chapter.current')?.dataset.wsChapter === 'ch002'", "session volume did not auto-expand with the current chapter");
  await evaluate("document.querySelector('[data-ws-fold]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await assert("document.querySelectorAll('[data-ws-chapter]').length === 0", "volume fold did not collapse the chapters");
  await evaluate("document.querySelector('[data-ws-fold]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const foldProbe = await evaluate("({ chapters: document.querySelectorAll('[data-ws-chapter]').length, folds: [...document.querySelectorAll('[data-ws-fold]')].map((node) => node.textContent), volumes: document.querySelectorAll('[data-ws-volume]').length, tag: document.querySelector('.ws-vol-tag')?.textContent })");
  await assert("document.querySelectorAll('[data-ws-chapter]').length === 3 && document.querySelector('.ws-vol-tag')?.textContent === '[v01]'", `volume fold did not expand the chapters: ${JSON.stringify(foldProbe)}`);

  // Rename a chapter inline and verify persistence through the adapter.
  await evaluate("document.querySelector('[data-ws-rename-chapter=\"ch002\"]').click()");
  await assert("document.querySelector('[data-ws-rename-input]') !== null", "chapter rename input did not appear");
  await evaluate("(() => { const input = document.querySelector('[data-ws-rename-input]'); input.value = '初遇'; input.dispatchEvent(new Event('input')); document.querySelector('[data-ws-rename-save]').click(); })()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  await assert("[...document.querySelectorAll('[data-ws-chapter]')].some((node) => node.textContent.includes('初遇'))", "renamed chapter did not render");
  await assert("window.__workspacePrototype.adapter.list().then((list) => list.find((workspace) => workspace.id === 'ws-b001').volumes[0].chapters[1].title).then((title) => title === '初遇')", "chapter rename did not persist through the adapter");

  // Select a chapter: session is persisted.
  await evaluate("[...document.querySelectorAll('[data-ws-chapter]')].find((node) => node.textContent.includes('初遇')).click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  await assert("document.querySelector('.ws-chapter.current')?.textContent.includes('初遇') && document.querySelector('[data-ws-status]')?.textContent.includes('ch002')", "chapter selection did not update the current chapter");

  // Narrow viewport: no horizontal overflow.
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await assert("document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1", "workspace prototype overflows narrow viewport");

  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await mkdir(resolve(appRoot, ".artifacts"), { recursive: true });
  await writeFile(resolve(appRoot, ".artifacts/workspace-prototype.png"), Buffer.from(screenshot.data, "base64"));

  if (exceptions.length > 0) throw new Error(`Runtime.exceptionThrown count: ${exceptions.length}`);
  if (consoleErrors.length > 0) throw new Error(`console error count: ${consoleErrors.length}`);
  console.log("Workspace prototype CDP verification passed");
} finally {
  cdp?.close();
  await stopProcess(browser);
  await stopProcess(preview);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await removeWithRetry(profile);
}
