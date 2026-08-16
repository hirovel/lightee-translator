/**
 * R2-4 批量粒度标定 —— 同一章按不同批量配置各跑一遍，产出确定性读数。
 *
 *   node scripts/measure-batch-size.mjs [--chapter <file>] [--repeat 1]
 *
 * 走的是**生产代码路径**（translateChapterToFile + 段落门禁 + 分批阶梯），
 * 模型换成结构忠实的假模型：它按请求里的段落 id 逐段回话，因此调用次数、批数、
 * 每次实际发出的 system/user 体量都是真实的。
 *
 * 不在这里的：耗时与术语遵从率。前者假模型量不出，后者只有真实模型能回答——
 * 这两列必须用真实调用补，本脚本不代答，也不假装它们已经被测过。
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace, translateChapterToFile } from "@lightee/engine";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "..", "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : argv[index + 1];
};

const chapterPath = resolve(flag("chapter", join(repoRoot, "packages", "engine", "fixtures", "reference", "SSR26-ver1.txt")));
const repeat = Math.max(1, Number(flag("repeat", 1)) || 1);
const base = await readFile(chapterPath, "utf-8");
const source = Array.from({ length: repeat }, () => base).join("\n\n");

/** 结构忠实的假模型：逐段回话，段落 id 原样返回，因此永远通过门禁 */
function fakeLlm(record) {
  return {
    complete: async (_model, messages, opts) => {
      const system = messages[0].content;
      const user = messages[messages.length - 1].content;
      const ids = [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((m) => m[1]);
      record.calls.push({ systemChars: system.length, userChars: user.length, paragraphs: ids.length, maxTokens: opts?.maxTokens });
      return { text: ids.map((id) => `<paragraph id="${id}">译文</paragraph>`).join("\n") };
    },
  };
}

const CONFIGS = [
  { label: "整章单发（8k 输出上限）", maxTokens: 8192, batchChars: 4000 },
  { label: "输出上限 4k · 批 3000 字", maxTokens: 4096, batchChars: 3000 },
  { label: "输出上限 4k · 批 1500 字", maxTokens: 4096, batchChars: 1500 },
  { label: "输出上限 4k · 批 800 字", maxTokens: 4096, batchChars: 800 },
  { label: "输出上限 2k · 批 800 字", maxTokens: 2048, batchChars: 800 },
];

const rows = [];
for (const config of CONFIGS) {
  const dir = await mkdtemp(join(tmpdir(), "lightee-r24-"));
  try {
    const ws = await createWorkspace(dir, { name: "批量标定" });
    await mkdir(join(dir, "source", "v01"), { recursive: true });
    await mkdir(join(dir, "translations", "v01"), { recursive: true });
    await mkdir(join(dir, "terminology"), { recursive: true });
    await mkdir(join(dir, "state"), { recursive: true });
    await writeFile(join(dir, "source", "v01", "ch001.md"), source, "utf-8");
    await writeFile(
      join(dir, "source", "manifest.json"),
      JSON.stringify({ book: "b", chapters: [{ id: "ch001", title: "ch1", volume: "v01" }] })
    );
    const record = { calls: [] };
    const result = await translateChapterToFile(ws, "ch001", fakeLlm(record), {
      project: { name: "b", srcLang: "ja", tgtLang: "zh" },
      agents: {},
      translation: { mode: "balanced", concurrency: 1, batchChars: config.batchChars, maxTokens: config.maxTokens },
    });
    const systemChars = record.calls.reduce((sum, call) => sum + call.systemChars, 0);
    const userChars = record.calls.reduce((sum, call) => sum + call.userChars, 0);
    rows.push({
      label: config.label,
      calls: record.calls.length,
      paragraphsPerCall: record.calls.length ? (record.calls.reduce((s, c) => s + c.paragraphs, 0) / record.calls.length).toFixed(1) : "0",
      systemResent: record.calls.length - 1,
      systemChars,
      userChars,
      // system 每批重发一次：命中前缀缓存时这部分近乎免费，未命中时是全价重复账单
      repeatedSystemShare: systemChars + userChars === 0 ? "0%" : `${Math.round((systemChars * (record.calls.length - 1) / Math.max(1, record.calls.length)) / (systemChars + userChars) * 100)}%`,
      outputChars: result.charCount,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(`章节        ${chapterPath}`);
console.log(`源文规模    ${source.length} 字符（repeat=${repeat}）`);
console.log("");
const pad = (value, width) => String(value).padEnd(width);
console.log(`${pad("配置", 30)}${pad("调用", 6)}${pad("段/次", 8)}${pad("system 字符", 14)}${pad("user 字符", 12)}${pad("重复 system 占比", 18)}译文字符`);
for (const row of rows) {
  console.log(
    `${pad(row.label, 30)}${pad(row.calls, 6)}${pad(row.paragraphsPerCall, 8)}${pad(row.systemChars, 14)}${pad(row.userChars, 12)}${pad(row.repeatedSystemShare, 18)}${row.outputChars}`
  );
}
console.log("");
console.log("读法：批越小，system 被重发的次数越多；命中前缀缓存时这部分近乎免费，");
console.log("      未命中时就是成倍的重复账单——所以「调小批量」的代价高度依赖缓存是否生效。");
console.log("缺列：耗时与术语遵从率需要真实模型跑同一组配置才能得到，本脚本不代答。");
