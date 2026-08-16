import { access, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const documentUrl = pathToFileURL(resolve(appRoot, "wiring/electron-wiring.html")).href;
const profile = resolve(appRoot, ".tmp/wiring-profile");
const chromeCandidates = [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
  process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, "Microsoft/Edge/Application/msedge.exe"),
].filter(Boolean);

async function findExecutable() {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error("Set CHROME_PATH to Chrome or Edge to run wiring verification");
}

function reservePort(start) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(start, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : start;
      server.close(() => resolvePort(port));
    });
  });
}

async function findPort(start) {
  for (let port = start; port < start + 40; port += 1) {
    try {
      return await reservePort(port);
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("No open port available for wiring verification");
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitFor(url, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Browser is still starting.
    }
    await wait(100);
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

async function removeWithRetry(path, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await wait(250);
    }
  }
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
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
    this.socket?.close();
  }
}

const browserPath = await findExecutable();
const debugPort = await findPort(9258);
await removeWithRetry(profile);
const browser = spawn(browserPath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

let cdp;
const exceptions = [];
const consoleErrors = [];

try {
  await waitFor(`http://127.0.0.1:${debugPort}/json/version`);
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" }).then((response) => response.json());
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  cdp.on("Runtime.exceptionThrown", (params) => exceptions.push(params));
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error") consoleErrors.push(params);
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.navigate", { url: documentUrl });
  await wait(500);

  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed";
      throw new Error(`${detail} [${expression}]`);
    }
    return result.result?.value;
  };
  const assert = async (expression, message) => {
    if (!(await evaluate(expression))) throw new Error(message);
  };
  const click = async (selector, text) => {
    const point = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const element = ${text === undefined
        ? "nodes[0]"
        : `nodes.find((node) => node.textContent.includes(${JSON.stringify(text)}))`};
      if (!element) throw new Error("No clickable element: " + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!point) throw new Error(`Could not locate ${selector}`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    await wait(120);
  };

  await assert("document.querySelector('.lanes') !== null", "wiring lanes did not mount");
  await assert("document.querySelectorAll('.lane').length === 6", "layer lanes are incomplete");
  await assert("document.querySelectorAll('#channels [data-channel]').length === 3", "channel catalog is incomplete");
  await assert("document.querySelectorAll('#commands [data-command]').length === 15", "command catalog is incomplete");
  await assert("document.querySelectorAll('#tickets [data-ticket]').length === 34", "ticket catalog is incomplete");

  await click("#channels [data-channel]", "lightee:invoke");
  await assert("document.querySelector('#detail h2')?.textContent === 'lightee:invoke'", "channel click did not open channel detail");
  await assert("document.querySelector('#detail')?.textContent.includes('renderer → preload → main')", "channel direction is missing");

  await click("#commands [data-command]", "chapter.saveDraft");
  await assert("document.querySelector('#detail h2')?.textContent === 'chapter.saveDraft'", "command click did not open command detail");
  await assert("document.querySelector('#detail')?.textContent.includes('IpcService application adapter')", "command backend endpoint is missing");

  await click("#tickets [data-ticket]", "#05");
  await assert("document.querySelector('#detail h2')?.textContent.includes('CodeMirror 6 + CJK IME prototype')", "ticket click did not open ticket detail");
  await assert("document.querySelector('#detail')?.textContent.includes('OS-level Windows IME popup was not invoked')", "ticket caveat is missing");

  await evaluate("document.querySelector('#reset').click()");
  await evaluate("(() => { const input = document.querySelector('#search'); input.value = 'chapter.saveDraft'; input.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await assert("document.querySelectorAll('#commands [data-command]').length === 1", "search filter did not narrow commands");
  await evaluate("document.querySelector('#reset').click()");
  await assert("document.querySelectorAll('#commands [data-command]').length === 15", "reset did not restore command catalog");

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: documentUrl });
  await wait(500);
  await assert("document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1", "wiring document overflows narrow viewport");

  if (exceptions.length > 0) throw new Error(`Runtime.exceptionThrown count: ${exceptions.length}`);
  if (consoleErrors.length > 0) throw new Error(`console error count: ${consoleErrors.length}`);
  console.log("Wiring document CDP verification passed");
} finally {
  cdp?.close();
  await stopProcess(browser);
  await wait(500);
  await removeWithRetry(profile);
}
