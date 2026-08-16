/**
 * EX-02 dev 实验台（`dev.prompt.probe`）。
 *
 * 存在理由：真实密钥由 DPAPI 封存、只有主进程内能解封（RH-17 红线），而现有 IPC 没有
 * 任何「发一段自拟 prompt」的通道——融合提取的 prompt 编排（EX-03 起）因此没有实验台。
 *
 * 两条断言各守一头：**默认不存在**（不是发布版里的一个后门），以及**不落 prompt**。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createIpcService } from "./ipc-service.js";

const SENTINEL = "SENTINEL_PROBE_LEAK_4b7c";

const services: Array<ReturnType<typeof createIpcService>> = [];
const restoreEnv: Array<() => void> = [];

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.markClosing();
    await service.flushPendingWrites().catch(() => undefined);
  }
  for (const restore of restoreEnv.splice(0)) restore();
});

function withProbeEnabled(enabled: boolean): void {
  const previous = process.env.LIGHTEE_DEV_PROBE;
  if (enabled) process.env.LIGHTEE_DEV_PROBE = "1";
  else delete process.env.LIGHTEE_DEV_PROBE;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env.LIGHTEE_DEV_PROBE;
    else process.env.LIGHTEE_DEV_PROBE = previous;
  });
}

function envelope(payload: unknown) {
  return { version: 1, requestId: "dev-probe-test", command: "dev.prompt.probe", payload };
}

const echoLlm = {
  complete: async (_model: string, messages: Array<{ role: string; content: string }>) => ({
    text: `echo:${messages.find((message) => message.role === "user")?.content ?? ""}`,
    usage: { input: 11, output: 22, cacheRead: 3, cacheWrite: 0 },
    attempts: 1,
  }),
};

describe("EX-02 dev 实验台", () => {
  it("未开门控时命令不可用", async () => {
    withProbeEnabled(false);
    const service = createIpcService({ llm: echoLlm as never, terminologyWatcher: false });
    services.push(service);
    const result = await service.invoke(envelope({ system: "s", user: "u" }));
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("开门控后发出真实调用并回传用量", async () => {
    withProbeEnabled(true);
    const service = createIpcService({ llm: echoLlm as never, terminologyWatcher: false });
    services.push(service);
    const result = await service.invoke(envelope({ model: "p/m", system: "你是测试助手", user: "ping", thinking: "low" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      text: "echo:ping",
      usage: { input: 11, output: 22, cacheRead: 3 },
      attempts: 1,
    });
    expect(typeof (result.value as { ms: number }).ms).toBe("number");
  });

  it("红线：探针不把 prompt 写进运维日志", async () => {
    withProbeEnabled(true);
    const lines: string[] = [];
    const service = createIpcService({
      llm: echoLlm as never,
      terminologyWatcher: false,
      log: (level, message) => lines.push(`${level} ${message}`),
    });
    services.push(service);
    await service.invoke(envelope({ model: "p/m", system: `系统 ${SENTINEL}`, user: `用户 ${SENTINEL}` }));
    expect(lines.join("\n")).not.toContain(SENTINEL);
    // 但**要**留痕：探针跑过这件事本身必须可见，否则事后无从解释账单上多出来的调用
    expect(lines.some((line) => line.includes("dev prompt probe"))).toBe(true);
  });
});
