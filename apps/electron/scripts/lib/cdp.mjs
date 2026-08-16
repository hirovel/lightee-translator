/**
 * 无头浏览器驱动的公共件：找浏览器、占端口、等服务、CDP 客户端、收进程。
 *
 * ## 由来
 *
 * 这些东西原本在三个 capture 脚本里各抄了一遍，且已经开始**漂移**——同一个
 * "等端口"有三种超时，同一个"杀进程"有两种写法。截图脚本挂掉时最难查的就是这类
 * "看起来一样、实际不一样"的地方。抽出来之后那三个脚本被清掉了（见下），
 * 现在唯一的使用方是 `capture-busy-demo.mjs`。
 *
 * 留着它而不是内联回去，是因为它承载了两条**买来的教训**：`waitFor` 记录最后一次
 * 失败的 cause，`findPort` 跳过 Fetch 禁用端口。两条都是查一次要花很久的坑。
 *
 * ## 那三个脚本为什么没了
 *
 * `verify-renderer` / `capture-visual-acceptance` 的选择器停留在 2026-08-03，
 * 之后 UI 改过好几轮，两个都红着，而且不在 `npm test` 里，所以一直没人发现；
 * `capture-renderer` 是个空壳——启动 Chrome、打印一句"请用现有的 CDP 台子"、
 * 然后把浏览器杀掉，不验证任何东西。三个都是零覆盖，留着只会让人以为有覆盖。
 */
import { access, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { resolve } from "node:path";

const chromeCandidates = () => [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
  process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, "Microsoft/Edge/Application/msedge.exe"),
].filter(Boolean);

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function findExecutable() {
  for (const candidate of chromeCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 试下一个已安装的浏览器
    }
  }
  throw new Error("未找到 Chrome/Edge：设置 CHROME_PATH 后重试");
}

function reservePort(start) {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(start, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : start;
      server.close(() => done(port));
    });
  });
}

/**
 * WHATWG Fetch 的**禁用端口表**。
 *
 * 这不是"占用"，是浏览器与 undici 的 `fetch` **拒绝向这些端口发请求**（防 FTP/SMTP
 * 跨协议攻击）。踩中的表现极具迷惑性：服务正常监听、日志正常打印地址，
 * 而 `fetch` 一律抛 `Error: bad port` ——看起来像"服务没起来"，实际请求根本没发出去。
 *
 * 实际踩过：本脚本原先取 4190（ManageSieve），vite preview 报"Local: 4190"，
 * 182 次探活全失败。所以这里**主动跳过**，而不是等下一个人再查一遍。
 */
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

export async function findPort(start) {
  for (let port = start; port < start + 30; port += 1) {
    if (FETCH_BLOCKED_PORTS.has(port)) continue;
    try {
      return await reservePort(port);
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`${start}..${start + 30} 没有空闲端口`);
}

export async function waitFor(url, timeoutMs = 20_000) {
  const started = Date.now();
  let attempts = 0;
  let last = "(没有发出过请求)";
  while (Date.now() - started < timeoutMs) {
    attempts += 1;
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      // 服务还在启动。**记下最后一次失败原因**：只报"超时"等于把唯一的线索丢掉，
      // 而 ECONNREFUSED（还没起）与 ENOTFOUND / 证书错（起错了）该走完全不同的排查。
      last = `${error.message} | cause=${error.cause ? `${error.cause.name ?? "?"}: ${error.cause.message ?? "?"}${error.cause.code ? ` [${error.cause.code}]` : ""}` : "(无)"}`;
      if (process.env.LIGHTEE_CDP_DEBUG && attempts <= 3) console.error(`waitFor#${attempts}`, error, error.cause);
    }
    await sleep(100);
  }
  throw new Error(`等 ${url} 超时（${attempts} 次尝试，最后一次：${last}）`);
}

/** 收进程。Windows 上必须连子树一起杀——vite/chrome 都会派生子进程。 */
export async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((done) => {
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => done());
    });
  } else {
    child.kill("SIGTERM");
  }
}

export async function removeProfile(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.id = 0;
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
      // 无 id = CDP 事件（Runtime.consoleAPICalled / Log.entryAdded 之类）。
      // 早期版本直接丢掉它们，于是订阅方静默收不到——`verify-renderer` 正是靠这个
      // 抓控制台报错的，丢掉等于那道检查一直在"通过"。
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
    await new Promise((open, fail) => {
      this.socket.addEventListener("open", open, { once: true });
      this.socket.addEventListener("error", fail, { once: true });
    });
  }

  /** 订阅 CDP 事件。同一 method 可挂多个。 */
  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 求值并把异常**抛出来**——静默吞掉的求值失败会让截图脚本"成功"地截出空白页 */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || String(expression).slice(0, 120));
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}
