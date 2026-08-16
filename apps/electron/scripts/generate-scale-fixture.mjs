/**
 * RH-20 阶段 1：合成规模 fixture。
 *
 * 目标量级（架构评估 §B）：300 章 / 每章约 3k 字 / 5000 词条 / 30 份审校报告 /
 * 20000 行章节事件 / 书架注册 10 个该量级工作区。
 *
 * **确定性**：内容全部由固定种子的线性同余发生器产生，不使用时间戳与随机数，
 * 重复运行得到逐字节相同的工作区（时间戳字段除外，见下）。这样测量结果才可比。
 *
 * 用法：
 *   node scripts/generate-scale-fixture.mjs [--out <dir>] [--chapters 300] [--books 10]
 * 默认输出到系统临时目录下的 lightee-scale-fixture/，并打印 JSON 描述供 measure-scale 使用。
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { out: join(tmpdir(), "lightee-scale-fixture"), chapters: 300, books: 10, terms: 5000, events: 20000, reviews: 30 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--out") args.out = resolve(argv[++index]);
    else if (flag === "--chapters") args.chapters = Number(argv[++index]);
    else if (flag === "--books") args.books = Number(argv[++index]);
    else if (flag === "--terms") args.terms = Number(argv[++index]);
    else if (flag === "--events") args.events = Number(argv[++index]);
    else if (flag === "--reviews") args.reviews = Number(argv[++index]);
  }
  return args;
}

/** 固定种子 LCG：同一 seed 永远产出同一序列 */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const KANA = [..."あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"];
const KANJI = [..."日本語小説翻訳作業世界時間人物場面言葉物語魔法学園騎士王国"];
const HANZI = [..."这是稳定的中文译文段落内容一二三四五六七八九十"];

function japaneseLine(random, length) {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += random() < 0.3 ? KANJI[Math.floor(random() * KANJI.length)] : KANA[Math.floor(random() * KANA.length)];
  }
  return out;
}
function chineseLine(random, length) {
  let out = "";
  for (let index = 0; index < length; index += 1) out += HANZI[Math.floor(random() * HANZI.length)];
  return out;
}

/** 单章约 3k 字：15 段 × 200 字 */
function chapterBody(random) {
  const paragraphs = [];
  for (let index = 0; index < 15; index += 1) paragraphs.push(japaneseLine(random, 200));
  return paragraphs;
}

const args = parseArgs(process.argv.slice(2));
const heavyRoot = join(args.out, "book-01");

await rm(args.out, { recursive: true, force: true });
await mkdir(args.out, { recursive: true });

// ===== 1. 用真实 IpcService 建工作区并导入，保证目录结构与生产完全一致 =====
const { createIpcService } = await import(`file://${join(appRoot, "dist-main/shared/ipc-service.js")}`);
const engineModule = await import(`file://${join(appRoot, "node_modules/@lightee/engine/dist/index.js")}`).catch(() => null);
if (!engineModule) throw new Error("找不到 @lightee/engine 构建产物，请先 npm run build:main");

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
    confirm: {
      loadSession: engineModule.loadSession,
      saveSession: engineModule.saveSession,
      verdict: engineModule.verdict,
      finishSession: engineModule.finishSession,
    },
    exportChapter: engineModule.exportChapter,
    createLlm: () => ({ complete: async () => ({ text: "" }), listModels: () => [] }),
  },
  llm: null,
  registryPath: join(args.out, "workspaces.json"),
  terminologyWatcher: false,
});
const call = async (command, payload) => {
  const result = await service.invoke({ version: 1, requestId: `${command}-fixture`, command, payload });
  if (!result.ok) throw new Error(`${command} failed: ${JSON.stringify(result.error)}`);
  return result.value;
};

await mkdir(heavyRoot, { recursive: true });
const created = await call("workspace.create", { path: heavyRoot, name: "规模压测样本" });
const workspaceId = created.id;

const random = rng(20260809);
const sourceLines = [];
for (let index = 1; index <= args.chapters; index += 1) {
  sourceLines.push(`第${index}章 规模样本`);
  sourceLines.push("");
  for (const paragraph of chapterBody(random)) { sourceLines.push(paragraph); sourceLines.push(""); }
}
const sourcePath = join(args.out, "scale-source.txt");
await writeFile(sourcePath, sourceLines.join("\n"), "utf8");
console.error(`[fixture] 导入 ${args.chapters} 章…`);
const imported = await call("import.run", { workspaceId, sourcePath });
if (imported.chapters !== args.chapters) throw new Error(`导入章数不符：${imported.chapters} != ${args.chapters}`);

// ===== 2. 术语快照：5000 词条按五档案分布 =====
console.error(`[fixture] 写入 ${args.terms} 条术语…`);
const ARCHIVES = ["names", "terms", "voice", "onomatopoeia", "puns"];
const archives = { names: [], terms: [], voice: [], onomatopoeia: [], puns: [] };
for (let index = 0; index < args.terms; index += 1) {
  const archive = ARCHIVES[index % ARCHIVES.length];
  archives[archive].push({
    id: `term-${String(index).padStart(5, "0")}`,
    ja: japaneseLine(random, 4),
    zh: chineseLine(random, 4),
    type: archive === "names" ? "name" : archive === "puns" ? "pun" : archive === "voice" ? "voice" : archive === "onomatopoeia" ? "onomatopoeia" : "term",
    status: "confirmed",
    confidence: 0.9,
    updatedAt: 1_760_000_000_000 + index,
  });
}
await writeFile(join(heavyRoot, "state", "terminology-snapshot.json"), JSON.stringify({
  schemaVersion: 1, revision: 1, updatedAt: 1_760_000_000_000, archives, trash: [], lastCommit: null, operations: [],
}), "utf8");
await writeFile(join(heavyRoot, "state", "terminology-status.json"), JSON.stringify({
  status: "confirmed", cardCount: args.terms, pendingCount: 0, confirmedCount: args.terms, updatedAt: 1_760_000_000_000, extractionId: "scale-fixture",
}), "utf8");

// ===== 3. 一半章节标为已翻译并落译文（模拟真实使用中的混合状态） =====
console.error("[fixture] 写入译文与章节状态…");
const statePath = join(heavyRoot, "state", "chapter_state.json");
const manifestJson = JSON.parse(await readFile(join(heavyRoot, "source", "manifest.json"), "utf8"));
const chapterIds = manifestJson.chapters.map((chapter) => chapter.id).sort();
if (chapterIds.length === 0) throw new Error("导入后 manifest 为空，fixture 生成中止");
// chapter_state.json 直到有章节被触碰才会存在。用真实的 ChapterStateStore 建出第一条，
// 拿到权威的条目形状后再批量克隆——比手写 schema 更不容易写出「看起来对」的假数据。
const store = new engineModule.ChapterStateStore(heavyRoot);
await store.ensureChapter(chapterIds[0]);
const state = JSON.parse(await readFile(statePath, "utf8"));
const template = state.chapters[chapterIds[0]];
for (const chapterId of chapterIds) state.chapters[chapterId] ??= { ...template, chapterId };
await mkdir(join(heavyRoot, "translations"), { recursive: true });
const approvedIds = [];
for (let index = 0; index < chapterIds.length; index += 1) {
  const chapterId = chapterIds[index];
  if (index % 2 === 1) continue; // 一半保持未翻译
  approvedIds.push(chapterId);
  const body = [];
  for (let p = 0; p < 15; p += 1) body.push(chineseLine(random, 200));
  await writeFile(join(heavyRoot, "translations", `${chapterId}_zh.md`), body.join("\n\n"), "utf8");
  state.chapters[chapterId] = { ...state.chapters[chapterId], state: "approved", attempt: 1, everApproved: true };
}
await writeFile(statePath, JSON.stringify(state), "utf8");

// ===== 4. 事件日志：20000 行（审计轨迹，非状态权威） =====
console.error(`[fixture] 追加 ${args.events} 行事件…`);
const chain = [["imported", "ready"], ["ready", "translating"], ["translating", "translated"], ["translated", "reviewing"], ["reviewing", "approved"]];
const eventLines = [];
for (let index = 0; index < args.events; index += 1) {
  const chapterId = chapterIds[index % chapterIds.length];
  const [from, to] = chain[index % chain.length];
  eventLines.push(JSON.stringify({ chapterId, from, to, at: 1_760_000_000_000 + index, runId: `scale-${index % 97}`, reason: `${from} -> ${to}` }));
}
await writeFile(join(heavyRoot, "state", "events.jsonl"), `${eventLines.join("\n")}\n`, "utf8");

// ===== 5. 审校报告历史：30 份 =====
console.error(`[fixture] 写入 ${args.reviews} 份审校报告…`);
const reviewDir = join(heavyRoot, "reviews");
await mkdir(reviewDir, { recursive: true });
const targetChapter = chapterIds[Math.floor(chapterIds.length / 2)];
for (let index = 0; index < args.reviews; index += 1) {
  await writeFile(join(reviewDir, `${targetChapter}_rev_${String(index).padStart(3, "0")}.json`), JSON.stringify({
    reportId: `rev_scale_${index}`, chapterId: targetChapter, generatedAt: new Date(1_760_000_000_000 + index * 1000).toISOString(), issueCount: 0, issues: [],
  }), "utf8");
}

// ===== 6. 书架：复制成 N 本同量级工作区并全部注册 =====
console.error(`[fixture] 复制为 ${args.books} 本书架…`);
const roots = [heavyRoot];
for (let index = 2; index <= args.books; index += 1) {
  const clone = join(args.out, `book-${String(index).padStart(2, "0")}`);
  await cp(heavyRoot, clone, { recursive: true });
  roots.push(clone);
}
for (const root of roots.slice(1)) await call("workspace.open", { path: root });

// 10MB TXT：import.preview 主进程阻塞时长测量用
const bigTxtPath = join(args.out, "big-10mb.txt");
if (!existsSync(bigTxtPath)) {
  const block = `第1章 大文件\n\n${japaneseLine(rng(7), 2000)}\n\n`;
  const times = Math.ceil((10 * 1024 * 1024) / Buffer.byteLength(block, "utf8"));
  await writeFile(bigTxtPath, block.repeat(times), "utf8");
}

const manifest = {
  out: args.out,
  registryPath: join(args.out, "workspaces.json"),
  heavyRoot,
  workspaceId,
  roots,
  chapters: args.chapters,
  chapterIds,
  approvedIds,
  midChapterId: chapterIds[Math.floor(chapterIds.length / 2)],
  deepChapterId: chapterIds[Math.min(249, chapterIds.length - 1)],
  terms: args.terms,
  events: args.events,
  reviews: args.reviews,
  bigTxtPath,
};
await writeFile(join(args.out, "fixture.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log(JSON.stringify(manifest, null, 2));
