/**
 * 思考档位的判定与预设（渲染层与探测共用同一套语义）。
 *
 * `thinkingLevelMap` 是 pi 的抽象：Lightee 档位 → 服务商档位字符串。三种取值意义不同，
 * 混淆任何一对都会让 UI 和运行时打架：
 *
 * | 取值 | pi-ai 运行时 | UI 应当怎么呈现 |
 * |---|---|---|
 * | `null` | 明确不支持，该档位不可选 | 不出现在下拉里 |
 * | 未写（`undefined`） | **透传支持**：把档位名原样发给服务商 | 可选，但标注「未探测」 |
 * | 字符串 | 支持，且改名为该字符串发出 | 可选，有依据 |
 *
 * 外加一条：`xhigh` / `max` 必须显式写条目，否则 `clampThinkingLevel` 会静默降级到 `high`。
 * 让用户选一个会被悄悄降级的档位，比不给他选更糟。
 *
 * 此前渲染层的规则是「没有 map 就一个档位都不给」，比运行时严得多——而又没有任何界面
 * 能写这个 map，于是那个下拉成了永远打不开的死控件。
 */

/** 与 pi-ai 的 EXTENDED_THINKING_LEVELS 顺序一致（由弱到强） */
export const THINKING_LEVEL_IDS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelId = (typeof THINKING_LEVEL_IDS)[number];

/** 必须显式写条目才生效的档位；缺条目时运行时会 clamp 降级 */
const REQUIRES_EXPLICIT: ReadonlySet<string> = new Set(["xhigh", "max"]);

/**
 * 档位显示名 = **服务商官方叫法**，全大写（作者裁定 2026-08-13）。
 *
 * 两条依据：
 * 1. 从前显示成「高 / 很高 / 最高」，而服务商文档、报错信息、账单里写的是
 *    `high` / `xhigh` / `max`——两套词对不上，用户查文档时无从对照，
 *    也说不清「很高」到底是不是 `xhigh`。
 * 2. 全小写摆在中文界面里显得没排好版；而首字母大写对 `xhigh` 是灾难（`Xhigh`）。
 *    这组值本质是枚举标识，全大写既是惯例也整齐，且与官方标识大小写无关地一一对应。
 *
 * 发给服务商的仍是小写 id（`THINKING_LEVEL_IDS` / `CANONICAL`）——这里只管显示。
 */
export const THINKING_LEVEL_LABELS: Record<ThinkingLevelId, string> = {
  off: "OFF", minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "XHIGH", max: "MAX",
};

export type ThinkingLevelMap = Record<string, string | null>;

export interface ThinkingOption {
  id: ThinkingLevelId;
  label: string;
  /** map 里写了非 null 条目 = 有依据；false 表示运行时会透传，但没人验证过服务商真的接受 */
  proven: boolean;
}

/**
 * 某模型当前可选的思考档位。语义逐条对齐 pi-ai `getSupportedThinkingLevels`，
 * 额外附带 `proven`——「能用」和「有依据」是两件事，UI 要能分别表达。
 */
export function supportedThinkingLevels(map: ThinkingLevelMap | undefined): ThinkingOption[] {
  return THINKING_LEVEL_IDS.flatMap((id) => {
    const mapped = map?.[id];
    if (mapped === null) return [];
    if (mapped === undefined && REQUIRES_EXPLICIT.has(id)) return [];
    return [{ id, label: THINKING_LEVEL_LABELS[id], proven: mapped !== undefined }];
  });
}

/** 面板里给人选的形态。让人手填 7 条映射不是配置，是折磨。 */
export type ThinkingPresetId = "unprobed" | "none" | "standard" | "full" | "probed" | "custom";

export const THINKING_PRESET_LABELS: Record<ThinkingPresetId, string> = {
  unprobed: "未探测（按服务商默认透传）",
  none: "不支持思考（不发送思考参数）",
  standard: "标准三档（low / medium / high）",
  full: "全档位（含 xhigh / max）",
  probed: "已探测（实测结果）",
  custom: "自定义",
};

/** 只能作为**结果**出现、不能主动选的形态——列进下拉只会诱导用户去选一个空动作 */
export const THINKING_PRESET_RESULT_ONLY: ReadonlySet<ThinkingPresetId> = new Set(["probed", "custom"]);

/** 各档位在服务商侧的规范叫法（探测按这套原样映射，见 thinking-probe.ts） */
const CANONICAL: Record<ThinkingLevelId, string> = {
  off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
};

/**
 * 是否是「原样映射」——每一档要么 `null`（实测被拒），要么就是它自己的规范叫法。
 * 这正是探测的产出形状。识别它是为了不把刚跑完实测的结果标成「自定义」——
 * 那读起来像是用户手改过什么。「自定义」要留给真正被改名的映射。
 */
function isIdentityShaped(map: ThinkingLevelMap): boolean {
  return Object.entries(map).every(([level, value]) =>
    (THINKING_LEVEL_IDS as readonly string[]).includes(level)
    && (value === null || value === CANONICAL[level as ThinkingLevelId]));
}

/**
 * 「不支持思考」= 每一档都显式 `null`。
 *
 * 两处都必须是 null 才对：
 *  · 其余档位「未写」在运行时等于透传支持，于是一个不会思考的模型仍会被发去 reasoning 参数；
 *  · `off` 也不能写成 `"none"`——那是在断言服务商接受 `effort:"none"`，而不接受的服务商会直接报错。
 *
 * 全 null 时 pi-ai 的 clamp 会落到 `"off"`，进而**完全不发送 reasoning 参数**——
 * 这正是「这个模型不吃思考参数」的准确编码。UI 见到零档位应显示为已定论的
 * 「不支持思考」，而不是「能力未探测」。
 */
const NONE_MAP: ThinkingLevelMap = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
const STANDARD_MAP: ThinkingLevelMap = { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
const FULL_MAP: ThinkingLevelMap = { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" };

export const THINKING_PRESET_MAPS: Record<"none" | "standard" | "full", ThinkingLevelMap> = {
  none: NONE_MAP, standard: STANDARD_MAP, full: FULL_MAP,
};

function sameMap(a: ThinkingLevelMap, b: ThinkingLevelMap): boolean {
  return THINKING_LEVEL_IDS.every((id) => (a[id] ?? null) === (b[id] ?? null))
    && Object.keys(a).every((key) => (THINKING_LEVEL_IDS as readonly string[]).includes(key));
}

/** 从既有 map 反认预设——认不出就是「自定义」，绝不静默改写成某个预设 */
export function identifyThinkingPreset(map: ThinkingLevelMap | undefined): ThinkingPresetId {
  if (!map || Object.keys(map).length === 0) return "unprobed";
  // 三个具名预设优先：它们比「已探测」说得更具体
  for (const id of ["none", "standard", "full"] as const) {
    if (sameMap(map, THINKING_PRESET_MAPS[id])) return id;
  }
  return isIdentityShaped(map) ? "probed" : "custom";
}
