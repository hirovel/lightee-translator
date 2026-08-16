import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { closeSearchPanel, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { compactSearchPanel } from "./search-panel.js";
import { Annotation, Compartment, EditorState, Prec, RangeSetBuilder, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, keymap, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { ParagraphDocument, type Paragraph, type ParagraphOperation } from "./paragraph-document.js";
import { kittyCursorTrail, clearCursorTrail, type KittyCursorMode, type CursorShape } from "./kitty-cursor-trail.js";
import { focusModeExtension, setFocusTarget } from "./focus-mode.js";
import { smoothActiveLine } from "./smooth-active-line.js";
import { issueMarksField, setIssueMarks, revealParagraph, type IssueSeverity } from "./issue-marks.js";

export const paragraphOperation = Annotation.define<ParagraphOperation>();
export const paragraphDocumentEffect = StateEffect.define<ParagraphDocument>();

function paragraphBoundaryDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const isParagraphStart = lineNumber === 1 || (line.from >= 2 && state.doc.sliceString(line.from - 2, line.from) === "\n\n");
    if (isParagraphStart) {
      builder.add(line.from, line.from, Decoration.line({ class: "lightee-paragraph-start" }));
    }
  }
  return builder.finish();
}

const paragraphBoundaryField = StateField.define<DecorationSet>({
  create: paragraphBoundaryDecorations,
  update(decorations, transaction) {
    return transaction.docChanged ? paragraphBoundaryDecorations(transaction.state) : decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const paragraphDocumentField = StateField.define<ParagraphDocument>({
  create: (state) => ParagraphDocument.fromText(state.doc.toString()),
  update: (document, transaction) => {
    const replacement = transaction.effects.find((effect) => effect.is(paragraphDocumentEffect));
    if (replacement) return replacement.value;
    if (!transaction.docChanged) return document;
    const operation = transaction.annotation(paragraphOperation);
    return document.reconcile(transaction.newDoc.toString(), operation);
  },
});

/**
 * 原文块的实测排版参数。CodeMirror 只渲染视口内的内容，视口外的高度靠估算；
 * 估不准，滚动时新进入视口的块被实测后会把后面的内容顶上顶下——就是「正文上下抽动」。
 *
 * 这里在编辑器挂载后量一次真实的字宽与行高，之后所有估算都基于实测值。
 * 量不到时用一组保守缺省（18px 字号 / 1.9 行高 / 日文近似全角）。
 */
const sourceMetrics = { charWidth: 18, lineHeight: 34.2, hostWidth: 900 };

function measureSourceMetrics(host: HTMLElement): void {
  const sample = host.querySelector<HTMLElement>(".cm-source-context-widget");
  const content = host.querySelector<HTMLElement>(".cm-content");
  if (content) sourceMetrics.hostWidth = content.clientWidth || sourceMetrics.hostWidth;
  if (!sample || !sample.textContent) return;
  const style = window.getComputedStyle(sample);
  const fontSize = Number.parseFloat(style.fontSize);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(fontSize) && fontSize > 0) sourceMetrics.charWidth = fontSize;
  if (Number.isFinite(lineHeight) && lineHeight > 0) sourceMetrics.lineHeight = lineHeight;
}

class SourceContextWidget extends WidgetType {
  constructor(private readonly source: string, private readonly paragraphIndex: number) {
    super();
  }

  /**
   * 估算高度 = 换行行数 × 行高 + 上下内边距（首块无上内边距，见 CSS）。
   * 日文以全角为主，一个字符约占一个字号宽，据此推每行容纳的字符数。
   */
  get estimatedHeight(): number {
    const perLine = Math.max(1, Math.floor(sourceMetrics.hostWidth / sourceMetrics.charWidth));
    const lines = Math.max(1, Math.ceil(this.source.length / perLine));
    return lines * sourceMetrics.lineHeight + (this.paragraphIndex === 0 ? 4 : 26);
  }

  eq(other: SourceContextWidget): boolean {
    return other.source === this.source && other.paragraphIndex === this.paragraphIndex;
  }

  toDOM(): HTMLElement {
    const element = document.createElement("div");
    element.className = "cm-source-context-widget";
    // 用段落索引标记（与段落顺序一一对应），避免原始 id 与 CM 重建 id 错位
    element.dataset.paragraphIndex = String(this.paragraphIndex);
    element.setAttribute("aria-label", `日文原文 段落${this.paragraphIndex + 1}`);
    element.textContent = this.source;
    return element;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const sourceContextEffect = StateEffect.define<readonly Paragraph[]>();
const sourceContextVisibilityEffect = StateEffect.define<boolean>();

function sourceContextDecorations(state: EditorState, sources: readonly Paragraph[]): DecorationSet {
  const document = ParagraphDocument.fromText(state.doc.toString());
  const builder = new RangeSetBuilder<Decoration>();
  document.ranges().forEach((paragraph, index) => {
    const source = sources[index];
    if (!source?.text) return;
    builder.add(paragraph.start, paragraph.start, Decoration.widget({
      widget: new SourceContextWidget(source.text, index),
      block: true,
      side: -1,
    }));
  });
  return builder.finish();
}

export interface TermHighlight {
  source: string;
  target: string;
}

export type TermHighlightStyle = "highlight" | "underline" | "none";
export type SourceColorStyle = "dim" | "soft" | "faint";
export type ParagraphGapStyle = "tight" | "natural" | "loose";
export interface EditorVisualSettings {
  fontSize: number;
  sourceColor: SourceColorStyle;
  paragraphGap: ParagraphGapStyle;
  termHighlight: TermHighlightStyle;
  sourceLink: boolean;
  focusCenter: boolean;
}

export const DEFAULT_VISUAL_SETTINGS: EditorVisualSettings = {
  fontSize: 18,
  sourceColor: "faint",
  paragraphGap: "natural",
  termHighlight: "highlight",
  sourceLink: true,
  focusCenter: true,
};

const termHighlightEffect = StateEffect.define<readonly TermHighlight[]>();

export function termHighlightDecorations(state: EditorState, terms: readonly TermHighlight[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (terms.length === 0) return builder.finish();
  const text = state.doc.toString();
  // RangeSetBuilder 硬性要求按 from 升序 add。这里按「词」外层循环，
  // 第二个词的首次命中几乎必然位于第一个词的末次命中之前——乱序 add 直接 throw，
  // 而这个 throw 发生在 EditorState.create 里，曾把翻译完成后的整个编辑器炸成空壳。
  const ranges: Array<{ from: number; to: number }> = [];
  for (const term of terms) {
    if (!term.target) continue;
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(term.target, from);
      if (index < 0) break;
      ranges.push({ from: index, to: index + term.target.length });
      from = index + term.target.length;
    }
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const range of ranges) builder.add(range.from, range.to, Decoration.mark({ class: "lightee-term-hl" }));
  return builder.finish();
}

const termHighlightField = StateField.define<DecorationSet>({
  create: (state) => termHighlightDecorations(state, termHighlightFieldState),
  update(decorations, transaction) {
    const replacement = transaction.effects.find((effect) => effect.is(termHighlightEffect));
    if (replacement) {
      termHighlightFieldState = [...replacement.value];
      return termHighlightDecorations(transaction.state, termHighlightFieldState);
    }
    return transaction.docChanged ? termHighlightDecorations(transaction.state, termHighlightFieldState) : decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

let termHighlightFieldState: readonly TermHighlight[] = [];

export interface ParagraphEditorOptions {
  parent: HTMLElement;
  paragraphs: ParagraphDocument;
  source?: boolean;
  editable?: boolean;
  cursorMode?: KittyCursorMode;
  cursorShape?: CursorShape;
  cursorBlink?: boolean;
  focusMode?: boolean;
  fontSize?: number;
  showSources?: boolean;
  terms?: readonly TermHighlight[];
  visual?: Partial<EditorVisualSettings>;
  onChange?: (document: ParagraphDocument, transaction: Transaction) => void;
  onUpdate?: (view: EditorView, update: import("@codemirror/view").ViewUpdate) => void;
  onCommand?: (command: string, view: EditorView) => void;
}

export interface ParagraphEditor {
  view: EditorView;
  getDocument(): ParagraphDocument;
  setEditable(editable: boolean): void;
  setCursorMode(mode: KittyCursorMode): void;
  setCursorAppearance(appearance: { mode?: KittyCursorMode; blink?: boolean; shape?: CursorShape }): void;
  clearCursorTrail(): void;
  setFocus(enabled: boolean, paragraphId: string | null): void;
  setDocument(document: ParagraphDocument): void;
  setContextSources(paragraphs: readonly Paragraph[]): void;
  setTerms(terms: readonly TermHighlight[]): void;
  setShowSources(visible: boolean): void;
  setVisual(visual: Partial<EditorVisualSettings>): void;
  /** 审校问题就地标注（RV-05）：段落 id → 严重度。传空对象即清除。 */
  setIssueMarks(marks: Record<string, IssueSeverity>): void;
  /** 把某一段滚到视野中央并落光标（索引列表点击 → 正文定位）。 */
  revealParagraph(paragraphId: string): boolean;
  /** 光标此刻所在段的 id（会话记录用：「上次编辑」要能落回这一段）。 */
  currentParagraphId(): string | null;
  destroy(): void;
}

function editorTheme(source: boolean): Extension {
  return EditorView.theme({
    "&": {
      backgroundColor: "transparent",
      color: source ? "var(--dimmer)" : "var(--text)",
      fontFamily: source ? "var(--jp)" : "var(--cjk)",
      minHeight: "0",
    },
    ".cm-content": { padding: "0", caretColor: "var(--accent)", lineHeight: source ? "1.9" : "2", position: "relative", zIndex: "1" },
    ".cm-line": { padding: "0", overflowWrap: "anywhere" },
    ".cm-focused": { outline: "none" },
    ".cm-scroller": { overflow: "visible" },
    /*
     * 选区交给浏览器原生绘制（见下方 drawSelection 已撤）。
     *
     * CM 的 drawSelection 按**行盒**画矩形：正文行高 2，每段上方还挂着原文 widget，
     * 于是一次选择就是几块又高又参差、连原文一起涂满的色斑（作者原话：大面积不规则）。
     * 原生选区贴着字形走，不涂空白、不碰 widget，形状天然规整——这本来就是别处的观感。
     */
    "::selection": { backgroundColor: "color-mix(in srgb, var(--accent) 32%, transparent)" },
  });
}

function paragraphAtPosition(view: EditorView, position: number) {
  return view.state.field(paragraphDocumentField).paragraphAt(position);
}

function hostOf(view: EditorView): HTMLElement | null {
  return view.dom.closest<HTMLElement>("#chapter-editor-host") ?? view.dom.parentElement;
}

function splitParagraph(view: EditorView): boolean {
  if (view.composing) return false;
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const document = view.state.field(paragraphDocumentField);
  const paragraph = paragraphAtPosition(view, selection.from);
  const offset = selection.from - paragraph.start;
  const newParagraphId = `p${String(document.paragraphs.length + 1).padStart(4, "0")}`;
  view.dispatch({
    changes: { from: selection.from, insert: "\n\n" },
    selection: { anchor: selection.from + 2 },
    annotations: [
      paragraphOperation.of({ kind: "split", paragraphId: paragraph.id, offset, newParagraphId }),
      Transaction.userEvent.of("input.split-paragraph"),
    ],
  });
  return true;
}

function insertLineBreak(view: EditorView): boolean {
  if (view.composing) return false;
  view.dispatch({
    changes: { from: view.state.selection.main.from, to: view.state.selection.main.to, insert: "\n" },
    selection: { anchor: view.state.selection.main.from + 1 },
    annotations: Transaction.userEvent.of("input.line-break"),
  });
  return true;
}

function jumpParagraph(view: EditorView, delta: -1 | 1): boolean {
  if (view.composing) return false;
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const document = view.state.field(paragraphDocumentField);
  const paragraph = paragraphAtPosition(view, selection.from);
  const target = document.paragraphs[paragraph.index + delta];
  if (!target) return false;
  const targetRange = document.paragraphById(target.id);
  if (!targetRange) return false;
  const offset = Math.min(selection.from - paragraph.start, target.text.length);
  view.dispatch({
    selection: { anchor: targetRange.start + offset },
    annotations: Transaction.userEvent.of("select.paragraph"),
  });
  return true;
}

function moveParagraph(view: EditorView, delta: -1 | 1): boolean {
  if (view.composing) return false;
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const document = view.state.field(paragraphDocumentField);
  const paragraph = paragraphAtPosition(view, selection.from);
  const nextDocument = document.move(paragraph.index, delta);
  if (nextDocument === document) return false;
  const moved = nextDocument.paragraphById(paragraph.id);
  if (!moved) return false;
  const offset = Math.min(selection.from - paragraph.start, moved.text.length);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: nextDocument.text },
    selection: { anchor: moved.start + offset },
    annotations: [
      paragraphOperation.of({ kind: "move", paragraphId: paragraph.id, toIndex: moved.index }),
      Transaction.userEvent.of("move.paragraph"),
    ],
  });
  return true;
}

function mergeParagraph(view: EditorView): boolean {
  if (view.composing) return false;
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const document = view.state.field(paragraphDocumentField);
  const paragraph = paragraphAtPosition(view, selection.from);
  if (paragraph.index === 0 || selection.from !== paragraph.start) return false;
  const previous = document.paragraphs[paragraph.index - 1]!;
  view.dispatch({
    changes: { from: paragraph.start - 2, to: paragraph.start },
    selection: { anchor: paragraph.start - 2 },
    annotations: [
      paragraphOperation.of({ kind: "merge", previousParagraphId: previous.id, mergedParagraphId: paragraph.id }),
      Transaction.userEvent.of("delete.merge-paragraph"),
    ],
  });
  return true;
}

export function paragraphEditor(options: ParagraphEditorOptions): ParagraphEditor {
  let editable = options.editable ?? !options.source;
  const cursorAppearance: { mode: KittyCursorMode; shape: CursorShape; blink: boolean } = {
    mode: options.cursorMode ?? "smooth",
    shape: options.cursorShape ?? "block",
    blink: options.cursorBlink ?? true,
  };
  let contextSources: Paragraph[] = [];
  let showSources = options.showSources ?? true;
  let terms = [...(options.terms ?? [])];
  const visual: EditorVisualSettings = { ...DEFAULT_VISUAL_SETTINGS, ...options.visual };
  const visualFontSize = visual.fontSize;
  const editableCompartment = new Compartment();
  const cursorCompartment = new Compartment();
  const fontSizeCompartment = new Compartment();
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) options.onChange?.(update.state.field(paragraphDocumentField), update.transactions[0]!);
    options.onUpdate?.(update.view, update);
  });
  // 光标联动（可开关）：
  //  #2 sourceLink — 当前段上方原文 widget 微亮（标记正在校对的段落）
  //  #5 focusCenter — 打字机聚焦：光标行滚动到视口中央
  // 本编辑器实例是否已经完成过一次「落位」。挂载后的第一次居中不做动画。
  let settledOnce = false;
  function handleCursorFollow(view: EditorView): void {
    if (!visual.sourceLink && !visual.focusCenter) return;
    const head = view.state.selection.main.head;
    const document = view.state.field(paragraphDocumentField);
    const paragraph = document.paragraphAt(head);
    // 调试：记录当前段落 index
    const hostDbg = hostOf(view);
    if (hostDbg) hostDbg.dataset.debugIndex = String(paragraph.index);
    if (visual.sourceLink) {
      // 等 DOM 更新后给当前段 widget 加微亮 class（rAF 而非 requestMeasure——
      // selectionSet 无 doc change 时 CM 不触发 measure）
      const paragraphIndex = paragraph.index;
      requestAnimationFrame(() => {
        const widgets = view.dom.querySelectorAll<HTMLElement>(".cm-source-context-widget[data-paragraph-index]");
        widgets.forEach((widget) => widget.classList.toggle("linked", widget.dataset.paragraphIndex === String(paragraphIndex)));
      });
    }
    if (visual.focusCenter) {
      const host = hostOf(view);
      if (host) {
        const block = view.lineBlockAt(head);
        const target = Math.max(0, block.top - (host.clientHeight - block.height) / 2);
        if (Math.abs(host.scrollTop - target) > 4) {
          // 落位那一次不能是动画。打字时平滑跟随是对的——视线已经在正文里，
          // 滚动是对光标移动的回应；但**刚打开章节**时视线还没落下来，
          // 一段从顶部滑到中间的动画会被读成「界面自己在动」。
          // 第一次直接就位，之后才平滑。
          host.scrollTo({ top: target, behavior: settledOnce ? "smooth" : "auto" });
          settledOnce = true;
        }
      }
    }
  }
  const cursorFollowListener = EditorView.updateListener.of((update) => {
    if (update.selectionSet || update.docChanged) handleCursorFollow(update.view);
  });
  const sourceContextField = StateField.define<DecorationSet>({
    create: (state) => (state.field(sourceContextVisibilityField, false) ? sourceContextDecorations(state, contextSources) : Decoration.none),
    update(decorations, transaction) {
      const replacement = transaction.effects.find((effect) => effect.is(sourceContextEffect));
      const visibility = transaction.state.field(sourceContextVisibilityField, false);
      const previousVisibility = transaction.startState.field(sourceContextVisibilityField, false);
      if (replacement) {
        contextSources = [...replacement.value];
        return visibility ? sourceContextDecorations(transaction.state, contextSources) : Decoration.none;
      }
      if (!visibility) return Decoration.none;
      // visibility 从隐藏恢复（或文档变化）时重新生成原文 widget
      if (!previousVisibility || transaction.docChanged) return sourceContextDecorations(transaction.state, contextSources);
      return decorations.map(transaction.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  // 原文 widget 显隐：通过 showSources 标志决定 decorations 是否生成
  const sourceContextVisibilityField = StateField.define<boolean>({
    create: () => showSources,
    update(value, transaction) {
      const flag = transaction.effects.find((effect) => effect.is(sourceContextVisibilityEffect));
      if (flag) { showSources = flag.value; return flag.value; }
      return value;
    },
  });
  const extensions: Extension[] = [
    history(),
    paragraphBoundaryField,
    issueMarksField,
    sourceContextField,
    sourceContextVisibilityField,
    termHighlightField,
    options.focusMode === false ? [] : focusModeExtension(),
    // drawSelection 已撤（2026-08-13）：它画的是行盒矩形，在「行高 2 + 原文 widget」的
    // 版式下会把整段涂成一块。原生选区贴字形走，形状规整得多。
    // 代价是多光标的额外光标不再绘制——本编辑器没有多光标入口，不构成损失。
    // 光标仍由 kitty 层自绘；原生 caret 由 .lightee-hide-native-cursor 关掉（见 renderer.css）。
    smoothActiveLine(),
    editorTheme(Boolean(options.source)),
    updateListener,
    cursorFollowListener,
    editableCompartment.of(EditorView.editable.of(editable)),
    cursorCompartment.of(kittyCursorTrail({
      mode: options.cursorMode ?? "smooth",
      shape: options.cursorShape ?? "block",
      blink: options.cursorBlink ?? true,
    })),
    fontSizeCompartment.of(EditorView.theme({ "&": { fontSize: `${visualFontSize}px` } })),
    EditorView.lineWrapping,
    Prec.highest(keymap.of([
      { key: "Mod-Enter", run: splitParagraph },
      { key: "Mod-ArrowUp", run: (view) => jumpParagraph(view, -1) },
      { key: "Mod-ArrowDown", run: (view) => jumpParagraph(view, 1) },
      { key: "Alt-ArrowUp", run: (view) => moveParagraph(view, -1) },
      { key: "Alt-ArrowDown", run: (view) => moveParagraph(view, 1) },
      { key: "Mod-s", run: (view) => { options.onCommand?.("save", view); return true; } },
      // 查找 / 替换（@codemirror/search）。两个键都开同一块面板：CM6 的搜索面板在
      // 可编辑状态下自带替换行，「查找」和「替换」本来就是一件事的两半。
      // 放在 Prec.highest 里是为了压过 searchKeymap 之外的一切默认绑定。
      { key: "Mod-f", run: openSearchPanel },
      { key: "Mod-h", run: openSearchPanel },
      // Escape 先关搜索面板，关不掉才交给上层（退出专注模式等）。
      // 不这么排的话，面板一开就再也 Esc 不掉——这条 keymap 的优先级高于 searchKeymap。
      { key: "Escape", run: (view) => closeSearchPanel(view) || (options.onCommand?.("escape", view), true) },
      { key: "Enter", run: insertLineBreak },
      { key: "Backspace", run: mergeParagraph },
    ])),
    // 自建紧凑面板（见 search-panel.ts）：浮在编辑区右上角，不占文档流、不推正文，
    // 自带匹配计数。CM6 默认面板通栏铺开又不报数量，实测下来正好是最碍事的两点。
    search({ top: true, createPanel: compactSearchPanel }),
    keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
  ];
  const createState = (document: ParagraphDocument) => EditorState.create({
    doc: document.text,
    extensions: [paragraphDocumentField.init(() => document), ...extensions],
  });
  const view = new EditorView({ state: createState(options.paragraphs), parent: options.parent });
  // 挂载后量一次真实排版参数，供视口外原文块的高度估算使用。
  // 估算准了，滚动时新块进入视口就不会把后面的内容顶得上下抽动。
  requestAnimationFrame(() => measureSourceMetrics(options.parent));
  // 初始视觉设置：写 host data 属性（字号已在 fontSizeCompartment 初始化）
  const host = options.parent;
  host.dataset.sourceColor = visual.sourceColor;
  host.dataset.gap = visual.paragraphGap;
  host.dataset.termHighlight = visual.termHighlight;
  host.dataset.sourceLink = String(visual.sourceLink);
  host.dataset.focusCenter = String(visual.focusCenter);
  handleCursorFollow(view);

  return {
    view,
    getDocument: () => view.state.field(paragraphDocumentField),
    setEditable(nextEditable) {
      editable = nextEditable;
      view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(editable)) });
    },
    setCursorMode(mode) {
      cursorAppearance.mode = mode;
      view.dispatch({ effects: cursorCompartment.reconfigure(kittyCursorTrail({ mode })) });
    },
    setCursorAppearance(appearance) {
      if (appearance.mode !== undefined) cursorAppearance.mode = appearance.mode;
      if (appearance.shape !== undefined) cursorAppearance.shape = appearance.shape;
      if (appearance.blink !== undefined) cursorAppearance.blink = appearance.blink;
      view.dispatch({ effects: cursorCompartment.reconfigure(kittyCursorTrail({
        mode: cursorAppearance.mode,
        shape: cursorAppearance.shape,
        blink: cursorAppearance.blink,
      })) });
    },
    setFocus(enabled, paragraphId) {
      setFocusTarget(view, enabled, paragraphId);
    },
    clearCursorTrail() {
      clearCursorTrail(view);
    },
    setDocument(document) {
      // Loading a chapter is a new editing session: reset its history without replacing the view.
      view.setState(createState(document));
    },
    setContextSources(paragraphs) {
      contextSources = paragraphs.map((paragraph) => ({ ...paragraph }));
      view.dispatch({ effects: sourceContextEffect.of(contextSources) });
    },
    setTerms(nextTerms) {
      terms = [...nextTerms];
      termHighlightFieldState = terms;
      view.dispatch({ effects: termHighlightEffect.of(terms) });
    },
    setShowSources(visible) {
      showSources = visible;
      view.dispatch({ effects: sourceContextVisibilityEffect.of(visible) });
    },
    setVisual(next) {
      Object.assign(visual, next);
      // 字号：动态换 theme
      view.dispatch({ effects: fontSizeCompartment.reconfigure(EditorView.theme({ "&": { fontSize: `${visual.fontSize}px` } })) });
      // 其余视觉设置：写到 host data 属性，由 CSS 变量驱动
      const host = view.dom.closest<HTMLElement>("#chapter-editor-host") ?? view.dom.parentElement;
      if (host) {
        host.dataset.sourceColor = visual.sourceColor;
        host.dataset.gap = visual.paragraphGap;
        host.dataset.termHighlight = visual.termHighlight;
              host.dataset.sourceLink = String(visual.sourceLink);
        host.dataset.focusCenter = String(visual.focusCenter);
      }
      // sourceLink 关闭时清除已加亮的原文 widget
      if (!visual.sourceLink) {
        view.dom.querySelectorAll<HTMLElement>(".cm-source-context-widget.linked").forEach((widget) => widget.classList.remove("linked"));
      }
      handleCursorFollow(view);
    },
    setIssueMarks(marks) {
      setIssueMarks(view, marks);
    },
    revealParagraph(paragraphId) {
      return revealParagraph(view, paragraphId);
    },
    currentParagraphId() {
      const doc = view.state.field(paragraphDocumentField, false);
      if (!doc || doc.paragraphs.length === 0) return null;
      return doc.paragraphAt(view.state.selection.main.head).id;
    },
    destroy() {
      view.destroy();
    },
  };
}

export { jumpParagraph, moveParagraph, paragraphBoundaryField, undo, redo };
