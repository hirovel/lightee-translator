/**
 * 工作台上下文协调器：为异步效果发放 token，上下文变更后旧 token 一律作废。
 *
 * **M-9（已知冗余，刻意保留）**：`transition()` 让 `generation` 全局递增，因此
 * `accepts()` 对 workspace / chapter / tab 三种 `EffectScope` 的判定结果**完全相同**——
 * scope 参数目前不改变任何行为，只起文档作用（标注这个效果在概念上属于哪一层）。
 *
 * 不在 RH-12 修：真正分 scope 判定需要三条独立的代次线，而它的正确性取决于
 * 哪些面板由谁重建——那个归属要等 ui-shell-runtime 退役后才落定。决议记录见
 * `docs/design/renderer-dom-ownership.md` §5 Stage 3：届时**要么**实现真正的分 scope
 * 判定，**要么**删掉 `EffectScope` 简化 API，二选一，不要继续留着这个假接口。
 */
export type WorkbenchTab = "bi" | "terms" | "review" | "agent" | null;

export interface WorkbenchContext {
  generation: number;
  workspaceId: string | null;
  chapterId: string | null;
  tab: WorkbenchTab;
}

export type EffectScope = "workspace" | "chapter" | "tab";

export interface EffectToken extends WorkbenchContext {
  scope: EffectScope;
  lane?: string;
  laneGeneration?: number;
}

export class WorkbenchContextCoordinator {
  private value: WorkbenchContext = {
    generation: 0,
    workspaceId: null,
    chapterId: null,
    tab: null,
  };
  private readonly lanes = new Map<string, number>();
  private navigationGeneration = 0;

  current(): WorkbenchContext {
    return { ...this.value };
  }

  transition(next: Omit<WorkbenchContext, "generation">): WorkbenchContext {
    this.value = { ...next, generation: this.value.generation + 1 };
    return this.current();
  }

  beginNavigation(): number {
    this.navigationGeneration += 1;
    return this.navigationGeneration;
  }

  acceptsNavigation(token: number): boolean {
    return token === this.navigationGeneration;
  }

  capture(scope: EffectScope, lane?: string): EffectToken {
    if (!lane) return { ...this.value, scope };
    const laneGeneration = (this.lanes.get(lane) ?? 0) + 1;
    this.lanes.set(lane, laneGeneration);
    return { ...this.value, scope, lane, laneGeneration };
  }

  /**
   * 「这仍是本条泳道最新的一次渲染，而且还在同一个工作区」——**不问代次**。
   *
   * `accepts()` 里代次一变就作废（M-9：scope 参数不参与判定），于是章节导航会连带
   * 作废那些**与章节无关**的工作区级效果。侧栏术语表就栽在这里：挂载时它先发起查询，
   * 紧接着的「打开上次编辑的章节」推进了代次，查询回来时 token 已作废，函数在写入前
   * 就返回了——而真实应用里那块骨架是空的（设计稿的演示词条只在独立打开设计稿时出现），
   * 于是术语表永远是一片空白，还不报错。
   *
   * 工作区级效果真正需要守的只有两件事：别把 A 工作区的数据画进 B，别让慢的那次
   * 覆盖快的那次。这两条与代次无关。
   */
  acceptsLane(token: EffectToken): boolean {
    if (token.workspaceId !== this.value.workspaceId) return false;
    return !token.lane || this.lanes.get(token.lane) === token.laneGeneration;
  }

  accepts(token: EffectToken): boolean {
    if (token.generation !== this.value.generation || token.workspaceId !== this.value.workspaceId) return false;
    if (token.lane && this.lanes.get(token.lane) !== token.laneGeneration) return false;
    if (token.scope === "chapter" && token.chapterId !== this.value.chapterId) return false;
    if (token.scope === "tab" && (token.chapterId !== this.value.chapterId || token.tab !== this.value.tab)) return false;
    return true;
  }
}
