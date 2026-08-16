/**
 * 滚动文件日志（RH-21 / 架构评估 C-1）。
 *
 * 崩溃之后必须有现场。此前唯一的日志是 Agent 控制台的内存环形缓冲——进程一没，
 * 什么都不剩，用户能提供的只有「它崩了」。
 *
 * **不引第三方**（`electron-log` 等）：需要的功能就是「按天开文件 + 超限轮转 + 保留 N 份」，
 * 六十行能写完，而多一个主进程依赖就多一份供应链与打包体积的负担。这个取舍记录在
 * `docs/tickets/RH-21-ops-maturity.md`。
 *
 * ## 脱敏红线
 *
 * 日志**永不**写入 API key、prompt、译文正文。这不是「尽量避免」——译文正文是用户的
 * 作品，prompt 里含原文，key 是凭据；三者任何一个落进一个会长期留在磁盘上、用户还会
 * 打包发给别人排障的文件，都是数据事故。因此 `write()` 无条件对每一行做 `redactForLog`，
 * 而不是指望每个调用点自觉。截断上限同时兜住「有人把整章正文当 message 传进来」。
 *
 * 完整 prompt/response 仍然只在 Agent 控制台的内存缓冲里（且仅 dev 展示全文）。
 */
import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_MESSAGE_CHARS = 512;

/** key 形态的凭据：`sk-` 前缀、Bearer token、以及 JSON 里的 key/token 字段 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***"],
  [/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***"],
  [/("(?:api[_-]?key|refresh[_-]?token|access[_-]?token|key|token)"\s*:\s*)"[^"]*"/gi, '$1"***"'],
];

/**
 * 单行脱敏。顺序固定：先抹凭据，再截断——反过来的话，一条超长的行会先被截掉尾部，
 * 而凭据可能正好在被保留的前半段里。
 */
export function redactForLog(message: string): string {
  let text = message;
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  text = text.replace(/[\r\n]+/g, " ");
  if (text.length > MAX_MESSAGE_CHARS) {
    return `${text.slice(0, MAX_MESSAGE_CHARS)}…[truncated ${text.length - MAX_MESSAGE_CHARS} chars]`;
  }
  return text;
}

export type LogLevel = "info" | "warn" | "error";

export interface AppLogOptions {
  dir: string;
  /** 单文件上限；超过后轮转。默认 5MB */
  maxBytes?: number;
  /** 保留份数（含当前）。默认 5 */
  maxFiles?: number;
  /** 时间源（测试注入） */
  now?: () => number;
}

export class AppLog {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly now: () => number;
  /** 串行化写入：轮转期间不得有并发 append 落到正在被改名的文件上 */
  private queue: Promise<void> = Promise.resolve();
  private currentPath: string | null = null;
  private currentBytes = 0;
  private closed = false;

  constructor(options: AppLogOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 5;
    this.now = options.now ?? Date.now;
  }

  /**
   * 写一行。**永不 reject**——日志失败拖垮应用是本末倒置，磁盘满、目录只读、路径非法
   * 都只能被吞掉。这也是调用方可以放心 `void log.write(...)` 的前提。
   */
  write(level: LogLevel, message: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const line = `${new Date(this.now()).toISOString()} ${level.toUpperCase()} ${redactForLog(message)}\n`;
    this.queue = this.queue.then(() => this.append(line)).catch(() => undefined);
    return this.queue;
  }

  /** 排空在途写入。关窗/退出路径调用，避免最后几行丢失 */
  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    this.closed = true;
  }

  private async append(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line);
    if (!this.currentPath) await this.openCurrent();
    const rotated = this.currentBytes + bytes > this.maxBytes;
    if (rotated) await this.rotate();
    await appendFile(this.currentPath!, line, "utf8");
    this.currentBytes += bytes;
    // 先落盘再清理：轮转时新文件尚未存在，此刻 prune 会把它算漏，结果永远多留一份。
    if (rotated) await this.prune();
  }

  private dayStamp(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** 接管当日已存在的文件（重启后续写，而不是覆盖——重启前后的现场同样重要） */
  private async openCurrent(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.currentPath = join(this.dir, `lightee-${this.dayStamp()}.log`);
    this.currentBytes = await stat(this.currentPath).then((s) => s.size).catch(() => 0);
  }

  private async rotate(): Promise<void> {
    // 轮转用「新开一个带序号的文件」而不是逐个改名：改名链在 Windows 上会被仍持有句柄的
    // 杀毒/同步软件挡下，而失败的轮转会让日志从此停止写入。
    let index = 1;
    let next = join(this.dir, `lightee-${this.dayStamp()}.${index}.log`);
    while (await stat(next).then(() => true).catch(() => false)) {
      index += 1;
      next = join(this.dir, `lightee-${this.dayStamp()}.${index}.log`);
    }
    this.currentPath = next;
    this.currentBytes = 0;
  }

  /**
   * 只保留最近 maxFiles 份，**按 mtime 排序**。
   *
   * 不能按文件名排：当天的第一个文件叫 `lightee-<date>.log`（无序号），字典序排在
   * `lightee-<date>.1.log` **之后**，于是最老的那份会被当成最新的而永远删不掉；
   * 序号本身也是字典序（`.10` < `.2`）。mtime 是这里唯一诚实的时间源。
   */
  private async prune(): Promise<void> {
    const names = (await readdir(this.dir).catch(() => [] as string[]))
      .filter((name) => name.startsWith("lightee-") && name.endsWith(".log"));
    const stamped = await Promise.all(names.map(async (name) => ({
      name,
      mtime: await stat(join(this.dir, name)).then((s) => s.mtimeMs).catch(() => 0),
    })));
    stamped.sort((a, b) => a.mtime - b.mtime);
    for (const { name } of stamped.slice(0, Math.max(0, stamped.length - this.maxFiles))) {
      await rm(join(this.dir, name), { force: true }).catch(() => undefined);
    }
  }
}
