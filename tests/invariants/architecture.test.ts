/**
 * 架构不变量 —— 把「靠人记得」变成「CI 会拦」（IV-01）。
 *
 * 这个仓库没有 lint，只有 build / test / typecheck。所有跨文件的约束都写在注释里，
 * 而**注释不会失败**。三个已经付过学费的形状全是这么来的：
 *
 *  - 「与 terminologist-decide 同款」——注释宣称等价，实现早已漂移成朴素版，
 *    真实 46 章的术语提取在 401 秒开销之后整体报废。
 *  - 「创建工作区有两条路径」——Q 批咬过一次（译后规则只在 CLI 一侧生效），
 *    此后仍靠人记得两边都改。
 *  - `location: ":1"` ——长得像真定位的假值，反解永远指向第一段。
 *
 * 本文件**不做通用代码质量检查**。它只钉死已经收过学费的形状，判据是
 * **宁可漏、不可吵**：一条断言只要开始产生需要辩解的命中，它就该收窄或删掉，
 * 因为一个总在响的警报等于没有警报。
 *
 * 豁免：在违规行或其上一行写 `// invariant-allow: <理由>`。理由必须是实质内容，
 * 空理由不算豁免——写不出为什么，就说明这里确实该改。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 扫描范围：产品源码。测试与构建产物不在内——测试里出现这些形状是在描述它们。 */
const SOURCE_ROOTS = [
  "packages/core/src",
  "packages/engine/src",
  "apps/electron/shared",
  "apps/electron/renderer/src",
];

interface SourceFile {
  /** 仓库相对路径，POSIX 分隔符 */
  path: string;
  text: string;
}

function collectSources(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "node_modules" || name === "dist" || name === "dist-main") continue;
        walk(full);
        continue;
      }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
      files.push({ path: relative(REPO_ROOT, full).split("\\").join("/"), text: readFileSync(full, "utf8") });
    }
  };
  for (const root of SOURCE_ROOTS) walk(join(REPO_ROOT, root));
  return files;
}

const SOURCES = collectSources();

/** 该行（或其上一行）是否带着一条有实质理由的豁免注释 */
function isAllowed(lines: string[], index: number): boolean {
  for (const candidate of [lines[index], lines[index - 1]]) {
    const reason = /\/\/\s*invariant-allow:\s*(.*)$/.exec(candidate ?? "")?.[1]?.trim();
    if (reason) return true;
  }
  return false;
}

/** 把注释掏空（保留行数与列宽），只留可执行代码。 */
function stripComments(text: string): string {
  const blank = (matched: string): string => matched.replace(/[^\r\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\r\n]*/g, blank);
}

/** 掏空「」引述的内容：引用一句错注释来解释它，不等于在宣称它。 */
function stripJapaneseQuotes(text: string): string {
  return text.replace(/「[^」\r\n]*」/g, (matched) => matched.replace(/[^\r\n]/g, " "));
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/** 逐行找命中，跳过带豁免注释的行 */
function scan(files: SourceFile[], transform: (text: string) => string, pattern: RegExp): Violation[] {
  const found: Violation[] = [];
  for (const file of files) {
    const original = file.text.split(/\r?\n/);
    const lines = transform(file.text).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!pattern.test(lines[index] ?? "")) continue;
      if (isAllowed(original, index)) continue;
      found.push({ file: file.path, line: index + 1, text: (original[index] ?? "").trim() });
    }
  }
  return found;
}

function report(violations: Violation[], advice: string): string {
  const list = violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n");
  return `\n${list}\n\n${advice}\n`;
}

describe("架构不变量", () => {
  it("扫到了源码（扫描范围本身不能悄悄变空）", () => {
    // 没有这一条，任何一次目录搬迁都会让下面四条断言变成「零命中 = 通过」。
    expect(SOURCES.length).toBeGreaterThan(100);
  });

  /**
   * INV-1 单实现：同一件事不得有两个入口。
   *
   * 名单是**白名单**，只收已经出过事的名字。注意收的是能合并的那个符号（骨架函数），
   * 不是操作的俗名：`createWorkspace` 在 engine 是导出函数、在 Electron 是服务方法，
   * 形状本来就不同，按名字数个数只会既漏又吵。真正不能有两份的是它们共用的骨架。
   */
  const SINGLE_IMPLEMENTATION = [
    { name: "createWorkspaceSkeleton", why: "Q 批：译后规则播种只做了 engine 一侧，单元测试全绿而真实用户路径一条规则没生效" },
    { name: "WORKSPACE_DIRS", why: "两份目录清单已经漂移过：一边建 state/orders，一边建 checkpoints/corrections/trash" },
    { name: "WORKSPACE_SCHEMA_VERSION", why: "写进 book.yaml 的版本号与能读的上限必须是同一个数" },
    { name: "seedPostDictRules", why: "内置规则的播种点，多一处就多一条可能漏播的路径" },
    { name: "salvageJsonArray", why: "容错 JSON 解析漂移出朴素版，让整本书的术语提取报废过一次" },
    { name: "optional", why: "可选环节的降级此前有五种手写形状，第二份实现会让「什么算可选」重新变成各人各解" },
  ];

  it.each(SINGLE_IMPLEMENTATION)("INV-1 $name 全库只有一处定义", ({ name, why }) => {
    const definition = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`);
    const sites = SOURCES.flatMap((file) =>
      stripComments(file.text)
        .split(/\r?\n/)
        .map((line, index) => (definition.test(line) ? `${file.path}:${index + 1}` : null))
        .filter((entry): entry is string => entry !== null),
    );
    expect(
      sites.length,
      `\n${name} 有 ${sites.length} 处定义：\n${sites.map((s) => `  ${s}`).join("\n")}\n\n` +
        `为什么这条不能有两份：${why}。\n` +
        `同一件事两个入口迟早分叉，而且分叉那天两边的测试都是绿的。\n` +
        `改法：抽公共函数让两边都调它；确实必须两份的话，在这里说明为什么。\n`,
    ).toBe(1);
  });

  /**
   * INV-2 注释不得宣称两处实现等价。
   *
   * 词表故意窄。`与…一致` 不抓——它在本仓库大量用于描述数据契约（段落 id 顺序一致、
   * 缓存前缀字节一致），抓它会把信号淹掉。
   */
  it("INV-2 注释不得宣称与别处实现等价", () => {
    const claim = /同款|复制自|copy of|与[^\r\n]{0,24}保持同步/i;
    // 只看注释（宣称在注释里），且先掏空「」引述——引用一句错注释来解释它不是在宣称它。
    const commentsOnly = (text: string): string =>
      stripJapaneseQuotes(text)
        .split(/\r?\n/)
        .map((line) => {
          const inline = /(\/\/|\*)([^\r\n]*)$/.exec(line);
          return inline ? inline[2]! : "";
        })
        .join("\n");
    const violations = scan(SOURCES, commentsOnly, claim);
    expect(violations.length, report(violations,
      "注释宣称的等价不会被任何东西检查。`parseJsonArray` 的「与 terminologist-decide 同款」是假的，" +
      "整本书的提取因此报废过一次。\n改法：抽公共函数，让等价由结构保证；" +
      "或用 `// invariant-allow: <为什么必须两份>` 显式豁免。",
    )).toBe(0);
  });

  /**
   * INV-3 LLM 数组响应不得用朴素括号切片解析。
   *
   * max tokens 截断的响应末尾没有 `]`，`indexOf("[") … lastIndexOf("]")` 会把已经完整的
   * 几十个对象连同整次调用开销一起丢掉。数组必须走 json-salvage 的逐对象打捞。
   */
  it("INV-3 数组解析不得用朴素括号切片", () => {
    const ALLOWED = new Set([
      "packages/core/src/json-salvage.ts", // 打捞器本身
      // json-fence 的 sliceBrackets 是**对象**解析的最后手段，且失败时抛错而不是返回空
      // （extractJsonPayload 抛 JsonPayloadError）。它不会把失败伪装成「没有结果」。
      "packages/core/src/json-fence.ts",
    ]);
    const violations = SOURCES.filter((file) => !ALLOWED.has(file.path)).flatMap((file) => {
      const code = stripComments(file.text);
      if (!code.includes('lastIndexOf("]")')) return [];
      const line = code.split(/\r?\n/).findIndex((entry) => entry.includes('lastIndexOf("]")'));
      return [{ file: file.path, line: line + 1, text: (file.text.split(/\r?\n/)[line] ?? "").trim() }];
    });
    expect(violations.length, report(violations,
      "被截断的响应末尾没有 `]`，朴素切片会整批归零。\n" +
      "改法：改用 `salvageJsonArray`（@lightee/core/json-salvage），它栈式逐对象打捞，" +
      "丢弃未闭合的尾巴而保住前面完整的对象。",
    )).toBe(0);
  });

  /**
   * INV-4 定位不得由字面量凑出。
   *
   * 「不知道在哪」必须表达成不知道。写一个 `:1` 上去，下游 `resolveIssueParagraphIds`
   * 会把它当真解析成第一段，局部修订随即原子覆盖一个与问题无关的段落。
   */
  it("INV-4 审校定位不得用硬编码占位", () => {
    const placeholder = /locationFor\([^)]*,\s*\d+\s*\)|locateLine\([^)]*\)\s*\|\|\s*\d|_zh\.md:1["'`]/;
    const violations = scan(SOURCES, stripComments, placeholder);
    expect(violations.length, report(violations,
      "定位不到就只报文件名（`locationFor(..., null)`），让反解得到空数组、下游按兵不动。\n" +
      "凑一个 `:1` 会让「不知道」被读成「在第一段」，修订去改无辜段落。",
    )).toBe(0);
  });

  /**
   * INV-5 退役的译前提取链不得复活（EX-08 / ADR-0007）。
   *
   * 这条链不是「暂时没用」，是**被真实对照实验证伪的**：L0 候选池按统计特征挑词，
   * 读不出语境——全书出现 59 次的世界观核心词「星の乙女」被切成「星」+「乙女」，
   * 从来没进过候选；形态学切分产出的「はちょっ」这类半个词，L3 还照样盖章 keep:true。
   * 换来的是每本书数百万 token。
   *
   * 删掉之后，唯一会让它回来的方式是有人「顺手加一轮扫描」。这条断言就是那道门。
   * 名单只收**已经付过学费**的符号名，不做通用检查。
   */
  /**
   * INV-6 模型响应的分类不得依赖比较中文文案（KA-1）。
   *
   * 三条串——「模型未正常结束」「模型只发了工具调用」「模型返回空响应」——曾是
   * `llm-runtime` 与 `translate-one` 之间**真实的控制流契约**：产出在 llm-runtime，
   * 消费在 translate-one，llm-runtime 自己还要再 parse 一遍算 errorKind。
   * 改一个词要同时改三处，而 TypeScript 一声不吭。
   *
   * 现在这条轴是 `LlmResponseShape`。文案留着给人看——**但没有任何判断读它**。
   * 只抓比较（`===`/`!==`/`includes`），不抓字符串出现：产出文案本身是正当的。
   */
  it("INV-6 响应形状分类不得比较中文文案", () => {
    const compare = /(?:===|!==)\s*["'`]模型(?:未正常结束|只发了工具调用|返回空响应)|["'`]模型(?:未正常结束|只发了工具调用|返回空响应)["'`]\s*(?:===|!==)/;
    const violations = scan(SOURCES, (text) => stripJapaneseQuotes(stripComments(text)), compare);
    expect(violations.length, report(violations,
      "这三条串是给人看的文案，不是分类依据。分类读 `LlmResponseShape`：\n" +
      "  incomplete（未正常结束且无正文）/ tool_call_only（工具协议的正常一轮）/ empty_response\n" +
      "运行时挂在错误对象的 `shapeKind` 上，成功路径进 `WastedAttempt.shapeKind`。\n" +
      "改法：读 shapeKind。确实拿不到形状轴（如上游包装过的异常）时，在这里说明为什么。",
    )).toBe(0);
  });

  /**
   * INV-7：Agent 控制台的标签映射必须覆盖运行时真正发出的 scope 前缀。
   *
   * 学费：`AGENT_LABELS` 的键曾是角色名（orchestrator/translator/reviewer/terminologist），
   * 而运行时发的是 `translate:ch001` / `review:ch001` / `manager:ch001` / `book-review` / `probe`
   * ——**两个集合零交集**。后果是控制台一直给作者看裸 scope 串、配色全落默认档，
   * 而没有任何东西会红：映射查不到就 `?? label` 静默退化成原串。
   *
   * 判据取自源码本身：`usageScope(root, X)` 与 `label: X` 的字面量前缀，
   * **只扫服务层**（`shared/services` 与 `shared/ipc-service.ts`）——渲染层也有大量
   * 叫 `label` 的界面文案（词典名之类），扫进来只会制造需要辩解的命中，
   * 而本文件的判据是「宁可漏、不可吵」。
   *
   * 已知不覆盖：先赋给中间变量再传的标签（`const label = … ? "a" : "b"`）。
   * 那两个值今天由 `usageScope("book-review")` 的同前缀兜住；真要漏了，
   * 代价是控制台显示一次裸串，不是错误的判断。
   */
  it("INV-7 AGENT_LABELS 覆盖全部运行时 scope 前缀", () => {
    const bridge = SOURCES.find((file) => file.path.endsWith("workspace/workspace-bridge.ts"));
    expect(bridge, "找不到 workspace-bridge.ts").toBeTruthy();
    const mapBlock = /const AGENT_LABELS: Record<string, string> = \{([\s\S]*?)\n  \};/.exec(bridge!.text);
    expect(mapBlock, "AGENT_LABELS 的字面量形状变了，INV-7 需要同步").toBeTruthy();
    const keys = new Set(
      [...mapBlock![1]!.matchAll(/^\s*"?([\w:-]+)"?\s*:/gm)].map((match) => match[1]!)
    );

    // 运行时发出的标签：usageScope 的第二个参数，以及显式 label:
    const emitted = new Set<string>();
    const emitters = SOURCES.filter((file) =>
      file.path.includes("apps/electron/shared/services/") || file.path.endsWith("apps/electron/shared/ipc-service.ts")
    );
    expect(emitters.length, "服务层文件一个都没扫到，INV-7 的路径判据失效了").toBeGreaterThan(0);
    for (const file of emitters) {
      const text = stripComments(file.text);
      for (const match of text.matchAll(/usageScope\([^,]+,\s*[`"]([^`"$]*)/g)) emitted.add(match[1]!);
      for (const match of text.matchAll(/\blabel:\s*[`"]([^`"$]*)/g)) emitted.add(match[1]!);
    }

    const missing = [...emitted]
      .map((label) => label.replace(/:$/, "").split(":")[0]!)
      .filter((prefix) => prefix.length > 0 && !keys.has(prefix))
      .sort();

    expect([...new Set(missing)], [
      "运行时发出了 AGENT_LABELS 没有的 scope 前缀——控制台会把裸标签串显示给作者，",
      "`agentNodeType` 的配色也会落到默认档，而查不到时的 `?? label` 让这件事完全静默。",
      "改法：把新前缀加进 apps/electron/renderer/src/workspace/workspace-bridge.ts 的 AGENT_LABELS。",
    ].join("\n")).toEqual([]);
  });

  it("INV-5 译前提取链的退役符号零调用点", () => {
    const retired = [
      "prepareTerminology",
      "scanTermCandidates",
      "decideTerms",
      "decideByRounds",
      "reviewDecisionsDiff",
      "scanBookVoices",
      "scanBookVoiceExtraction",
      "runBookUnderstanding",
      "detectPuns",
      "collectEvidence",
    ];
    const pattern = new RegExp(`\\b(?:${retired.join("|")})\\b`);
    const violations = scan(SOURCES, (text) => stripJapaneseQuotes(stripComments(text)), pattern);
    expect(violations.length, report(violations,
      "译前提取链已在 EX-08 退役（ADR-0007）：术语随翻译逐章产出（extract-fuse），\n" +
      "不再有独立的扫描/决策/复核轮。要加新能力请挂在章后钩子上，不要重建这条链。",
    )).toBe(0);
  });
});
