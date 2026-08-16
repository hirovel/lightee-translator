/**
 * 紧凑查找面板（替换 @codemirror/search 的默认面板）。
 *
 * 默认面板有三个问题，作者实测都撞上了：
 *  1. 通栏铺满、还占掉正文顶部的垂直空间——正在读的行被顶下去；
 *  2. 不报「一共找到几个」，只能一路 Enter 数；
 *  3. 外观是浅色系统控件，摆进暗色稿面像贴了一张纸。
 *
 * 这里自建面板：**浮在编辑区右上角**（绝对定位，不参与文档流，因此一行正文都不推），
 * 计数写在输入框右侧（`3/17` 形式），替换行按需展开。
 *
 * 计数用 `SearchQuery.getCursor` 逐个走一遍。单章文档量级（几十 KB）下这点开销可以忽略；
 * 超过 `MATCH_SCAN_LIMIT` 就停下并显示 `999+`——扫一份超长文档去凑一个精确数字，
 * 换来的是每次按键都卡一下。
 */
import { EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
  closeSearchPanel,
} from "@codemirror/search";

/** 计数上限：超过就报「999+」，不再继续扫 */
const MATCH_SCAN_LIMIT = 999;

/**
 * 当前落在第几个匹配上（1 起；没有命中返回 0）。
 *
 * 判据是「光标位置之后的第一个匹配」——与 findNext 的语义一致，
 * 否则计数会和按下一个之后跳到的位置对不上。
 */
export function pickCurrentIndex(matchStarts: readonly number[], head: number): number {
  for (let i = 0; i < matchStarts.length; i += 1) {
    if (matchStarts[i]! >= head) return i + 1;
  }
  // 光标在最后一个匹配之后 → findNext 会绕回第一个
  return matchStarts.length > 0 ? 1 : 0;
}

/** `3/17` / `无结果` / `` （空查询时不占位） */
export function formatMatchCount(total: number, index: number, capped: boolean): string {
  if (total === 0) return "无结果";
  const totalText = capped ? `${MATCH_SCAN_LIMIT}+` : String(total);
  return `${index}/${totalText}`;
}

function scanMatches(view: EditorView, query: SearchQuery): { total: number; index: number; capped: boolean } {
  if (!query.search || !query.valid) return { total: 0, index: 0, capped: false };
  const starts: number[] = [];
  let capped = false;
  try {
    const cursor = query.getCursor(view.state) as Iterator<{ from: number; to: number }>;
    for (;;) {
      const step = cursor.next();
      if (step.done) break;
      starts.push(step.value.from);
      if (starts.length >= MATCH_SCAN_LIMIT) { capped = true; break; }
    }
  } catch {
    // 正则写到一半是常态（比如刚敲下 `[`）。此时报 0，不让异常掀翻整个面板。
    return { total: 0, index: 0, capped: false };
  }
  return { total: starts.length, index: pickCurrentIndex(starts, view.state.selection.main.from), capped };
}

function button(label: string, title: string, className = ""): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `lt-search-btn ${className}`.trim();
  element.textContent = label;
  element.title = title;
  return element;
}

/** 供 `search({ createPanel })` 使用 */
export function compactSearchPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "lt-search";
  dom.setAttribute("role", "search");

  const row = document.createElement("div");
  row.className = "lt-search-row";
  const input = document.createElement("input");
  input.className = "lt-search-input";
  input.placeholder = "查找";
  input.setAttribute("aria-label", "查找");
  const count = document.createElement("span");
  count.className = "lt-search-count";
  const prev = button("↑", "上一个（Shift+Enter）");
  const next = button("↓", "下一个（Enter）");
  const toggleReplace = button("⇄", "显示 / 隐藏替换", "lt-search-toggle");
  const close = button("×", "关闭（Esc）", "lt-search-close");
  row.append(input, count, prev, next, toggleReplace, close);

  const replaceRow = document.createElement("div");
  replaceRow.className = "lt-search-row lt-search-replace";
  const replaceInput = document.createElement("input");
  replaceInput.className = "lt-search-input";
  replaceInput.placeholder = "替换为";
  replaceInput.setAttribute("aria-label", "替换为");
  const replaceOne = button("替换", "替换当前这一处");
  const replaceEvery = button("全部", "替换全部");
  replaceRow.append(replaceInput, replaceOne, replaceEvery);

  const options = document.createElement("div");
  options.className = "lt-search-opts";
  const optionBoxes = ([
    ["case", "Aa", "区分大小写"],
    ["word", "|词|", "全词匹配"],
    ["re", ".*", "正则表达式"],
  ] as const).map(([key, label, title]) => {
    const wrap = document.createElement("label");
    wrap.className = "lt-search-opt";
    wrap.title = title;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.opt = key;
    const text = document.createElement("span");
    text.textContent = label;
    wrap.append(box, text);
    options.append(wrap);
    return box;
  });
  const [caseBox, wordBox, regexpBox] = optionBoxes as [HTMLInputElement, HTMLInputElement, HTMLInputElement];

  dom.append(row, replaceRow, options);

  const commit = (): void => {
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({
        search: input.value,
        replace: replaceInput.value,
        caseSensitive: caseBox.checked,
        wholeWord: wordBox.checked,
        regexp: regexpBox.checked,
      })),
    });
  };

  input.addEventListener("input", commit);
  replaceInput.addEventListener("input", commit);
  for (const box of optionBoxes) box.addEventListener("change", () => { commit(); view.focus(); input.focus(); });

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) findPrevious(view); else findNext(view);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  };
  input.addEventListener("keydown", onKey);
  replaceInput.addEventListener("keydown", onKey);

  prev.addEventListener("click", () => { findPrevious(view); });
  next.addEventListener("click", () => { findNext(view); });
  replaceOne.addEventListener("click", () => { replaceNext(view); });
  replaceEvery.addEventListener("click", () => { replaceAll(view); });
  toggleReplace.addEventListener("click", () => {
    const open = dom.classList.toggle("lt-search-with-replace");
    toggleReplace.classList.toggle("on", open);
    if (open) replaceInput.focus();
  });
  close.addEventListener("click", () => { closeSearchPanel(view); view.focus(); });

  const paint = (): void => {
    const query = getSearchQuery(view.state);
    if (document.activeElement !== input) input.value = query.search;
    if (document.activeElement !== replaceInput) replaceInput.value = query.replace;
    caseBox.checked = query.caseSensitive;
    wordBox.checked = query.wholeWord;
    regexpBox.checked = query.regexp;
    const { total, index, capped } = scanMatches(view, query);
    count.textContent = query.search ? formatMatchCount(total, index, capped) : "";
    count.classList.toggle("empty", Boolean(query.search) && total === 0);
    // 计数变化时给一次极短的提示动画：数字跳动本身容易被忽略
    count.classList.remove("bump");
    void count.offsetWidth;
    if (query.search) count.classList.add("bump");
  };

  return {
    dom,
    top: true,
    mount() {
      paint();
      input.focus();
      input.select();
    },
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))) {
        paint();
      }
    },
  };
}
