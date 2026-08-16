import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppLog, redactForLog } from "./app-log.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lightee-log-"));
}

const logs: AppLog[] = [];
function makeLog(dir: string, options?: { maxBytes?: number; maxFiles?: number; now?: () => number }): AppLog {
  const log = new AppLog({ dir, ...options });
  logs.push(log);
  return log;
}
afterEach(async () => { await Promise.all(logs.splice(0).map((log) => log.close())); });

describe("AppLog 脱敏（RH-21 / C-1 红线：日志永不写入 API key、prompt、译文正文）", () => {
  it("剥掉 sk- 开头的密钥", () => {
    expect(redactForLog("auth failed for sk-abcdef0123456789abcdef")).toBe("auth failed for sk-***");
  });

  it("剥掉 Bearer token", () => {
    expect(redactForLog("Authorization: Bearer eyJhbGciOi.J9.abc")).toBe("Authorization: Bearer ***");
  });

  it("剥掉 JSON 里的 key / apiKey / token 字段值", () => {
    expect(redactForLog('{"apiKey":"sk-live-xyz","model":"deepseek/v4"}')).toBe('{"apiKey":"***","model":"deepseek/v4"}');
    expect(redactForLog('{"refreshToken": "rt_9911"}')).toBe('{"refreshToken": "***"}');
  });

  it("超长文本被截断——prompt / 译文正文即使被误传进来也不会整段落盘", () => {
    const body = "あ".repeat(5_000);
    const redacted = redactForLog(body);
    expect(redacted.length).toBeLessThan(600);
    expect(redacted).toContain("…[truncated");
  });

  it("正常的诊断文本原样保留", () => {
    expect(redactForLog("chapter ch001 translating -> translated")).toBe("chapter ch001 translating -> translated");
  });
});

describe("AppLog 滚动", () => {
  it("写满 maxBytes 后切到新文件，并且只保留 maxFiles 份", async () => {
    const dir = await tempDir();
    const log = makeLog(dir, { maxBytes: 200, maxFiles: 3 });
    for (let i = 0; i < 40; i += 1) await log.write("info", `line ${i} ${"x".repeat(40)}`);
    const files = (await readdir(dir)).filter((name) => name.endsWith(".log"));
    expect(files.length).toBe(3);
  });

  it("每行是「时间 级别 消息」且消息已脱敏", async () => {
    const dir = await tempDir();
    const log = makeLog(dir);
    await log.write("error", "llm failed key=sk-secret0123456789");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".log"));
    const content = await readFile(join(dir, files[0]!), "utf8");
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z ERROR llm failed key=sk-\*\*\*$/m);
    expect(content).not.toContain("secret0123456789");
  });

  it("目录不可写时不抛异常——日志失败绝不能拖垮应用", async () => {
    const log = makeLog(join(await tempDir(), "nested", "\0invalid"));
    await expect(log.write("info", "still fine")).resolves.toBeUndefined();
  });

  it("接管已存在的当日文件而不是覆盖它", async () => {
    const dir = await tempDir();
    const first = makeLog(dir);
    await first.write("info", "before restart");
    await first.close();
    const second = makeLog(dir);
    await second.write("info", "after restart");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".log"));
    expect(files.length).toBe(1);
    const content = await readFile(join(dir, files[0]!), "utf8");
    expect(content).toContain("before restart");
    expect(content).toContain("after restart");
  });

  it("轮转时保留最新的一份为当前写入目标", async () => {
    const dir = await tempDir();
    const log = makeLog(dir, { maxBytes: 120, maxFiles: 2 });
    await log.write("info", `first ${"a".repeat(150)}`);
    await log.write("info", "second");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".log")).sort();
    const merged = (await Promise.all(files.map((name) => readFile(join(dir, name), "utf8")))).join("");
    expect(merged).toContain("second");
  });
});
