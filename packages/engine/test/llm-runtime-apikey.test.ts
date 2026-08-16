/**
 * API Key 解析（2026-08-10 用户实测报告：填了 Key 仍报「没有 API Key」）。
 *
 * 症状：设置面板保存 DeepSeek 密钥后点「测试连接」，报 `No API key for provider: deepseek`。
 * 真因不在 UI：`complete()` 传给 pi-ai 的 `apiKey` 由一个模块级 `providerKey()` 解析，而它
 *
 *   1) **没传 decryptSecret** —— RH-17 把 auth.json 的机密字段用 DPAPI 封了之后，
 *      所有带 `sealed` 标记的条目一律解析成 undefined。也就是说加密上线那天起，
 *      真实 LLM 全链路（翻译/审校/术语/测试连接）就没有一条能跑通；
 *   2) 用 `defaultConfigDir()` 而不是实例的 `configDir` —— `create({ configDir })` 传进来的
 *      目录被无视，读的是用户家目录；
 *   3) 用 `loadProviders(...)` 重新读磁盘，而不是注册时那份 config —— `create({ providers })`
 *      的内存配置（含 apiKey）根本不参与解析。
 *
 * 三条都只在「真的发出请求」时才暴露，所以这里用本地 HTTP 服务端捕获 Authorization 头：
 * 断言密钥**实际被带到了线上**，而不是断言某个内部函数的返回值。
 */
import { afterEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmRuntime } from "../src/llm-runtime.ts";

/** 假编解码器：base64（与 DPAPI 无关，只为验证 decryptSecret 确实被调用） */
const fakeSeal = (plain: string): string => Buffer.from(plain, "utf-8").toString("base64");
const fakeUnseal = (sealed: string): string => Buffer.from(sealed, "base64").toString("utf-8");

interface Probe {
  server: Server;
  baseUrl: string;
  /** 收到的 Authorization 头（未收到请求时为 undefined） */
  authHeader(): string | undefined;
}

/** 捕获 Authorization 的本地服务端。返回什么不重要——断言只看请求头。 */
async function startProbe(): Promise<Probe> {
  let seen: string | undefined;
  const server = createServer((req, res) => {
    seen = req.headers.authorization;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, authHeader: () => seen };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lightee-apikey-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function probe(): Promise<Probe> {
  const p = await startProbe();
  cleanup.push(() => p.server.close());
  return p;
}

/** 一次必然走到网络的调用；错误吞掉——断言在请求头上 */
async function callOnce(llm: LlmRuntime, ref: string): Promise<void> {
  await llm.complete(ref, [{ role: "user", content: "ping" }], { retry: { maxRetries: 0 } }).catch(() => undefined);
}

describe("LlmRuntime API Key 解析", () => {
  test("auth.json 的 sealed 条目经 decryptSecret 解密后用于请求", async () => {
    const p = await probe();
    const dir = tempConfigDir();
    writeFileSync(join(dir, "models.json"), JSON.stringify({
      providers: { acme: { name: "acme", baseUrl: p.baseUrl, api: "openai-completions", models: [{ id: "m" }] } },
    }), "utf-8");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({
      acme: { type: "api_key", key: fakeSeal("sk-real-secret"), sealed: "dpapi-v1" },
    }), "utf-8");

    const llm = LlmRuntime.create({ configDir: dir, historyFile: false, decryptSecret: fakeUnseal });
    await callOnce(llm, "acme/m");

    expect(p.authHeader()).toBe("Bearer sk-real-secret");
  });

  test("明文条目照常可用（未加密的旧配置不因加密上线而失效）", async () => {
    const p = await probe();
    const dir = tempConfigDir();
    writeFileSync(join(dir, "models.json"), JSON.stringify({
      providers: { acme: { name: "acme", baseUrl: p.baseUrl, api: "openai-completions", models: [{ id: "m" }] } },
    }), "utf-8");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ acme: { type: "api_key", key: "sk-plain" } }), "utf-8");

    const llm = LlmRuntime.create({ configDir: dir, historyFile: false, decryptSecret: fakeUnseal });
    await callOnce(llm, "acme/m");

    expect(p.authHeader()).toBe("Bearer sk-plain");
  });

  test("create({ configDir }) 指定的目录被真的使用（不回落到用户家目录）", async () => {
    const p = await probe();
    const dir = tempConfigDir();
    // 只有这个临时目录里有 acme 的密钥；家目录里没有。读错目录 → 拿不到密钥。
    writeFileSync(join(dir, "models.json"), JSON.stringify({
      providers: { acme: { name: "acme", baseUrl: p.baseUrl, api: "openai-completions", models: [{ id: "m" }] } },
    }), "utf-8");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ acme: { type: "api_key", key: "sk-from-configdir" } }), "utf-8");

    const llm = LlmRuntime.create({ configDir: dir, historyFile: false });
    await callOnce(llm, "acme/m");

    expect(p.authHeader()).toBe("Bearer sk-from-configdir");
  });

  test("create({ providers }) 的内存配置里的 apiKey 生效（不必落盘）", async () => {
    const p = await probe();
    const dir = tempConfigDir(); // 故意留空：磁盘上没有任何 acme 配置
    const llm = LlmRuntime.create({
      configDir: dir,
      historyFile: false,
      providers: { acme: { name: "acme", baseUrl: p.baseUrl, api: "openai-completions", apiKey: "sk-inline", models: [{ id: "m" }] } },
    });
    await callOnce(llm, "acme/m");

    expect(p.authHeader()).toBe("Bearer sk-inline");
  });

  test("无法解密的 sealed 条目视为无密钥——绝不把密文当密钥发出去", async () => {
    const p = await probe();
    const dir = tempConfigDir();
    writeFileSync(join(dir, "models.json"), JSON.stringify({
      providers: { acme: { name: "acme", baseUrl: p.baseUrl, api: "openai-completions", models: [{ id: "m" }] } },
    }), "utf-8");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({
      acme: { type: "api_key", key: fakeSeal("sk-real-secret"), sealed: "dpapi-v1" },
    }), "utf-8");

    // 不注入 decryptSecret（等价于加密后端不可用）
    const llm = LlmRuntime.create({ configDir: dir, historyFile: false });
    const error = await llm.complete("acme/m", [{ role: "user", content: "ping" }], { retry: { maxRetries: 0 } })
      .then(() => undefined, (e: unknown) => e);

    // 请求根本不该发出：密文当密钥用只会以「服务商 401」的形式误导用户
    expect(p.authHeader()).toBeUndefined();
    expect(String(error)).toContain("No API key");
  });
});

/**
 * models.json 在进程运行期间被改写后必须生效（同一类「保存了却不生效」的第二处）。
 *
 * 运行时在进程启动时把 models.json 读成快照后再不重读，于是：设置面板里新增一个模型、
 * 或按 UI 提示手改 `~/.lightee/models.json`，选中它就报「模型不存在」，必须重启应用。
 * 而设置面板的提示原文是「已打开 ~/.lightee/models.json（保存后点「测试连接」生效）」——
 * 这句话当时是假的。
 */
describe("LlmRuntime 配置热重载", () => {
  test("运行期间新增的模型无需重启即可使用", async () => {
    const p = await probe();
    const dir = tempConfigDir();
    const modelsPath = join(dir, "models.json");
    const write = (models: Array<{ id: string }>): void => {
      writeFileSync(modelsPath, JSON.stringify({
        providers: { acme: { name: "acme", baseUrl: p.baseUrl, api: "openai-completions", models } },
      }), "utf-8");
    };
    write([{ id: "m1" }]);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ acme: { type: "api_key", key: "sk-hot" } }), "utf-8");

    const llm = LlmRuntime.create({ configDir: dir, historyFile: false });
    expect(llm.listModels()).toEqual(["acme/m1"]);

    // 用户在设置面板添加模型（或手改文件）——不重启应用
    write([{ id: "m1" }, { id: "m2" }]);
    await callOnce(llm, "acme/m2");

    expect(p.authHeader()).toBe("Bearer sk-hot");
  });

  test("被删除的模型随之消失（重载不是只做加法）", async () => {
    const p = await probe();
    const dir = tempConfigDir();
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: { acme: { name: "acme", baseUrl: p.baseUrl, api: "openai-completions", models: [{ id: "m1" }, { id: "gone" }] } },
    }), "utf-8");

    const llm = LlmRuntime.create({ configDir: dir, historyFile: false });
    writeFileSync(modelsPath, JSON.stringify({
      providers: { acme: { name: "acme", baseUrl: p.baseUrl, api: "openai-completions", models: [{ id: "m1" }] } },
    }), "utf-8");

    const error = await llm.complete("acme/gone", [{ role: "user", content: "ping" }], { retry: { maxRetries: 0 } })
      .then(() => undefined, (e: unknown) => e);
    expect(String(error)).toContain("模型不存在");
    expect(p.authHeader()).toBeUndefined();
  });

  test("create({ providers }) 的内存配置不被磁盘覆盖（磁盘不是它的真相来源）", async () => {
    const p = await probe();
    const dir = tempConfigDir();
    // 磁盘上有一份同名但指向别处、密钥不同的配置——绝不能压过内存配置
    writeFileSync(join(dir, "models.json"), JSON.stringify({
      providers: { acme: { name: "acme", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "sk-disk", models: [{ id: "m" }] } },
    }), "utf-8");

    const llm = LlmRuntime.create({
      configDir: dir,
      historyFile: false,
      providers: { acme: { name: "acme", baseUrl: p.baseUrl, api: "openai-completions", apiKey: "sk-inline", models: [{ id: "m" }] } },
    });
    await callOnce(llm, "acme/m");

    expect(p.authHeader()).toBe("Bearer sk-inline");
  });
});
