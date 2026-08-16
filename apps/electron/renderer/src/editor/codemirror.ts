import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface CodeMirrorProbe {
  state: EditorState;
  view: EditorView | null;
}

export function createCodeMirrorProbe(doc = ""): CodeMirrorProbe {
  return {
    state: EditorState.create({ doc }),
    view: null,
  };
}

export function mountCodeMirror(parent: HTMLElement, doc = ""): EditorView {
  return new EditorView({
    state: EditorState.create({ doc }),
    parent,
  });
}
