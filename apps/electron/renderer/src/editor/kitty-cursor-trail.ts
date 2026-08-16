/**
 * Neovide 风格平滑光标：精确移植 Neovide 的 Corner 弹簧动画。
 *
 * 核心（来自 neovide src/renderer/animation_utils.rs + cursor_renderer/mod.rs）：
 * - 每个角独立持有 CriticallyDampedSpringAnimation（临界阻尼弹簧 / PD 控制器）
 * - 移动时按移动方向与角相对位置的「点积」排序四角：前缘角用 short length（快），
 *   后缘角用 long length（慢），产生轻微拉伸感（trail_size 控制）
 * - 短跳（≤2 字符，输入/逐字符移动）用 short_animation_length=0.04，长跳 0.15
 * - 弹簧解析解：position = (a + b·dt)·e^(-ω·dt)，ω=4/(ζ·len)，2% 容差收敛
 */
import { StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin, BlockType, type PluginValue, type ViewUpdate } from "@codemirror/view";

export type KittyCursorMode = "off" | "smooth";
export type CursorShape = "block" | "beam" | "underline";

export interface KittyCursorTrailOptions {
  mode?: KittyCursorMode;
  dwellMs?: number;
  fastDecaySeconds?: number;
  slowDecaySeconds?: number;
  horizontalThreshold?: number;
  verticalThreshold?: number;
  settlePixels?: number;
  animationLength?: number;
  shortAnimationLength?: number;
  trailSize?: number;
  blink?: boolean;
  blinkWaitMs?: number;
  blinkOnMs?: number;
  blinkOffMs?: number;
  shape?: CursorShape;
}

export interface CursorPoint {
  x: number;
  y: number;
}

export interface CursorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export const DEFAULT_KITTY_CURSOR_OPTIONS: Required<KittyCursorTrailOptions> = {
  mode: "smooth",
  dwellMs: 45,
  fastDecaySeconds: 0.08,
  slowDecaySeconds: 0.24,
  horizontalThreshold: 1,
  verticalThreshold: 0,
  settlePixels: 0.5,
  // Neovide 默认
  animationLength: 0.15,
  shortAnimationLength: 0.04,
  trailSize: 1.0,
  // 硬切闪烁（Neovide smooth_blink=false；默认关闭，可在设置开启）
  blink: false,
  blinkWaitMs: 700,
  blinkOnMs: 250,
  blinkOffMs: 400,
  shape: "block",
};

// ===== 保留导出（兼容既有测试）=====
export function approachCorner(current: number, target: number, deltaSeconds: number, decaySeconds: number): number {
  if (deltaSeconds <= 0 || current === target) return current;
  const decay = Math.max(0.001, decaySeconds);
  const step = Math.min(1, 1 - 2 ** (-10 * deltaSeconds / decay));
  return current + (target - current) * step;
}

export function rectCorners(rect: CursorRect): [CursorPoint, CursorPoint, CursorPoint, CursorPoint] {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];
}

export type CursorCorners = ReturnType<typeof rectCorners>;

export function cornersWithin(corners: readonly CursorPoint[], target: readonly CursorPoint[], threshold: number): boolean {
  return corners.every((corner, index) => {
    const destination = target[index]!;
    return Math.abs(corner.x - destination.x) <= threshold && Math.abs(corner.y - destination.y) <= threshold;
  });
}

export function movementNeedsTrail(
  from: CursorRect,
  to: CursorRect,
  characterWidth: number,
  horizontalThreshold: number,
  verticalThreshold: number,
  settlePixels = 0.5,
): boolean {
  const horizontalDistance = Math.abs(to.left - from.left);
  const verticalDistance = Math.abs(to.top - from.top);
  const horizontalLimit = Math.max(1, characterWidth) * Math.max(0, horizontalThreshold);
  const verticalLimit = Math.max(0, to.height, from.height) * Math.max(0, verticalThreshold);
  return horizontalDistance > horizontalLimit + settlePixels || verticalDistance > verticalLimit + settlePixels;
}

function cross(a: CursorPoint, b: CursorPoint, c: CursorPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function convexHull(points: readonly CursorPoint[]): CursorPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const unique: CursorPoint[] = [];
  for (const point of sorted) {
    const previous = unique.at(-1);
    if (!previous || previous.x !== point.x || previous.y !== point.y) unique.push(point);
  }
  if (unique.length <= 1) return unique;

  const lower: CursorPoint[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: CursorPoint[] = [];
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ===== Neovide 移植：平滑闪烁状态机（blink.rs）=====
// Waiting → On → Off 循环；On 周期 opacity 从 1 渐降到 0，Off 从 0 渐升到 1（平滑过渡）
type BlinkPhase = "Waiting" | "On" | "Off";

class BlinkStatus {
  private phase: BlinkPhase = "Waiting";
  private transitionAt = 0;
  private readonly waitMs: number;
  private readonly onMs: number;
  private readonly offMs: number;

  constructor(waitMs: number, onMs: number, offMs: number) {
    this.waitMs = waitMs;
    this.onMs = onMs;
    this.offMs = offMs;
    this.restart();
  }

  // 光标移动/输入后重置：先亮（Waiting 期不闪）再进入循环
  restart(): void {
    this.phase = "Waiting";
    this.transitionAt = performance.now() + this.waitMs;
  }

  private isStatic(): boolean {
    return this.onMs <= 0 || this.offMs <= 0;
  }

  private delay(phase: BlinkPhase): number {
    switch (phase) {
      case "Waiting": return this.waitMs;
      case "On": return this.onMs;
      case "Off": return this.offMs;
    }
  }

  // 推进状态机，返回当前 opacity（0.0 全透明 → 1.0 不透明）
  // Neovim 真实闪烁 = 硬切：On 全亮、Off 全隐（干脆清晰，非全程渐变）
  update(): number {
    if (this.isStatic()) return 1.0;
    const now = performance.now();
    if (this.transitionAt <= now) {
      this.phase = this.phase === "Waiting" ? "On" : this.phase === "On" ? "Off" : "On";
      this.transitionAt = now + this.delay(this.phase);
      if (this.transitionAt <= now) this.transitionAt = now + this.delay(this.phase);
    }
    return this.phase === "Off" ? 0.0 : 1.0;
  }
}

class SpringAnimation {
  position = 0;
  velocity = 0;

  update(dt: number, animationLength: number): boolean {
    if (animationLength <= dt) {
      this.reset();
      return false;
    }
    if (this.position === 0) return false;
    // 临界阻尼弹簧 / PD 控制器（Neovide 原文注释：GDC Math in Game Dev Summit）
    const zeta = 1;
    const omega = 4 / (zeta * animationLength);
    const a = this.position;
    const b = this.position * omega + this.velocity;
    const c = Math.exp(-omega * dt);
    this.position = (a + b * dt) * c;
    this.velocity = c * (-a * omega - b * dt * omega + b);
    if (Math.abs(this.position) < 0.01) {
      this.reset();
      return false;
    }
    return true;
  }

  reset(): void {
    this.position = 0;
    this.velocity = 0;
  }
}

// 四角相对光标的偏移（Neovide STANDARD_CORNERS，单位格坐标 [-0.5, 0.5]）
const STANDARD_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
];

interface Corner {
  // 当前渲染位置（相对 scroller 内容坐标）
  x: number;
  y: number;
  animX: SpringAnimation;
  animY: SpringAnimation;
  // 每个角的目标（相对光标 rect 的偏移量）
  destX: number;
  destY: number;
  animationLength: number;
}

interface CursorMeasurement {
  rect: CursorRect | null;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}

interface CursorLayer {
  root: SVGSVGElement;
  caret: SVGPathElement;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function createSvgElement<K extends keyof SVGElementTagNameMap>(document: Document, tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}


function measureCursor(view: EditorView): CursorMeasurement {
  const scrollRect = view.scrollDOM.getBoundingClientRect();
  const base = {
    rect: null,
    scrollWidth: view.scrollDOM.scrollWidth,
    scrollHeight: view.scrollDOM.scrollHeight,
    clientWidth: view.scrollDOM.clientWidth,
    clientHeight: view.scrollDOM.clientHeight,
  };
  const selection = view.state.selection.main;
  // 照搬 Neovide：光标在 insert mode 也始终显示；仅选区非空时回落原生
  if (!view.inView || !selection.empty) return base;

  const position = selection.head;
  // 行块：复合 block（含上方原文 widget）时取 Text 子 block → 行盒顶部/高度（非 widget 顶部）
  const rawBlock = view.lineBlockAt(position);
  const lineBlock = Array.isArray(rawBlock.type)
    ? rawBlock.type.find((child) => child.type === BlockType.Text) ?? rawBlock
    : rawBlock;
  const character = position < view.state.doc.length ? view.coordsForChar(position) : null;
  const characterWidth = character ? character.right - character.left : view.defaultCharacterWidth;
  const width = Math.max(1, characterWidth || view.defaultCharacterWidth);
  const caret = view.coordsAtPos(position, 1);
  if (!caret) return base;
  // 左 = 字符左缘（视口）转 scroller 内容坐标
  const left = (character?.left ?? caret.left) - scrollRect.left + view.scrollDOM.scrollLeft;
  const { top, height } = resolveCursorBox({
    blockTop: lineBlock.top,
    blockHeight: lineBlock.height,
    defaultLineHeight: view.defaultLineHeight,
    caretTop: caret.top - scrollRect.top + view.scrollDOM.scrollTop,
    caretBottom: caret.bottom - scrollRect.top + view.scrollDOM.scrollTop,
  });
  return {
    ...base,
    rect: { left, top, right: left + width, bottom: top + height, width, height },
  };
}

export interface CursorBoxInput {
  /** 行块（段落）顶，已是 scroller 内容坐标 */
  blockTop: number;
  /** 行块（段落）高——**整段**的高度，折行段落是多个视觉行之和 */
  blockHeight: number;
  /** 单个视觉行的高度 */
  defaultLineHeight: number;
  /** caret 矩形的上下缘，已转成 scroller 内容坐标 */
  caretTop: number;
  caretBottom: number;
}

/**
 * 光标方块的纵向几何。
 *
 * 修的是作者实测报回的「光标跨行显示」：原实现直接把 `lineBlock.height` 当光标高，
 * 而正文里一段常折成两三个视觉行，于是画出一个纵跨整段的大色块。
 *
 * 两条规则：
 * 1. 高度封顶在**一个视觉行**——段落只有一行时二者相等，退化为原行为；
 * 2. 顶部由 caret 所在视觉行的中线反推，折到第几行都落得准（`lineBlock.top` 永远
 *    是段首，第二行往后就偏了）。caret 高度退化（0 或负）时才回落段首。
 */
export function resolveCursorBox(input: CursorBoxInput): { top: number; height: number } {
  const blockHeight = input.blockHeight || input.defaultLineHeight;
  const lineHeight = input.defaultLineHeight || blockHeight;
  const height = Math.max(1, Math.min(blockHeight, lineHeight));
  const top = input.caretBottom > input.caretTop
    ? (input.caretTop + input.caretBottom) / 2 - height / 2
    : input.blockTop;
  return { top, height };
}

class NeovideCursor implements PluginValue {
  private readonly options: Required<KittyCursorTrailOptions>;
  private readonly view: EditorView;
  private readonly layer: CursorLayer;
  private readonly measureKey = {};
  private readonly document: Document;
  private readonly reducedMotionQuery: MediaQueryList | null;
  private readonly onReducedMotion = () => {
    this.reducedMotion = Boolean(this.reducedMotionQuery?.matches);
    this.resetAndMeasure();
  };
  private readonly onVisibility = () => {
    if (this.document.hidden) this.hide();
    else this.resetAndMeasure();
  };
  private readonly resizeObserver: ResizeObserver | null;
  private reducedMotion: boolean;
  private target: CursorRect | null = null;
  private corners: Corner[];
  private lastFrameTime = 0;
  private animationFrame: number | null = null;
  private blinkTimer: number | null = null;
  private readonly blinkStatus: BlinkStatus;
  private measureSerial = 0;
  // 初始：原生光标可见（需要被隐藏时加 class）
  private nativeCursorVisible = true;

  constructor(view: EditorView, options: KittyCursorTrailOptions) {
    this.view = view;
    this.options = { ...DEFAULT_KITTY_CURSOR_OPTIONS, ...options };
    this.document = view.scrollDOM.ownerDocument;
    this.layer = this.createLayer();
    this.reducedMotionQuery = this.document.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    this.reducedMotion = Boolean(this.reducedMotionQuery?.matches);
    this.reducedMotionQuery?.addEventListener("change", this.onReducedMotion);
    this.document.addEventListener("visibilitychange", this.onVisibility);
    this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.resetAndMeasure());
    this.resizeObserver?.observe(view.scrollDOM);
    this.corners = STANDARD_CORNERS.map(() => ({
      x: 0,
      y: 0,
      animX: new SpringAnimation(),
      animY: new SpringAnimation(),
      destX: 0,
      destY: 0,
      animationLength: this.options.animationLength,
    }));
    this.blinkStatus = new BlinkStatus(this.options.blinkWaitMs, this.options.blinkOnMs, this.options.blinkOffMs);
    this.setMode(this.options.mode);
    if (this.options.mode !== "off") this.hideNativeCursor();
    this.scheduleMeasure(true, false);
  }

  update(update: ViewUpdate): void {
    if (update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(clearTrailEffect)))) {
      this.cancelMotion();
      this.hide();
      this.scheduleMeasure(true, false);
      return;
    }
    const selection = update.state.selection.main;
    if (this.options.mode === "off") {
      this.restoreNativeCursor();
      this.hide();
      return;
    }
    // 仅选区非空时回退原生光标（Neovide：输入/IME 组合时光标始终显示）
    if (!selection.empty) {
      this.restoreNativeCursor();
      this.cancelMotion();
      this.hide();
      this.scheduleMeasure(true, false);
      return;
    }
    this.hideNativeCursor();

    const transactions = update.transactions;
    const composition = transactions.some((transaction) => transaction.isUserEvent("input.type.compose"));
    const textChange = update.docChanged || transactions.some((transaction) => (
      transaction.isUserEvent("input") ||
      transaction.isUserEvent("delete") ||
      transaction.isUserEvent("undo") ||
      transaction.isUserEvent("redo")
    ));
    if (composition || textChange) {
      // 输入文字 / IME 组合：光标保持显示，立即贴合（Neovide animate_in_insert_mode 语义）
      this.cancelMotion();
      this.scheduleMeasure(true, false);
      return;
    }
    if (update.focusChanged || update.viewportChanged || update.geometryChanged) {
      this.cancelMotion();
      this.scheduleMeasure(true, false);
      return;
    }
    if (update.selectionSet) {
      const explicitSelection = transactions.some((transaction) => transaction.isUserEvent("select"));
      this.scheduleMeasure(!explicitSelection, explicitSelection);
    }
  }

  destroy(): void {
    this.cancelMotion();
    this.resizeObserver?.disconnect();
    this.reducedMotionQuery?.removeEventListener("change", this.onReducedMotion);
    this.document.removeEventListener("visibilitychange", this.onVisibility);
    this.restoreNativeCursor();
    this.view.scrollDOM.classList.remove("lightee-kitty-scroll");
    this.layer.root.remove();
  }

  private createLayer(): CursorLayer {
    const root = createSvgElement(this.document, "svg");
    const caret = createSvgElement(this.document, "path");
    root.classList.add("lightee-kitty-cursor-layer");
    root.setAttribute("aria-hidden", "true");
    root.setAttribute("focusable", "false");
    root.dataset.kittyCursor = "true";
    caret.classList.add("lightee-kitty-cursor-caret");
    caret.dataset.kittyCursorCaret = "true";
    root.append(caret);
    this.view.scrollDOM.classList.add("lightee-kitty-scroll");
    this.view.scrollDOM.appendChild(root);
    return { root, caret };
  }

  private setMode(mode: KittyCursorMode): void {
    this.layer.root.dataset.mode = mode;
    if (mode === "off") {
      this.restoreNativeCursor();
      this.hide();
    }
  }

  private hideNativeCursor(): void {
    if (!this.nativeCursorVisible) return;
    this.nativeCursorVisible = false;
    this.view.scrollDOM.classList.add("lightee-hide-native-cursor");
  }

  private restoreNativeCursor(): void {
    if (this.nativeCursorVisible) return;
    this.nativeCursorVisible = true;
    this.view.scrollDOM.classList.remove("lightee-hide-native-cursor");
  }

  private scheduleMeasure(snap: boolean, animate: boolean): void {
    const serial = ++this.measureSerial;
    this.view.requestMeasure({
      key: this.measureKey,
      read: (view) => ({ serial, measurement: measureCursor(view) }),
      write: ({ serial: measuredSerial, measurement }: { serial: number; measurement: CursorMeasurement }) => {
        if (measuredSerial !== this.measureSerial) return;
        this.applyMeasurement(measurement, snap, animate);
      },
    });
  }

  private applyMeasurement(measurement: CursorMeasurement, snap: boolean, animate: boolean): void {
    this.layer.root.setAttribute("width", String(Math.max(measurement.scrollWidth, measurement.clientWidth, 1)));
    this.layer.root.setAttribute("height", String(Math.max(measurement.scrollHeight, measurement.clientHeight, 1)));
    if (this.options.mode === "off" || !measurement.rect) {
      this.hide();
      return;
    }
    this.hideNativeCursor();

    const previous = this.target;
    this.target = measurement.rect;
    const moved = previous
      && (Math.abs(previous.left - measurement.rect.left) > 0.01 || Math.abs(previous.top - measurement.rect.top) > 0.01);

    if (this.reducedMotion || !moved || snap) {
      this.snapToTarget();
      return;
    }
    if (!animate) {
      this.snapToTarget();
      return;
    }
    this.jump(measurement.rect, previous!);
  }

  // Neovide jump：按移动方向给四角分配 animation_length（前缘快、后缘慢）
  private jump(target: CursorRect, previous: CursorRect): void {
    this.stopAnimation();
    this.resetBlink();
    const jumpVec = {
      x: (target.left - previous.left) / Math.max(1, target.width),
      y: (target.top - previous.top) / Math.max(1, target.height),
    };
    const isShortJump = Math.abs(jumpVec.x) <= 2.001 && Math.abs(jumpVec.y) < 0.001;
    const longLength = this.options.animationLength;
    const shortLength = this.options.shortAnimationLength;
    const leading = longLength * Math.max(0, Math.min(1, 1 - this.options.trailSize));
    const trailing = longLength;

    // 计算每个角的「方向对齐」并排序（Neovide calculate_direction_alignment + rank）
    const travelDir = {
      x: target.left - previous.left,
      y: target.top - previous.top,
    };
    const travelLen = Math.hypot(travelDir.x, travelDir.y) || 1;
    travelDir.x /= travelLen;
    travelDir.y /= travelLen;

    const alignments = this.corners.map((corner, i) => {
      // 角相对光标中心的单位方向
      const relX = STANDARD_CORNERS[i][0];
      const relY = STANDARD_CORNERS[i][1];
      const relLen = Math.hypot(relX, relY) || 1;
      const dot = travelDir.x * (relX / relLen) + travelDir.y * (relY / relLen);
      return { corner, i, dot };
    });
    // 照搬 Neovide：sorted_by 升序（dot 最小 = 后缘 rank 0 → trailing 慢；dot 最大 = 前缘 rank 2,3 → leading 快）
    alignments.sort((a, b) => a.dot - b.dot);
    const ranks = new Array<number>(4);
    alignments.forEach((item, rank) => { ranks[item.i] = rank; });

    // 角绝对坐标：按光标形状（Neovide set_cursor_shape + DEFAULT_CELL_PERCENTAGE=1/8）
    const cornerDest = (i: number) => this.cornerDestination(target, i);
    for (let i = 0; i < 4; i++) {
      const corner = this.corners[i]!;
      const dest = cornerDest(i);
      corner.destX = dest.x;
      corner.destY = dest.y;
      const deltaX = dest.x - corner.x;
      const deltaY = dest.y - corner.y;
      corner.animX.position = deltaX;
      corner.animY.position = deltaY;
      corner.animationLength = isShortJump
        ? shortLength
        : (() => {
          const rank = ranks[i]!;
          if (rank >= 2) return leading;
          if (rank === 1) return (leading + trailing) / 2;
          return trailing;
        })();
    }
    this.lastFrameTime = 0;
    this.layer.root.dataset.animating = "true";
    this.renderCaret();
    this.requestAnimationFrame();
  }

  // 四角绝对坐标（按形状）：target 是格左上角
  // block 覆盖整格；beam 左缘窄条宽 1/8；underline 底缘细条高 1/8
  private cornerDestination(target: CursorRect, i: number): { x: number; y: number } {
    const cell = 1 / 8;
    switch (this.options.shape) {
      case "beam": {
        const right = target.left + target.width * cell;
        const left = target.left;
        return {
          x: i === 1 || i === 2 ? right : left,
          y: i === 0 || i === 1 ? target.top : target.bottom,
        };
      }
      case "underline": {
        const bottom = target.bottom;
        const top = target.bottom - target.height * cell;
        return {
          x: i === 1 || i === 2 ? target.right : target.left,
          y: i === 0 || i === 1 ? top : bottom,
        };
      }
      default: {
        return {
          x: i === 1 || i === 2 ? target.right : target.left,
          y: i === 0 || i === 1 ? target.top : target.bottom,
        };
      }
    }
  }

  private snapToTarget(): void {
    this.stopAnimation();
    this.resetBlink();
    if (!this.target) {
      this.hide();
      return;
    }
    for (let i = 0; i < 4; i++) {
      const corner = this.corners[i]!;
      const dest = this.cornerDestination(this.target, i);
      corner.x = dest.x;
      corner.y = dest.y;
      corner.animX.reset();
      corner.animY.reset();
    }
    this.layer.root.dataset.animating = "false";
    this.renderCaret();
  }

  private requestAnimationFrame(): void {
    if (this.animationFrame !== null) return;
    const win = this.document.defaultView;
    if (!win) return;
    this.animationFrame = win.requestAnimationFrame((time) => {
      this.animationFrame = null;
      this.animate(time);
    });
  }

  private animate(time: number): void {
    if (!this.target || this.options.mode === "off") return;
    const dt = this.lastFrameTime === 0 ? 1 / 60 : Math.min(0.1, Math.max(0, (time - this.lastFrameTime) / 1000));
    this.lastFrameTime = time;

    let animating = false;
    for (let i = 0; i < 4; i++) {
      const corner = this.corners[i]!;
      animating = corner.animX.update(dt, corner.animationLength) || animating;
      animating = corner.animY.update(dt, corner.animationLength) || animating;
      corner.x = corner.destX - corner.animX.position;
      corner.y = corner.destY - corner.animY.position;
    }
    this.renderCaret();
    if (!animating) {
      // 收敛：贴到目标，停止
      for (let i = 0; i < 4; i++) {
        const corner = this.corners[i]!;
        corner.x = corner.destX;
        corner.y = corner.destY;
      }
      this.layer.root.dataset.animating = "false";
      this.renderCaret();
      return;
    }
    this.requestAnimationFrame();
  }

  private renderCaret(): void {
    this.layer.root.style.display = "block";
    this.layer.root.dataset.visible = "true";
    const d = this.corners
      .map((corner, i) => `${i === 0 ? "M" : "L"} ${corner.x.toFixed(1)} ${corner.y.toFixed(1)}`)
      .join(" ") + " Z";
    this.layer.caret.setAttribute("d", d);
    // 启动闪烁循环（光标可见时持续，静止也闪）
    this.startBlinkLoop();
  }

  private applyBlinkOpacity(): void {
    if (!this.options.blink) return;
    const opacity = this.blinkStatus.update();
    this.layer.caret.style.opacity = opacity.toFixed(3);
  }

  private startBlinkLoop(): void {
    if (this.blinkTimer !== null || !this.options.blink) return;
    // 用 setInterval 驱动（rAF 在后台/无持续帧时可能被节流，blink 是低频状态机）
    const win = this.document.defaultView;
    if (!win) return;
    this.blinkTimer = win.setInterval(() => {
      if (!this.layer.root.dataset.visible || this.options.mode === "off") {
        this.stopBlinkLoop();
        return;
      }
      this.applyBlinkOpacity();
    }, 33);
  }

  private stopBlinkLoop(): void {
    if (this.blinkTimer !== null) {
      const win = this.document.defaultView;
      win?.clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    if (this.options.blink) this.layer.caret.style.opacity = "1";
  }

  private resetAndMeasure(): void {
    this.cancelMotion();
    this.scheduleMeasure(true, false);
  }

  private hide(): void {
    this.cancelMotion();
    this.stopBlinkLoop();
    this.layer.root.dataset.visible = "false";
    this.layer.root.dataset.animating = "false";
    this.layer.root.style.display = "none";
  }

  private stopAnimation(): void {
    if (this.animationFrame !== null) {
      const win = this.document.defaultView;
      win?.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  private cancelMotion(): void {
    this.stopAnimation();
  }

  // 移动 / 输入时重置闪烁（先亮一段时间再进入循环，避免移动中闪）
  private resetBlink(): void {
    if (this.options.blink) {
      this.blinkStatus.restart();
      this.layer.caret.style.opacity = "1";
    }
  }
}

const neovideCursorPlugin = ViewPlugin.define((view, options: KittyCursorTrailOptions) => new NeovideCursor(view, options));

const clearTrailEffect = StateEffect.define<void>();

export function kittyCursorTrail(options: KittyCursorTrailOptions = {}): ReturnType<typeof neovideCursorPlugin.of> {
  return neovideCursorPlugin.of(options);
}

export function clearCursorTrail(view: EditorView): void {
  view.dispatch({ effects: clearTrailEffect.of() });
}
