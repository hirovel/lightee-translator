/**
 * 标题栏右上角的「当前模型 · 连接状态」判定（纯函数，无 DOM）。
 *
 * 这一格原先的最后一段是硬编码的「在线」：不读任何状态、永远绿灯，密钥没配也说在线。
 * 因此这里立一条规则并用测试钉死——**只说能被证明的话**：
 *   · 没发出过成功请求，就不许出现「连接正常」；
 *   · 有密钥只能推出「密钥已配置」，推不出「连得上」；
 *   · 陈旧的探测结果（换了模型、或密钥后来被删了）一律作废，不得掩盖当前的真实状态。
 *
 * DOM 读写在 workspace-bridge 的 fillTitlebar 里，这里只做判定，便于在无 DOM 的
 * renderer 测试环境（vitest node）中直接验证。
 */

/** 本地推理服务（Ollama/LM Studio 等）无需密钥，不该报「未配置密钥」的假警报 */
const LOCAL_HOST = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/;

/** 该服务商是否跑在本机（本机服务不需要 API 密钥，别给它挂「未配」标记） */
export function isLocalBaseUrl(baseUrl: string): boolean {
  return LOCAL_HOST.test(baseUrl);
}

export interface IndicatorProvider {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  models: Array<{ id: string; name: string }>;
}

/** 最近一次真实 LLM 调用的结果（测试连接或任意一次翻译/审校调用） */
export interface ProbeResult {
  ok: boolean;
  /** 那次调用用的模型 ref；与当前模型不一致时该结果作废 */
  model: string;
}

export interface IndicatorInput {
  /** 工作区配置的当前模型，形如 "provider/model"；未配置时为空串 */
  current: string;
  providers: IndicatorProvider[];
  lastProbe: ProbeResult | null;
}

export type IndicatorState = "no-model" | "no-provider" | "no-key" | "local" | "ready" | "ok" | "failed";

export interface IndicatorOption {
  ref: string;
  providerName: string;
  modelName: string;
  current: boolean;
  /** 选中它之前还得先配密钥——菜单里就标出来，别让用户选完再撞一次「没有 API Key」 */
  needsKey: boolean;
}

export interface IndicatorView {
  modelLabel: string;
  connectionLabel: string;
  state: IndicatorState;
  options: IndicatorOption[];
}

function needsKey(provider: IndicatorProvider): boolean {
  return !provider.hasKey && !LOCAL_HOST.test(provider.baseUrl);
}

export function describeModelIndicator(input: IndicatorInput): IndicatorView {
  const options: IndicatorOption[] = input.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      ref: `${provider.id}/${model.id}`,
      providerName: provider.name,
      modelName: model.name || model.id,
      current: `${provider.id}/${model.id}` === input.current,
      needsKey: needsKey(provider),
    })),
  );

  if (!input.current) {
    return { modelLabel: "未配置模型", connectionLabel: "去设置", state: "no-model", options };
  }

  const providerId = input.current.split("/")[0] ?? "";
  const modelId = input.current.split("/").slice(1).join("/");
  const provider = input.providers.find((candidate) => candidate.id === providerId);
  const modelLabel = provider?.models.find((model) => model.id === modelId)?.name || modelId || input.current;

  if (!provider) {
    return { modelLabel, connectionLabel: "服务商未配置", state: "no-provider", options };
  }
  if (needsKey(provider)) {
    // 缺密钥是硬事实：哪怕之前成功调用过（密钥后来被删了），现在也调不通。
    return { modelLabel, connectionLabel: "未配置密钥", state: "no-key", options };
  }

  // 探测结果只在「就是当前这个模型」时才算数——换模型等于换了一条链路。
  if (input.lastProbe && input.lastProbe.model === input.current) {
    return input.lastProbe.ok
      ? { modelLabel, connectionLabel: "连接正常", state: "ok", options }
      : { modelLabel, connectionLabel: "连接失败", state: "failed", options };
  }

  if (LOCAL_HOST.test(provider.baseUrl)) {
    return { modelLabel, connectionLabel: "本地服务", state: "local", options };
  }
  return { modelLabel, connectionLabel: "密钥已配置", state: "ready", options };
}
