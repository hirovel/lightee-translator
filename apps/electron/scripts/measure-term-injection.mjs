/**
 * R2-1 测量闸门（成本一侧）——对一个真实工作区跑两种术语注入模式的等效全价对照。
 *
 *   node scripts/measure-term-injection.mjs <workspace-root> [--cache-read 0.1] [--cache-write 1]
 *
 * 输出的是**确定性算术**：注入量与计费方式先验可算，不需要调用模型、不花钱。
 * 另一半（术语遵从率）必须用真实模型跑同一本书两遍才能得到，本脚本不代答，
 * 也不允许只凭成本数字就把默认值改成 frozen。
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { measureTermInjection } from "@lightee/engine";

const [rootArg, ...rest] = process.argv.slice(2);
if (!rootArg) {
  console.error("用法: node scripts/measure-term-injection.mjs <workspace-root> [--cache-read 0.1] [--cache-write 1]");
  process.exit(2);
}
const root = resolve(rootArg);
const flag = (name, fallback) => {
  const index = rest.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(rest[index + 1]);
  return Number.isFinite(value) ? value : fallback;
};

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return fallback;
  }
}

const snapshot = await readJson(join(root, "state", "terminology-snapshot.json"), null);
const archives = snapshot?.archives ?? {
  names: await readJson(join(root, "terminology", "names.json"), []),
  terms: await readJson(join(root, "terminology", "terms.json"), []),
  noTranslate: await readJson(join(root, "terminology", "no-translate.json"), []),
};
const terms = [...(archives.names ?? []), ...(archives.terms ?? [])]
  .filter((entry) => typeof entry?.ja === "string" && entry.ja)
  .map((entry) => ({ ja: entry.ja, zh: typeof entry.zh === "string" ? entry.zh : "" }));
const noTranslate = (archives.noTranslate ?? [])
  .filter((entry) => typeof entry?.ja === "string" && entry.ja && entry.enabled !== false)
  .map((entry) => ({ ja: entry.ja }));

const manifest = await readJson(join(root, "source", "manifest.json"), { chapters: [] });
const chapters = [];
for (const meta of manifest.chapters ?? []) {
  const candidates = [
    join(root, "source", meta.volume ?? "", `${meta.id}.md`),
    join(root, "source", `${meta.id}.md`),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) continue;
  chapters.push({ id: meta.id, source: await readFile(path, "utf-8") });
}
if (chapters.length === 0) {
  const dir = join(root, "source");
  if (existsSync(dir)) {
    for (const name of await readdir(dir)) {
      if (name.endsWith(".md")) chapters.push({ id: name.replace(/\.md$/, ""), source: await readFile(join(dir, name), "utf-8") });
    }
  }
}

const measure = measureTermInjection({
  terms,
  noTranslate,
  chapters,
  cacheReadRatio: flag("cache-read", 0.1),
  cacheWriteRatio: flag("cache-write", 1),
});

const avgHits = measure.subsetHitsPerChapter.length
  ? (measure.subsetHitsPerChapter.reduce((a, b) => a + b, 0) / measure.subsetHitsPerChapter.length).toFixed(1)
  : "0";

console.log(`工作区        ${root}`);
console.log(`章节数        ${measure.chapters}`);
console.log(`术语条数      ${measure.termCount}（禁翻 ${noTranslate.length}）`);
console.log(`冻结块        ${measure.frozenBlockTokens} token`);
console.log(`逐章命中      平均 ${avgHits} 条`);
console.log(`价比          cacheRead ${measure.cacheReadRatio} · cacheWrite ${measure.cacheWriteRatio}`);
console.log("");
console.log(`稳态每章成本     subset ${measure.subsetTokensPerChapter} token vs frozen ${measure.frozenSteadyStateTokensPerChapter} token`);
console.log(`（长期胜负只看这一行：章数够多时首章的缓存写会被摊薄掉）`);
console.log("");
console.log(`subset 等效全价  ${measure.subsetEquivalentFullPrice} token`);
console.log(`frozen 等效全价  ${measure.frozenEquivalentFullPrice} token`);
console.log(`盈亏平衡章数     ${measure.breakEvenChapters ?? "永不（读价过高）"}`);
console.log(`成本一侧结论     ${measure.verdict}`);
console.log("");
console.log("注意：这只是成本一侧。改默认值前必须补上真实模型的术语遵从率对照——");
console.log("      便宜但更容易漏术语的模式不该因为成本数字漂亮就被选中。");
