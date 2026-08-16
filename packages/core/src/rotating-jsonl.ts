/**
 * 只增不减的 JSONL 追加文件的封顶机制。
 *
 * ## 为什么需要
 *
 * `~/.lightee/llm-history.jsonl` 记录每次 LLM 调用的**完整 prompt 与响应**，无条件追加。
 * 内存里的调用缓冲有上限，落盘的文件此前没有：只增不减、没有轮转、没有清理。
 * 实测每次调用平均 62 KB，一本 300 章的书按「翻译 + 审校」两次调用算就是约 37 MB，
 * 而译者会一本接一本地译。后果有三层，越往后越不易察觉：
 *
 * 1. 磁盘无声增长——用户不会知道 home 目录里有个文件在长大。
 * 2. 隐私面随时间扩大——里面是原文与译文全文，时间越久积累越多。
 * 3. 备份/同步放大——home 目录若在同步盘里，每次追加都触发几十 MB 的重传。
 *
 * ## 策略：照搬 AppLog 已经验证过的那一套
 *
 * 单文件上限 + 保留 N 份 + **按 mtime** 清理。不另造轮子，也不引第三方日志库——
 * 需要的就是这三件事，而多一个依赖就多一份供应链与打包体积负担。
 *
 * 两个细节是从 AppLog 那边继承的、有代价的经验：
 *
 * - **清理按 mtime 排序，不按文件名**：`x.jsonl` 与 `x.1.jsonl` 的字典序会把最老的那份
 *   排在后面，序号本身也是字典序（`.10` < `.2`）。mtime 是这里唯一诚实的时间源。
 * - **轮转找空闲序号，不做改名链**：逐个 `.1→.2、.2→.3` 的链式改名在 Windows 上会被
 *   仍持有句柄的杀毒/同步软件挡下，而失败的轮转会让文件从此停止写入。
 *
 * 与 AppLog 的差别只有一处：这里保持**规范路径始终是最新的那个文件**（轮转时把当前文件
 * 改名为归档、再从规范路径重新开始写）。因为读取方按固定文件名找它，规范路径不能漂移。
 *
 * ## 同步 API 的理由
 *
 * 调用点 `LlmRuntime.pushCallLog` 是同步的，且刻意如此——LLM 调用频率低，同步追加换来
 * 「不会因异步竞态丢记录」。轮转必须跟着同步，否则会在 append 与 rename 之间开出窗口。
 */
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface RotatingAppendOptions {
  /** 单文件上限；写入会使其超限时先轮转。默认 16MB */
  maxBytes?: number;
  /** 保留份数（含当前）。默认 4 —— 与 16MB 相乘即约 64MB 上限、约一千次调用 */
  maxFiles?: number;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILES = 4;

/** `llm-history.jsonl` → { stem: "llm-history", suffix: ".jsonl" } */
function splitName(filePath: string): { stem: string; suffix: string } {
  const name = basename(filePath);
  const dot = name.indexOf(".");
  return dot < 0 ? { stem: name, suffix: "" } : { stem: name.slice(0, dot), suffix: name.slice(dot) };
}

function sizeOf(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * 追加一行，必要时先轮转。
 *
 * **永不抛出**——历史写失败拖垮 LLM 调用是本末倒置。磁盘满、目录只读、路径非法都只能吞掉，
 * 这也是调用方可以不做 try/catch 的前提。
 */
export function appendLineWithRotation(filePath: string, line: string, options: RotatingAppendOptions = {}): void {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const current = sizeOf(filePath);
    // current > 0 这个条件不能省：单行本身就超限时（比如一次超大 prompt），
    // 空文件也会被判定成「需要轮转」，于是每写一行轮转一次，历史被切成一行一个文件。
    const rotated = current > 0 && current + Buffer.byteLength(line) > maxBytes;
    if (rotated) rotate(filePath);
    appendFileSync(filePath, line, "utf-8");
    // 先落盘再清理：轮转后规范路径尚不存在，此刻清理会把它算漏，结果永远多留一份。
    if (rotated) prune(filePath, maxFiles);
  } catch {
    /* 历史写失败不阻断调用 */
  }
}

/** 把当前文件改名为最小的空闲序号归档，规范路径随即空出来重新开始写 */
function rotate(filePath: string): void {
  const { stem, suffix } = splitName(filePath);
  const dir = dirname(filePath);
  let index = 1;
  while (sizeOf(join(dir, `${stem}.${index}${suffix}`)) > 0) index += 1;
  renameSync(filePath, join(dir, `${stem}.${index}${suffix}`));
}

/** 只保留最近 maxFiles 份（含规范路径本身），按 mtime 判定新旧 */
function prune(filePath: string, maxFiles: number): void {
  const { stem, suffix } = splitName(filePath);
  const dir = dirname(filePath);
  const archives = readdirSync(dir)
    .filter((name) => name.startsWith(`${stem}.`) && name.endsWith(suffix) && name !== basename(filePath))
    .map((name) => ({ name, mtime: statSyncSafe(join(dir, name)) }))
    .sort((a, b) => a.mtime - b.mtime);
  // 规范路径占掉一份配额，剩下的才是归档能留的数量
  for (const { name } of archives.slice(0, Math.max(0, archives.length - (maxFiles - 1)))) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      /* 删不掉就留着，下次再试；删除失败不该影响写入 */
    }
  }
}

function statSyncSafe(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}
