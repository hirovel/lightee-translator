/**
 * QE-01 质量对照 —— 停止 AB 之后唯一的质量评估口径。
 *
 * ## 为什么不是自动打分
 *
 * 作者的原则：**默认 LLM 有基础质量，任务是提质而不是防范基础问题**。
 * 自动指标（长度比、词表覆盖、胜率矩阵）测的都是「有没有出基础错」，
 * 而那正是不再需要盯的东西。译得好不好只能读出来——所以这个脚本只做一件事：
 * **把三份文本按段落对齐摆好，让人一眼看得见差别**。它不下判断。
 *
 * ## 三栏
 *
 *   原文 · 程序译文 · 参照译文
 *
 * 参照译文有两个来源，任选其一：
 *   - `--reference <文件>`：作者朋友的 SR26/SSR26 人译（`packages/engine/fixtures/reference/`）
 *   - `--reference <文件>`：subagent（Claude）翻同一章后存下的稿
 * 两者对脚本没有区别——它只负责对齐与呈现。
 *
 * ## 对齐
 *
 * 按段落序号硬对齐（第 n 段对第 n 段）。段数不一致时**如实报出来并继续**，
 * 不做智能匹配：猜出来的对齐会让读者把「对错了行」当成「译得不同」。
 *
 * 用法：
 *   node scripts/compare-translation.mjs --source <ja.txt> --translation <zh.md> --reference <ref.txt> [--out <路径>]
 *   node scripts/compare-translation.mjs --workspace <工作区> --chapter ch001 --reference <ref.txt>
 *
 * 产物落 `runs/`（gitignored：含正文，只留本地）。
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// 走 engine 的再导出：apps/electron 只链接了 @lightee/engine。
// 用生产的同一个分段器，对齐才与管线看到的段落一致。
import { buildParagraphs } from "@lightee/engine";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function usage(message) {
  console.error(message);
  console.error("用法：node scripts/compare-translation.mjs --source <ja> --translation <zh> --reference <ref> [--out <路径>]");
  console.error("     node scripts/compare-translation.mjs --workspace <root> --chapter ch001 --reference <ref>");
  process.exit(1);
}

/** 段落文本数组。空段落丢弃——它们在三份文本里未必对称，留着只会把对齐推歪。 */
async function paragraphsOf(path) {
  const raw = await readFile(path, "utf-8");
  return buildParagraphs(raw).map((p) => p.text.trim()).filter(Boolean);
}

const workspace = arg("workspace");
const chapter = arg("chapter");
let sourcePath = arg("source");
let translationPath = arg("translation");
const referencePath = arg("reference");

if (workspace && chapter) {
  // 译文优先取定稿，没有就取暂存稿——翻完未定稿是最常见的状态
  const staged = join(workspace, "state", "staging", `${chapter}_zh.md`);
  const promoted = join(workspace, "translations", `${chapter}_zh.md`);
  translationPath = existsSync(promoted) ? promoted : staged;
  const manifestPath = join(workspace, "source", "manifest.json");
  if (!existsSync(manifestPath)) usage(`找不到 ${manifestPath}`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  const entry = (manifest.chapters ?? []).find((c) => c.id === chapter);
  if (!entry) usage(`manifest 里没有章节 ${chapter}`);
  sourcePath = join(workspace, "source", entry.volume ?? "v01", `${chapter}.md`);
}

if (!sourcePath || !translationPath || !referencePath) usage("缺少 --source / --translation / --reference");
for (const [label, path] of [["源文", sourcePath], ["程序译文", translationPath], ["参照译文", referencePath]]) {
  if (!existsSync(path)) usage(`${label}不存在：${path}`);
}

const [source, translation, reference] = await Promise.all([
  paragraphsOf(sourcePath),
  paragraphsOf(translationPath),
  paragraphsOf(referencePath),
]);

const counts = { 源文: source.length, 程序译文: translation.length, 参照译文: reference.length };
const aligned = Math.max(source.length, translation.length, reference.length);
const mismatch = new Set(Object.values(counts)).size > 1;

const lines = [
  "# 译文对照（QE-01）",
  "",
  `- 源文：\`${sourcePath}\``,
  `- 程序译文：\`${translationPath}\``,
  `- 参照译文：\`${referencePath}\``,
  `- 段数：源文 ${source.length} · 程序 ${translation.length} · 参照 ${reference.length}`,
  "",
];

if (mismatch) {
  lines.push(
    "> **段数不一致。** 下面按序号硬对齐，超出的一侧留空。",
    "> 不做智能匹配：猜出来的对齐会让「对错了行」看起来像「译得不同」。",
    "",
  );
}

lines.push(
  "本文件**不含任何判断**，只是把三份文本摆在一起。读的时候找的是：",
  "语气是否立得住、称呼与人称是否稳定、长句节奏、拟声词与语气词的处理、专名一致性。",
  "",
  "---",
  "",
);

for (let i = 0; i < aligned; i += 1) {
  lines.push(`## ${String(i + 1).padStart(4, "0")}`, "");
  lines.push("**原文**", "", "```", source[i] ?? "（无）", "```", "");
  lines.push("**程序译文**", "", "```", translation[i] ?? "（无）", "```", "");
  lines.push("**参照译文**", "", "```", reference[i] ?? "（无）", "```", "");
  lines.push("---", "");
}

const outPath = arg("out") ?? join(repoRoot, "runs", `compare-${chapter ?? "chapter"}.md`);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, lines.join("\n"), "utf-8");

console.log(`对照文件：${outPath}`);
console.log(`段数：源文 ${source.length} · 程序 ${translation.length} · 参照 ${reference.length}${mismatch ? "（不一致，已在文件开头标注）" : ""}`);
console.log("这个脚本不打分。质量判断在读的人那里。");
