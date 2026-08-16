/**
 * 平滑当前行高亮：自定义色块跟随光标行滑动（整体移动，非淡入淡出）。
 *
 * 定位：lineBlockAt(head) + BlockType 过滤——当光标行上方有原文 widget（block widget）时，
 * CM 返回复合 block（type 为 BlockInfo[]），从中取 Text 子 block，精确跳过原文行。
 * 纯逻辑定位不依赖 DOM，输入/换行（wrap）时 CM 自动更新 state，永远准确。
 *
 * 色块挂到 .cm-scroller（与 .cm-content 同坐标系）：block.top 相对内容顶部直接对齐；
 * host 滚动时 scroller 随内容移动，色块自动跟随。
 */
import { EditorView, ViewPlugin, BlockType, type ViewUpdate } from "@codemirror/view";

const SMOOTH_MS = 140;

function hostOf(view: EditorView): HTMLElement | null {
  return view.dom.closest<HTMLElement>("#chapter-editor-host") ?? view.dom.parentElement;
}

export function smoothActiveLine(): import("@codemirror/state").Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly dom: HTMLElement;
      private readonly host: HTMLElement;
      private view: EditorView;
      private restoreTimer: number | undefined;

      constructor(view: EditorView) {
        this.view = view;
        this.host = hostOf(view) ?? view.dom;
        this.dom = document.createElement("div");
        this.dom.className = "lightee-smooth-active-line";
        view.scrollDOM.appendChild(this.dom);
        this.host.addEventListener("scroll", this.onScroll);
        this.position(false);
      }

      private readonly onScroll = (): void => {
        // 滚动：立即跟随（禁用过渡，避免拖尾闪烁），随后恢复
        window.clearTimeout(this.restoreTimer);
        this.dom.style.transition = "none";
        this.position(false);
        this.restoreTimer = window.setTimeout(() => { this.dom.style.transition = ""; }, 60);
      };

      private position(smooth: boolean): void {
        const selection = this.view.state.selection.main;
        // 选区非空（拖选/多选）时不高亮当前行
        if (!selection.empty) {
          this.dom.style.display = "none";
          return;
        }
        const block = this.view.lineBlockAt(selection.head);
        // 复合 block（上方有原文 widget）时取其中的文本子 block，跳过原文行
        const target = Array.isArray(block.type)
          ? block.type.find((child) => child.type === BlockType.Text) ?? block
          : block;
        this.dom.style.display = "block";
        this.dom.style.transition = smooth
          ? `transform ${SMOOTH_MS}ms cubic-bezier(.22,.61,.36,1), height ${SMOOTH_MS}ms cubic-bezier(.22,.61,.36,1)`
          : "none";
        // block.top 相对内容顶部；色块挂 scroller（与 content 同源）→ 直接对齐，滚动自动跟随
        this.dom.style.transform = `translateY(${target.top}px)`;
        this.dom.style.height = `${target.height}px`;
      }

      update(update: ViewUpdate) {
        this.view = update.view;
        if (update.selectionSet || update.docChanged) {
          // 光标/文档变化：平滑过渡
          this.position(true);
        } else if (update.geometryChanged || update.viewportChanged) {
          // 纯滚动/尺寸变化：立即跟随
          this.position(false);
        }
      }

      destroy() {
        window.clearTimeout(this.restoreTimer);
        this.host.removeEventListener("scroll", this.onScroll);
        this.dom.remove();
      }
    },
  );
}
