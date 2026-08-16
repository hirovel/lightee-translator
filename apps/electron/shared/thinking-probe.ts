/**
 * 思考能力逐档探测（`ai.thinking.probe` 的纯逻辑部分）。
 *
 * 为什么不能直接用 `complete(ref, msgs, {thinking:"xhigh"})` 去试：
 * pi-ai 的 `clampThinkingLevel` 会因为模型没写 `xhigh` 条目而把它**静默降级成 high**，
 * 请求照样成功——探测于是得出「xhigh 支持」这个错误结论。整个 `thinkingLevelMap`
 * 就是被这类「看起来成功了」喂出来的。
 *
 * 破法见 {@link probeLevelMap}：每次只让一个档位通路，clamp 无从介入。
 *
 * 判定原则：**只记录实测到的事实**。
 *  · 被服务商接受 → 原样映射（绝不改名、绝不降级到别的档位）；
 *  · 被拒 → 显式 `null`（留空在运行时等于透传支持，等于什么都没探测）；
 *  · 「接受」与「真的返回了思考内容」分开记——很多服务商接受参数但不回传思考过程，
 *    据此判定不支持会误伤，所以后者只作为展示信息，不折进 map。
 */
import type { ThinkingLevelMap } from "./thinking-levels.js";
import { THINKING_LEVEL_IDS } from "./thinking-levels.js";

/**
 * 逐档探测的候选。这里是**服务商档位字符串**的候选表，恰好与 Lightee 档位同名
 * （`off` 对应服务商侧的 `none`）——同名才能原样映射，不必发明降级规则。
 */
export const PROBE_CANDIDATES = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ProbeCandidate = (typeof PROBE_CANDIDATES)[number];

/** 服务商档位字符串 → Lightee 档位（`none` 是「关闭」在服务商侧的叫法） */
const CANDIDATE_TO_LEVEL: Record<ProbeCandidate, string> = {
  none: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
};

export interface ProbeOutcome {
  candidate: ProbeCandidate;
  /** 服务商接受了这个 reasoning 参数（请求没报错） */
  accepted: boolean;
  /** 响应里真的带回了思考内容。仅供展示——接受但不回传思考过程的服务商很常见 */
  reasoned: boolean;
  /** 被拒时的错误摘要（展示用，不参与判定） */
  error?: string;
}

/**
 * 为探测某个候选字符串构造的临时 `thinkingLevelMap`：**只让 `high` 通向它，其余全 `null`**。
 *
 * 这样可用档位恰好只有 `high` 一个，请求 `high` 时 `clampThinkingLevel` 找到它就直接返回，
 * 不会降级；随后 pi-ai 用 `thinkingLevelMap["high"]` 取出候选字符串发给服务商。
 * 于是「发出去的到底是哪个字符串」是确定的，探测结论才有意义。
 */
export function probeLevelMap(candidate: string): ThinkingLevelMap {
  const map: ThinkingLevelMap = {};
  for (const id of THINKING_LEVEL_IDS) map[id] = null;
  map.high = candidate;
  return map;
}

/** 探测请求统一用 `high` 发起——`probeLevelMap` 已保证它是唯一通路 */
export const PROBE_REQUEST_LEVEL = "high";

/**
 * 探测结果 → `thinkingLevelMap`。
 * 结果里缺失的候选（探测被中断/取消）按「未通过」处理：宁可标成不可选，
 * 也不能留空——留空在运行时是透传支持，等于把没验证过的档位当成验证过的。
 */
export function buildThinkingLevelMap(outcomes: readonly ProbeOutcome[]): ThinkingLevelMap {
  const accepted = new Set(outcomes.filter((outcome) => outcome.accepted).map((outcome) => outcome.candidate));
  const map: ThinkingLevelMap = {};
  for (const candidate of PROBE_CANDIDATES) {
    map[CANDIDATE_TO_LEVEL[candidate]] = accepted.has(candidate) ? candidate : null;
  }
  return map;
}
