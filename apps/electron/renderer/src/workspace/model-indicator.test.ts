import { describe, expect, it } from "vitest";
import { describeModelIndicator, type IndicatorInput } from "./model-indicator.js";

/**
 * 标题栏右上角的模型/连接指示（2026-08-10 用户报告：「右上角显示的也不是真实状态」）。
 *
 * 原先那格最后一段是写死的「在线」——不读任何状态、永远绿灯。应用可以连密钥都没配、
 * 模型可以根本不存在，它照样说在线。这里把判定抽成纯函数单独验，规则只有一条：
 * **只说能被证明的话**。没发出过请求就不许出现「连接正常」。
 */
const BASE: IndicatorInput = {
  current: "deepseek/deepseek-v4-flash",
  providers: [{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", hasKey: true, models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }] }],
  lastProbe: null,
};

describe("标题栏模型指示", () => {
  it("有密钥但从未发起过调用 → 只说「密钥已配置」，不说在线", () => {
    const view = describeModelIndicator(BASE);
    expect(view.modelLabel).toBe("DeepSeek V4 Flash");
    expect(view.state).toBe("ready");
    expect(view.connectionLabel).toBe("密钥已配置");
    expect(view.connectionLabel).not.toContain("在线");
  });

  it("没有配置模型 → 如实说未配置，而不是显示某个默认名", () => {
    const view = describeModelIndicator({ ...BASE, current: "" });
    expect(view.state).toBe("no-model");
    expect(view.modelLabel).toBe("未配置模型");
  });

  it("模型指向的服务商不在配置里 → 说服务商未配置（不假装模型可用）", () => {
    const view = describeModelIndicator({ ...BASE, current: "ghost/some-model" });
    expect(view.state).toBe("no-provider");
    expect(view.modelLabel).toBe("some-model");
    expect(view.connectionLabel).toBe("服务商未配置");
  });

  it("服务商没有密钥 → 未配置密钥（这正是用户点测试连接会撞上的状态）", () => {
    const view = describeModelIndicator({ ...BASE, providers: [{ ...BASE.providers[0]!, hasKey: false }] });
    expect(view.state).toBe("no-key");
    expect(view.connectionLabel).toBe("未配置密钥");
  });

  it("本地服务商无需密钥 → 不报「未配置密钥」这种假警报", () => {
    const view = describeModelIndicator({
      current: "ollama/qwen3",
      providers: [{ id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", hasKey: false, models: [{ id: "qwen3", name: "Qwen3" }] }],
      lastProbe: null,
    });
    expect(view.state).toBe("local");
    expect(view.connectionLabel).toBe("本地服务");
  });

  it("真的成功调用过一次 → 才允许说「连接正常」", () => {
    const view = describeModelIndicator({ ...BASE, lastProbe: { ok: true, model: "deepseek/deepseek-v4-flash" } });
    expect(view.state).toBe("ok");
    expect(view.connectionLabel).toBe("连接正常");
  });

  it("调用失败 → 说连接失败，不被「有密钥」盖过去", () => {
    const view = describeModelIndicator({ ...BASE, lastProbe: { ok: false, model: "deepseek/deepseek-v4-flash" } });
    expect(view.state).toBe("failed");
    expect(view.connectionLabel).toBe("连接失败");
  });

  it("换了模型之后，旧模型的探测结果不再代表当前状态", () => {
    const view = describeModelIndicator({ ...BASE, lastProbe: { ok: true, model: "deepseek/deepseek-v4-pro" } });
    expect(view.state).toBe("ready");
    expect(view.connectionLabel).toBe("密钥已配置");
  });

  it("没有密钥时，陈旧的成功探测不得掩盖「未配置密钥」", () => {
    const view = describeModelIndicator({
      ...BASE,
      providers: [{ ...BASE.providers[0]!, hasKey: false }],
      lastProbe: { ok: true, model: "deepseek/deepseek-v4-flash" },
    });
    expect(view.state).toBe("no-key");
  });

  it("模型在服务商里没有登记名字 → 退回模型 id，绝不留空", () => {
    const view = describeModelIndicator({ ...BASE, current: "deepseek/unlisted" });
    expect(view.modelLabel).toBe("unlisted");
  });

  it("菜单项：列出所有服务商的所有模型并标出当前项", () => {
    const view = describeModelIndicator({
      current: "deepseek/deepseek-v4-flash",
      providers: [
        { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", hasKey: true, models: [{ id: "deepseek-v4-flash", name: "V4 Flash" }, { id: "deepseek-v4-pro", name: "V4 Pro" }] },
        { id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", hasKey: false, models: [{ id: "qwen3", name: "Qwen3" }] },
      ],
      lastProbe: null,
    });
    expect(view.options.map((o) => o.ref)).toEqual(["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "ollama/qwen3"]);
    expect(view.options.filter((o) => o.current).map((o) => o.ref)).toEqual(["deepseek/deepseek-v4-flash"]);
    // 缺密钥的服务商在菜单里要标出来——否则用户选中后又撞一次「没有 API Key」
    expect(view.options.find((o) => o.ref === "ollama/qwen3")?.needsKey).toBe(false);
    expect(view.options.find((o) => o.ref === "deepseek/deepseek-v4-pro")?.needsKey).toBe(false);
  });

  it("缺密钥的远程服务商，其模型在菜单里标记为需要密钥", () => {
    const view = describeModelIndicator({
      ...BASE,
      providers: [{ ...BASE.providers[0]!, hasKey: false }],
    });
    expect(view.options.every((o) => o.needsKey)).toBe(true);
  });
});
