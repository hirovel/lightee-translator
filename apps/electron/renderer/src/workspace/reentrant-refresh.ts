/**
 * 会自己惊动自己的刷新，怎么不把主线程吃掉。
 *
 * 导出面板挂在一个 `MutationObserver(document.body, {subtree:true})` 上：面板刷新时
 * 写 DOM，写 DOM 又惊动观察者，观察者再调刷新——一条环。从前靠「每一处写入都先比一次
 * 旧值」把环掐断，那是一条要求后来每一次改动都记得遵守的纪律；漏一处（挑选章节的计数
 * 就漏了）界面当场卡死，而且卡死的样子跟死循环的位置一点关系都没有，很难查。
 *
 * 这里把断环从纪律变成结构：刷新期间来的触发只记一笔「脏了」，等这一轮跑完再补一次，
 * 而且补的那次排到下一轮宏任务——同步补跑等于把刚掐断的环重新接上。
 *
 * 纯逻辑、不碰 DOM：renderer 的 vitest 环境是 node，能单测的部分必须和 DOM 读写分开。
 */

export interface ReentrantRefreshOptions {
  /** 排下一轮的方式。生产用 setTimeout(fn, 0)，测试里换成手动泵。 */
  schedule?: (fn: () => void) => void;
  /** 每轮刷新前的闸门，返回 false 表示这次不用跑（例如面板根本没挂上）。 */
  shouldRun?: () => boolean;
}

/**
 * 返回一个可以随便调的触发器：并发触发会被折叠成「当前这轮 + 至多一轮补跑」。
 * run 抛错不会把触发器卡在 refreshing 状态——那会让面板从此不再刷新，
 * 比多跑一轮糟得多。
 */
export function createReentrantRefresh(
  run: () => Promise<void> | void,
  options: ReentrantRefreshOptions = {},
): () => void {
  const schedule = options.schedule ?? ((fn) => { setTimeout(fn, 0); });
  let running = false;
  let dirty = false;

  const trigger = (): void => {
    if (options.shouldRun && !options.shouldRun()) return;
    if (running) { dirty = true; return; }
    running = true;
    let outcome: Promise<void> | void;
    try {
      outcome = run();
    } catch {
      outcome = undefined;
    }
    const settle = (): void => {
      running = false;
      if (!dirty) return;
      dirty = false;
      schedule(trigger);
    };
    if (outcome && typeof (outcome as Promise<void>).then === "function") {
      void (outcome as Promise<void>).then(settle, settle);
    } else {
      settle();
    }
  };

  return trigger;
}
