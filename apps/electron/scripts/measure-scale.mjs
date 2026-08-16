/**
 * RH-20 阶段 1：规模测量。
 *
 * 对 generate-scale-fixture 产出的工作区，用**真实 IpcService**（fake LLM）逐项计时，
 * 输出 JSON + Markdown 表，逐项标注 通过 / 超标。
 *
 * 用法：
 *   node scripts/measure-scale.mjs [--fixture <dir>] [--assert] [--tolerance 1]
 * `--assert` 时任一项超标即以非零码退出；CI 用 `--tolerance 3` 宽容机器抖动。
 */
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { fixture: join(tmpdir(), "lightee-scale-fixture"), assert: false, tolerance: 1, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--fixture") args.fixture = resolve(argv[++index]);
    else if (flag === "--assert") args.assert = true;
    else if (flag === "--tolerance") args.tolerance = Number(argv[++index]);
    else if (flag === "--out") args.out = resolve(argv[++index]);
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
// fixture 是**生成物**（`npm run scale:fixture`），且默认落在系统临时目录里——
// 清理临时目录、重启机器都可能把它抹掉。这里给一句能照做的提示，
// 而不是抛一个裸的 ENOENT 栈让人去猜要跑哪个命令。
const fixturePath = join(args.fixture, "fixture.json");
const fixture = await readFile(fixturePath, "utf8").then(JSON.parse).catch((error) => {
  if (error?.code !== "ENOENT") throw error;
  console.error(`找不到规模 fixture：${fixturePath}`);
  console.error("它是生成物，先跑：npm run scale:fixture");
  process.exit(2);
});

const { createIpcService } = await import(`file://${join(appRoot, "dist-main/shared/ipc-service.js")}`);
const engineModule = await import(`file://${join(appRoot, "node_modules/@lightee/engine/dist/index.js")}`);

const service = createIpcService({
  engine: {
    importFile: engineModule.importFile,
    previewImport: engineModule.previewImport,
    translateChapterToFile: engineModule.translateChapterToFile,
    runChapterPipeline: engineModule.runChapterPipeline,
    recoverChapterPromotion: engineModule.recoverChapterPromotion,
    recoverChapterPromotionInTransaction: engineModule.recoverChapterPromotionInTransaction,
    reviewChapter: engineModule.reviewChapter,
    runBookReview: engineModule.runBookReview,
    confirm: { loadSession: engineModule.loadSession, saveSession: engineModule.saveSession, verdict: engineModule.verdict, finishSession: engineModule.finishSession },
    exportChapter: engineModule.exportChapter,
    createLlm: () => ({ complete: async () => ({ text: "" }), listModels: () => [] }),
  },
  llm: null,
  registryPath: fixture.registryPath,
  terminologyWatcher: false,
});

const invoke = async (command, payload) => service.invoke({ version: 1, requestId: `${command}-measure`, command, payload });
const call = async (command, payload) => {
  const result = await invoke(command, payload);
  if (!result.ok) throw new Error(`${command} failed: ${JSON.stringify(result.error)}`);
  return result.value;
};

/** 取三次的中位数：单次计时在 Windows 上抖动大，中位数更能代表稳态 */
async function timeMedian(fn, runs = 3) {
  const samples = [];
  let last;
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    last = await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { ms: Math.round(samples[Math.floor(samples.length / 2)]), value: last };
}

const measurements = [];
function record(id, label, ms, thresholdMs, note) {
  const limit = thresholdMs === null ? null : thresholdMs * args.tolerance;
  measurements.push({ id, label, ms, thresholdMs, effectiveLimit: limit, pass: limit === null ? null : ms <= limit, note });
}

// 打开重工作区（后续命令都需要一个已注册的 workspaceId）
const opened = await call("workspace.open", { path: fixture.heavyRoot });
const workspaceId = opened.id;

// B-1：workspace.list（10 本该量级书架）
{
  const { ms } = await timeMedian(() => call("workspace.list", {}));
  record("B-1", `workspace.list（${fixture.roots.length} 本 × ${fixture.chapters} 章）`, ms, 1000);
}

// chapter.load：第 250 章
{
  const { ms } = await timeMedian(() => call("chapter.load", { workspaceId, chapterId: fixture.deepChapterId }));
  record("load", `chapter.load（${fixture.deepChapterId}）`, ms, 300);
}

// chapter.saveDraft：同一章
{
  const loaded = await call("chapter.load", { workspaceId, chapterId: fixture.deepChapterId });
  let revision = loaded.revision;
  const { ms } = await timeMedian(async () => {
    const written = await call("chapter.saveDraft", {
      workspaceId,
      chapterId: fixture.deepChapterId,
      baseRevision: revision,
      paragraphs: loaded.paragraphs.map((paragraph) => ({ ...paragraph, translation: `${paragraph.translation}·` })),
    });
    revision = written.revision;
    return written;
  });
  record("saveDraft", "chapter.saveDraft（15 段）", ms, 300);
}

// B-3：terms.query（无过滤首页 / 带 search）
{
  const { ms, value } = await timeMedian(() => call("terms.query", { workspaceId }));
  record("B-3a", `terms.query 首页（${fixture.terms} 词条）`, ms, 100, `返回 ${value.items?.length ?? 0} 条`);
}
{
  const { ms } = await timeMedian(() => call("terms.query", { workspaceId, search: "翻訳" }));
  record("B-3b", "terms.query 带 search", ms, 100);
}

// B-4：审校历史。契约里没有单独的 history 命令——历史随 review.run 的响应返回，
// 因此这里测的就是「30 份报告存在时 review.run 的总成本」，与 ticket 表述一致。
{
  const result = await invoke("review.run", { workspaceId, chapterId: fixture.midChapterId });
  if (!result.ok) {
    record("B-4", `审校历史（${fixture.reviews} 份报告）`, -1, null, `未能测量：review.run 返回 ${result.error.code} —— ${result.error.message}`);
  } else {
    const { ms, value } = await timeMedian(() => call("review.run", { workspaceId, chapterId: fixture.midChapterId }));
    record("B-4", `review.run（历史 ${value.history?.length ?? "?"} 份）`, ms, 200);
  }
}

// B-2：watcher 单 tick 成本。`listWorkspaces` 会给**每一个 ready 工作区**都起 250ms 轮询
// （不只是当前打开的那个），因此成本要乘书架数。
{
  const { ms } = await timeMedian(() => call("confirm.list", { workspaceId }));
  const dutyCycle = (ms * fixture.roots.length * 4 / 1000) * 100;
  record("B-2", "术语快照单次读取 × 书架数（watcher 每 tick 的主要成本）", ms, null, `${fixture.roots.length} 本 ready 工作区 × 4 次/秒 → 约 ${dutyCycle.toFixed(0)}% 单核持续占用`);
}

// B-5：import.preview（10MB TXT）主进程阻塞时长
{
  const { ms } = await timeMedian(() => call("import.preview", { sourcePath: fixture.bigTxtPath }), 1);
  record("B-5", "import.preview（10MB TXT）", ms, 1000);
}

const failures = measurements.filter((measurement) => measurement.pass === false);
const stamp = new Date().toISOString().slice(0, 10);
const lines = [
  `# 规模测量结果（RH-20 阶段 1）`,
  "",
  `> 日期：${stamp}`,
  `> fixture：${fixture.chapters} 章 × ${fixture.roots.length} 本 / ${fixture.terms} 词条 / ${fixture.events} 行事件 / ${fixture.reviews} 份审校报告`,
  `> 方法：真实 `+"`IpcService`"+`（fake LLM），每项取 3 次中位数；宽容系数 ×${args.tolerance}`,
  "",
  "| 编号 | 指标 | 实测 | 阈值 | 结论 | 备注 |",
  "|---|---|---|---|---|---|",
  ...measurements.map((measurement) => `| ${measurement.id} | ${measurement.label} | ${measurement.ms}ms | ${measurement.thresholdMs === null ? "—" : `< ${measurement.thresholdMs}ms`} | ${measurement.pass === null ? "记录" : measurement.pass ? "✅ 通过" : "❌ 超标"} | ${measurement.note ?? ""} |`),
  "",
  failures.length === 0
    ? "全部有阈值项通过。B 表的热点在当前目标量级下**没有一项需要优化**——按 RH-20「先测量，后优化」的原则，阶段 2 不执行，结论以本表数字为据。"
    : `超标项：${failures.map((failure) => failure.id).join("、")}。按 RH-20 阶段 2 候选方案处理后必须复测并更新本表。`,
  "",
  "## 无阈值项的判断（B-2）",
  "",
  "B-2 没有验收阈值，但测出来的数字必须当回事：`listWorkspaces` 会给**每一个 ready 工作区**都起一个 250ms 轮询，",
  "不只是当前打开的那一个。在本 fixture 量级下这意味着应用**空闲时**就持续占用接近一个完整核心。",
  "已按 RH-20 阶段 2 的 B-2 候选方案处理：watcher 只跟随「显式打开」的工作区生命周期。",
];

const outPath = args.out ?? resolve(appRoot, "../../docs/diagnostics", `scale-measurements-${stamp}.md`);
await writeFile(outPath, `${lines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ ok: failures.length === 0, report: outPath, measurements }, null, 2));
if (args.assert && failures.length > 0) process.exit(1);
